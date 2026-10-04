import { requireTenantFeature, type TenantFeatures } from "@/lib/tenant-config";
import { bindTenantContext } from "@/lib/request-context";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { compare } from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { businesses, refreshTokens, users } from "@/db/schema";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { logWarn } from "@/lib/logger";
import { USER_ROLES, hasPermission, permissionForRequest, type UserRole } from "@/lib/permissions";

type AuthJwt = {
  sub: string;
  businessId: string;
  role: UserRole;
  type: "access" | "refresh";
  jti: string;
  sid?: string;
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

export { hashPassword, verifyPassword } from "@/lib/passwords";

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
  return new SignJWT({ businessId: payload.businessId, role: payload.role, type: payload.type, sid: payload.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setJti(payload.jti)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

type AuthTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type TokenInput = { userId: string; businessId: string; role: UserRole; credentialVersion?: number; userAgent?: string; rotatedFromId?: string };

export function tokenDigest(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

async function tokenMatches(token: string, stored: string): Promise<boolean> {
  if (!stored.startsWith("sha256:")) return compare(token, stored); // Legacy migration after JWT verification.
  const actual = Buffer.from(tokenDigest(token));
  const expected = Buffer.from(stored);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function insertTokens(tx: AuthTx, input: TokenInput) {
  const refreshJti = crypto.randomUUID();
  const accessToken = await signToken(
    { sub: input.userId, businessId: input.businessId, role: input.role, type: "access", jti: crypto.randomUUID(), sid: refreshJti },
    `${env.jwtAccessExpireMinutes}m`, accessSecret(),
  );
  const refreshToken = await signToken(
    { sub: input.userId, businessId: input.businessId, role: input.role, type: "refresh", jti: refreshJti },
    `${env.jwtRefreshExpireDays}d`, refreshSecret(),
  );
  await tx.insert(refreshTokens).values({
    userId: input.userId, businessId: input.businessId, jti: refreshJti,
    tokenHash: tokenDigest(refreshToken), userAgent: input.userAgent?.slice(0, 512),
    rotatedFromId: input.rotatedFromId,
    expiresAt: new Date(Date.now() + env.jwtRefreshExpireDays * 86400000),
  });
  return { accessToken, refreshToken };
}

async function lockedUser(tx: AuthTx, userId: string, businessId?: string) {
  const [user] = await tx.select().from(users).where(and(eq(users.id, userId),
    businessId ? eq(users.businessId, businessId) : undefined)).for("update").limit(1);
  if (!user || !user.isActive) throw new AppError(401, "UNAUTHORIZED", "User not found or inactive");
  const [business] = await tx.select({ id: businesses.id }).from(businesses)
    .where(and(eq(businesses.id, user.businessId), eq(businesses.isActive, true))).limit(1);
  if (!business) throw new AppError(403, "FORBIDDEN", "Business is inactive");
  return user;
}

export async function issueAuthTokens(input: TokenInput) {
  return db.transaction(async (tx) => {
    const user = await lockedUser(tx, input.userId, input.businessId);
    if (input.credentialVersion !== undefined && user.credentialVersion !== input.credentialVersion)
      throw new AppError(401, "UNAUTHORIZED", "Credentials changed; please sign in again");
    return insertTokens(tx, { ...input, role: user.role as UserRole });
  });
}

const tokenSchema = z.object({
  sub: z.string().uuid(), businessId: z.string().uuid(), role: z.enum(USER_ROLES),
  type: z.enum(["access", "refresh"]), jti: z.string().uuid(), sid: z.string().uuid().optional(),
});

export async function verifyAccessToken(token: string): Promise<AuthJwt> {
  const { payload } = await jwtVerify(token, accessSecret(), { algorithms: ["HS256"] });
  const parsed = tokenSchema.parse(payload);
  if (parsed.type !== "access") throw new AppError(401, "UNAUTHORIZED", "Invalid token type");
  return parsed;
}

export async function verifyRefreshToken(token: string): Promise<AuthJwt> {
  const { payload } = await jwtVerify(token, refreshSecret(), { algorithms: ["HS256"] });
  const parsed = tokenSchema.parse(payload);
  if (parsed.type !== "refresh") throw new AppError(401, "UNAUTHORIZED", "Invalid token type");
  return parsed;
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

  const [business] = await db.select({ id: businesses.id }).from(businesses)
    .where(and(eq(businesses.id, user.businessId), eq(businesses.isActive, true))).limit(1);
  if (!business) throw new AppError(403, "FORBIDDEN", "Business is inactive");
  const requestedTenant = req.headers.get("x-tenant-id");
  if (requestedTenant && requestedTenant !== user.businessId)
    throw new AppError(403, "FORBIDDEN", "Tenant context mismatch");
  if (!payload.sid) throw new AppError(401, "TOKEN_REVOKED", "Please sign in again");
  const [session] = await db.select().from(refreshTokens).where(and(
    eq(refreshTokens.jti, payload.sid), eq(refreshTokens.userId, user.id),
    eq(refreshTokens.businessId, user.businessId), isNull(refreshTokens.revokedAt),
  )).limit(1);
  if (!session || session.expiresAt <= new Date()) throw new AppError(401, "TOKEN_REVOKED", "Session revoked");

  const required = permissionForRequest(req.nextUrl.pathname, req.method);
  if (required && !hasPermission(user.role as UserRole, required))
    throw new AppError(403, "FORBIDDEN", "Insufficient permissions");
  bindTenantContext(user.businessId, user.id);
  const section = req.nextUrl.pathname.split("/")[3];
  const featureMap: Record<string, keyof TenantFeatures> = { agents: "agent", agent: "agent", knowledge: "knowledge", customers: "crm", leads: "crm", appointments: "crm", properties: "crm", automation: "automation" };
  if (featureMap[section]) await requireTenantFeature(user.businessId, featureMap[section]);
  return {
    userId: user.id,
    businessId: user.businessId,
    role: user.role as UserRole,
    user,
  };
}

/**
 * Assert a user exists AND belongs to the given business (IDOR guard for
 * assignee/owner references). Throws 404 USER_NOT_FOUND otherwise — never
 * leaks whether the id exists in another tenant.
 */
export async function assertUserInBusiness(businessId: string, userId: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.businessId, businessId)))
    .limit(1);
  if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found");
  return user;
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
  void currentCount; // Do not trust a count observed before a concurrent request.
  const [updated] = await db.update(users).set({
    failedLoginCount: sql`${users.failedLoginCount} + 1`,
    lockedUntil: sql`CASE WHEN ${users.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS}
      THEN now() + (${LOCKOUT_MINUTES} * interval '1 minute') ELSE ${users.lockedUntil} END`,
    updatedAt: new Date(),
  }).where(eq(users.id, userId)).returning({ failedLoginCount: users.failedLoginCount });
  if (updated && updated.failedLoginCount >= MAX_FAILED_LOGINS)
    logWarn("Account locked after failed logins", { userId, operation: "auth.lockout" });
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

async function revokeUserTokens(tx: AuthTx, userId: string, reason: string) {
  return tx.update(refreshTokens).set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .returning({ id: refreshTokens.id });
}

export async function rotateRefreshToken(refreshToken: string) {
  let payload: AuthJwt;
  try { payload = await verifyRefreshToken(refreshToken); }
  catch { throw new AppError(401, "UNAUTHORIZED", "Invalid refresh token"); }
  // User lock serializes rotation, login and logout-all. Reuse revocation must
  // COMMIT before throwing, otherwise the transaction would undo it.
  const outcome = await db.transaction(async (tx) => {
    const user = await lockedUser(tx, payload.sub, payload.businessId);
    const [stored] = await tx.select().from(refreshTokens).where(and(
      eq(refreshTokens.jti, payload.jti), eq(refreshTokens.userId, user.id),
      eq(refreshTokens.businessId, user.businessId),
    )).limit(1);
    if (!stored || !(await tokenMatches(refreshToken, stored.tokenHash)))
      throw new AppError(401, "TOKEN_REVOKED", "Refresh token revoked");
    if (stored.revokedAt) {
      await revokeUserTokens(tx, user.id, "reuse_detected");
      return { reuse: true as const };
    }
    if (stored.expiresAt <= new Date()) throw new AppError(401, "UNAUTHORIZED", "Refresh token expired");
    await tx.update(refreshTokens).set({ revokedAt: new Date(), revokedReason: "rotated" })
      .where(eq(refreshTokens.id, stored.id));
    const tokens = await insertTokens(tx, { userId: user.id, businessId: user.businessId,
      role: user.role as UserRole, userAgent: stored.userAgent ?? undefined, rotatedFromId: stored.id });
    return { reuse: false as const, tokens };
  });
  if (outcome.reuse) {
    logWarn("Refresh reuse revoked all sessions", { businessId: payload.businessId, userId: payload.sub });
    throw new AppError(401, "TOKEN_REUSE_DETECTED", "Refresh token reuse detected");
  }
  return outcome.tokens;
}

export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  let payload: AuthJwt;
  try { payload = await verifyRefreshToken(refreshToken); } catch { return false; }
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, payload.sub)).for("update");
    const [stored] = await tx.select().from(refreshTokens).where(and(
      eq(refreshTokens.jti, payload.jti), eq(refreshTokens.userId, payload.sub),
      eq(refreshTokens.businessId, payload.businessId), isNull(refreshTokens.revokedAt),
    )).limit(1);
    if (!stored || !(await tokenMatches(refreshToken, stored.tokenHash))) return false;
    await tx.update(refreshTokens).set({ revokedAt: new Date(), revokedReason: "logout" }).where(eq(refreshTokens.id, stored.id));
    return true;
  });
}

export async function revokeAllSessions(userId: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    return (await revokeUserTokens(tx, userId, "logout_all")).length;
  });
}

export async function pruneExpiredRefreshTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 86400000);
  return (await db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, cutoff)).returning({ id: refreshTokens.id })).length;
}
