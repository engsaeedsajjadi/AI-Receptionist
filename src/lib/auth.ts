import { compare, hash } from "bcryptjs";
import { decodeJwt, jwtVerify, SignJWT } from "jose";
import { and, eq, isNull, lt } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { refreshTokens, users } from "@/db/schema";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { logWarn } from "@/lib/logger";
import type { UserRole } from "@/lib/permissions";

type AuthJwt = {
  sub: string;
  businessId: string;
  role: UserRole;
  type: "access" | "refresh";
  jti: string;
};

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MINUTES = 15;

export const REFRESH_COOKIE_NAME = "ar_refresh";

/** HttpOnly refresh-token cookie for browser clients (never localStorage). */
export function buildRefreshCookie(token: string): string {
  const maxAge = env.jwtRefreshExpireDays * 24 * 60 * 60;
  const parts = [
    `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function clearRefreshCookie(): string {
  const parts = [`${REFRESH_COOKIE_NAME}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function getCookieValue(req: NextRequest, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * CSRF guard for cookie-authenticated mutations: require a same-origin
 * Origin/Referer. API clients using Bearer tokens are unaffected.
 */
export function assertSameOrigin(req: NextRequest): void {
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const host = req.headers.get("host") ?? req.headers.get("x-forwarded-host");
  if (!origin && !referer) {
    // Non-browser clients don't send Origin; only enforce when a cookie is present.
    if (req.headers.get("cookie")?.includes(REFRESH_COOKIE_NAME)) {
      throw new AppError(403, "FORBIDDEN", "Missing origin for cookie-authenticated request");
    }
    return;
  }
  const candidate = origin ?? referer ?? "";
  try {
    const url = new URL(candidate);
    if (host && url.host === host) return;
    const appUrl = process.env.APP_URL;
    if (appUrl && url.origin === new URL(appUrl).origin) return;
  } catch {
    // fall through to error
  }
  throw new AppError(403, "FORBIDDEN", "Cross-origin request forbidden");
}

function accessSecret(): Uint8Array {
  return new TextEncoder().encode(env.jwtSecret);
}

function refreshSecret(): Uint8Array {
  return new TextEncoder().encode(env.jwtRefreshSecret);
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export async function hashPassword(password: string) {
  return hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string) {
  return compare(password, passwordHash);
}

/**
 * Password policy: 8–128 chars, must include at least one letter and one
 * digit. Throws 400 VALIDATION_ERROR otherwise.
 */
export function validatePasswordPolicy(password: string): void {
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new AppError(400, "VALIDATION_ERROR", "Password must be between 8 and 128 characters");
  }
  if (!/[A-Za-z\u0600-\u06FF]/.test(password) || !/\d/.test(password)) {
    throw new AppError(400, "VALIDATION_ERROR", "Password must include at least one letter and one digit");
  }
}

// ---------------------------------------------------------------------------
// Token issuance / verification
// ---------------------------------------------------------------------------

async function signToken(payload: AuthJwt, expiresIn: string, secret: Uint8Array) {
  return new SignJWT({ businessId: payload.businessId, role: payload.role, type: payload.type })
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
    accessSecret(),
  );
  const refreshToken = await signToken(
    { sub: input.userId, businessId: input.businessId, role: input.role, type: "refresh", jti: refreshJti },
    `${env.jwtRefreshExpireDays}d`,
    refreshSecret(),
  );

  await db.insert(refreshTokens).values({
    userId: input.userId,
    businessId: input.businessId,
    jti: refreshJti,
    tokenHash: await hash(refreshToken, 10),
    expiresAt: new Date(Date.now() + env.jwtRefreshExpireDays * 24 * 60 * 60 * 1000),
  });

  return { accessToken, refreshToken };
}

export async function verifyAccessToken(token: string): Promise<AuthJwt> {
  const { payload } = await jwtVerify(token, accessSecret());
  return payload as unknown as AuthJwt;
}

export async function verifyRefreshToken(token: string): Promise<AuthJwt> {
  const { payload } = await jwtVerify(token, refreshSecret());
  return payload as unknown as AuthJwt;
}

/** Backwards-compatible alias (access tokens). */
export const verifyToken = verifyAccessToken;

export async function getAuthContext(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new AppError(401, "UNAUTHORIZED", "Missing bearer token");
  }

  const token = authHeader.slice("Bearer ".length);
  let payload: AuthJwt;
  try {
    payload = await verifyAccessToken(token);
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Invalid token");
  }

  if (payload.type !== "access") {
    throw new AppError(401, "UNAUTHORIZED", "Invalid token type");
  }

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, payload.sub), eq(users.businessId, payload.businessId), eq(users.isActive, true)))
    .limit(1);

  if (!user) {
    throw new AppError(401, "UNAUTHORIZED", "User not found or inactive");
  }

  return {
    userId: user.id,
    businessId: user.businessId,
    role: user.role as UserRole,
    user,
  };
}

// ---------------------------------------------------------------------------
// Login attempts / lockout
// ---------------------------------------------------------------------------

export async function assertNotLockedOut(user: { failedLoginCount: number; lockedUntil: Date | null }) {
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const retryAfter = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
    throw new AppError(429, "RATE_LIMITED", "Account temporarily locked due to failed logins", {
      retryAfterSeconds: retryAfter,
    });
  }
}

export async function recordFailedLogin(userId: string, currentCount: number): Promise<void> {
  const next = currentCount + 1;
  await db
    .update(users)
    .set({
      failedLoginCount: next,
      lockedUntil: next >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : undefined,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
  if (next >= MAX_FAILED_LOGINS) {
    logWarn("Account locked after failed logins", { userId, operation: "auth.lockout" });
  }
}

export async function recordSuccessfulLogin(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// Refresh rotation with reuse detection
// ---------------------------------------------------------------------------

async function revokeAllUserTokens(userId: string, reason: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

async function findTokenByJti(jti: string) {
  const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.jti, jti)).limit(1);
  return row ?? null;
}

async function legacyMatchToken(userId: string, businessId: string, refreshToken: string) {
  // Back-compat for tokens issued before jti column existed.
  const candidates = await db
    .select()
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.userId, userId),
        eq(refreshTokens.businessId, businessId),
        isNull(refreshTokens.revokedAt),
      ),
    );
  for (const t of candidates) {
    if (t.jti) continue;
    if (await compare(refreshToken, t.tokenHash)) return t;
  }
  return null;
}

export async function rotateRefreshToken(refreshToken: string) {
  let payload: AuthJwt;
  try {
    payload = await verifyRefreshToken(refreshToken);
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Invalid refresh token");
  }

  if (payload.type !== "refresh") {
    throw new AppError(401, "UNAUTHORIZED", "Invalid token type");
  }

  const stored = payload.jti ? await findTokenByJti(payload.jti) : null;

  if (stored) {
    if (stored.revokedAt) {
      // Reuse of a rotated/revoked token → possible theft: revoke the family.
      await revokeAllUserTokens(payload.sub, "reuse_detected");
      logWarn("Refresh token reuse detected; revoked all sessions", {
        userId: payload.sub,
        businessId: payload.businessId,
        operation: "auth.refresh_reuse",
      });
      throw new AppError(401, "TOKEN_REUSE_DETECTED", "Refresh token reuse detected");
    }
    if (stored.expiresAt <= new Date()) {
      throw new AppError(401, "UNAUTHORIZED", "Refresh token expired");
    }
    if (!(await compare(refreshToken, stored.tokenHash))) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid refresh token");
    }

    const [user] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
    if (!user || !user.isActive) {
      throw new AppError(401, "UNAUTHORIZED", "User not found or inactive");
    }

    const tokens = await issueAuthTokens({ userId: user.id, businessId: user.businessId, role: user.role as UserRole });

    // Mark rotation AFTER issuing the replacement so a crash doesn't strand the user.
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: "rotated" })
      .where(eq(refreshTokens.id, stored.id));

    // Opportunistic cleanup of long-expired tokens (best effort).
    void pruneExpiredRefreshTokens().catch(() => undefined);

    return tokens;
  }

  // Legacy fallback (pre-jti tokens).
  const legacy = await legacyMatchToken(payload.sub, payload.businessId, refreshToken);
  if (!legacy) {
    throw new AppError(401, "TOKEN_REVOKED", "Refresh token revoked");
  }
  const [user] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!user || !user.isActive) throw new AppError(401, "UNAUTHORIZED", "User not found or inactive");
  const tokens = await issueAuthTokens({ userId: user.id, businessId: user.businessId, role: user.role as UserRole });
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: "rotated" })
    .where(eq(refreshTokens.id, legacy.id));
  return tokens;
}

export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  let decoded: { sub?: string; jti?: string } | null = null;
  try {
    decoded = decodeJwt(refreshToken) as { sub?: string; jti?: string };
  } catch {
    return false;
  }
  if (decoded?.jti) {
    const stored = await findTokenByJti(decoded.jti);
    if (stored && !stored.revokedAt) {
      if (await compare(refreshToken, stored.tokenHash)) {
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date(), revokedReason: "logout" })
          .where(eq(refreshTokens.id, stored.id));
        return true;
      }
    }
    return false;
  }
  // Fallback: match within the decoded user's tokens only (never full-table scan).
  if (decoded?.sub) {
    const candidates = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, decoded.sub), isNull(refreshTokens.revokedAt)));
    for (const t of candidates) {
      if (await compare(refreshToken, t.tokenHash)) {
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date(), revokedReason: "logout" })
          .where(eq(refreshTokens.id, t.id));
        return true;
      }
    }
  }
  return false;
}

/** Logout from all sessions (revokes every active refresh token for the user). */
export async function revokeAllSessions(userId: string): Promise<number> {
  const rows = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: "logout_all" })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
  return rows.length;
}

/** Delete tokens expired more than 7 days ago. Safe for cron. */
export async function pruneExpiredRefreshTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .delete(refreshTokens)
    .where(lt(refreshTokens.expiresAt, cutoff))
    .returning({ id: refreshTokens.id });
  return rows.length;
}
