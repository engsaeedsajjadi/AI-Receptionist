import { SignJWT, jwtVerify } from "jose";
import { compare, hash } from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { refreshTokens, users } from "@/db/schema";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/api";
import type { UserRole } from "@/lib/permissions";

type AuthJwt = {
  sub: string;
  businessId: string;
  role: UserRole;
  type: "access" | "refresh";
  jti: string;
};

const secret = new TextEncoder().encode(env.jwtSecret);

export async function hashPassword(password: string) {
  return hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return compare(password, passwordHash);
}

async function signToken(payload: AuthJwt, expiresIn: string) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setJti(payload.jti)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

export async function issueAuthTokens(input: { userId: string; businessId: string; role: UserRole }) {
  const accessJti = crypto.randomUUID();
  const refreshJti = crypto.randomUUID();

  const accessToken = await signToken(
    { sub: input.userId, businessId: input.businessId, role: input.role, type: "access", jti: accessJti },
    `${env.jwtAccessExpireMinutes}m`,
  );
  const refreshToken = await signToken(
    { sub: input.userId, businessId: input.businessId, role: input.role, type: "refresh", jti: refreshJti },
    `${env.jwtRefreshExpireDays}d`,
  );

  await db.insert(refreshTokens).values({
    userId: input.userId,
    businessId: input.businessId,
    tokenHash: await hash(refreshToken, 10),
    expiresAt: new Date(Date.now() + env.jwtRefreshExpireDays * 24 * 60 * 60 * 1000),
  });

  return { accessToken, refreshToken };
}

export async function verifyToken(token: string) {
  const { payload } = await jwtVerify(token, secret);
  return payload as unknown as AuthJwt;
}

export async function getAuthContext(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new ApiError(401, "UNAUTHORIZED", "Missing bearer token");
  }

  const token = authHeader.slice("Bearer ".length);
  let payload: AuthJwt;
  try {
    payload = await verifyToken(token);
  } catch {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid token");
  }

  if (payload.type !== "access") {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid token type");
  }

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, payload.sub), eq(users.businessId, payload.businessId), eq(users.isActive, true)))
    .limit(1);

  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "User not found or inactive");
  }

  return {
    userId: user.id,
    businessId: user.businessId,
    role: user.role,
    user,
  };
}

export async function rotateRefreshToken(refreshToken: string) {
  let payload: AuthJwt;
  try {
    payload = await verifyToken(refreshToken);
  } catch {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid refresh token");
  }

  if (payload.type !== "refresh") {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid token type");
  }

  const tokens = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, payload.sub), eq(refreshTokens.businessId, payload.businessId), isNull(refreshTokens.revokedAt)));

  let matched = false;
  for (const t of tokens) {
    if (await compare(refreshToken, t.tokenHash)) {
      matched = true;
      await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, t.id));
      break;
    }
  }

  if (!matched) {
    throw new ApiError(401, "UNAUTHORIZED", "Refresh token revoked");
  }

  const [user] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!user) {
    throw new ApiError(401, "UNAUTHORIZED", "User not found");
  }

  return issueAuthTokens({ userId: user.id, businessId: user.businessId, role: user.role });
}

export async function revokeRefreshToken(refreshToken: string) {
  const tokens = await db.select().from(refreshTokens).where(isNull(refreshTokens.revokedAt));

  for (const t of tokens) {
    if (await compare(refreshToken, t.tokenHash)) {
      await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, t.id));
      return true;
    }
  }

  return false;
}
