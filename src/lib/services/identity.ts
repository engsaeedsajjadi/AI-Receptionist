import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { identityTokens, refreshTokens, users } from "@/db/schema";
import { hashPassword, validatePasswordPolicy } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { EmailNotificationProvider } from "@/lib/providers/notifications";
import { decryptMfa, digestIdentity, matchingTotpStep } from "@/lib/mfa";

type Purpose = "password_reset" | "email_verify";
export async function sendIdentityLink(email: string, purpose: Purpose, authenticatedUserId?: string): Promise<void> {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS)
    throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "Email delivery is not configured");
  const [user] = await db.select().from(users).where(and(eq(users.email, email.toLowerCase().trim()), eq(users.isActive, true))).limit(1);
  if (!user || (purpose === "email_verify" && user.id !== authenticatedUserId)) return;
  const token = randomBytes(32).toString("base64url");
  const [row] = await db.insert(identityTokens).values({ businessId: user.businessId, userId: user.id, purpose,
    tokenHash: digestIdentity(token), expiresAt: new Date(Date.now() + 30 * 60_000) }).returning();
  const url = new URL("/account/recovery", process.env.APP_URL ?? "http://localhost:3000");
  url.hash = new URLSearchParams({ token, purpose }).toString(); // Avoid tokens in server/referrer URLs.
  const result = await new EmailNotificationProvider().send({ to: user.email, businessId: user.businessId,
    subject: purpose === "password_reset" ? "بازیابی گذرواژه" : "تأیید ایمیل", body: `این پیوند تا ۳۰ دقیقه معتبر است:\n${url}` });
  if (!result.ok) {
    await db.delete(identityTokens).where(eq(identityTokens.id, row.id));
    throw new AppError(503, "DEPENDENCY_UNAVAILABLE", "Email delivery failed");
  }
}
export async function consumeIdentityLink(token: string, purpose: Purpose, password?: string): Promise<void> {
  if (purpose === "password_reset") validatePasswordPolicy(password ?? "");
  const passwordHash = purpose === "password_reset" ? await hashPassword(password!) : undefined;
  await db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(identityTokens).where(eq(identityTokens.tokenHash, digestIdentity(token))).limit(1);
    if (!candidate) throw new AppError(400, "BAD_REQUEST", "Invalid or expired link");
    const [user] = await tx.select().from(users).where(and(eq(users.id, candidate.userId), eq(users.businessId, candidate.businessId))).for("update").limit(1);
    const [row] = await tx.select().from(identityTokens).where(eq(identityTokens.id, candidate.id)).for("update").limit(1);
    if (!user?.isActive || row.purpose !== purpose || row.consumedAt || row.expiresAt <= new Date())
      throw new AppError(400, "BAD_REQUEST", "Invalid or expired link");
    await tx.update(identityTokens).set({ consumedAt: new Date() }).where(and(eq(identityTokens.userId, user.id), eq(identityTokens.purpose, purpose), isNull(identityTokens.consumedAt)));
    await tx.update(users).set(purpose === "password_reset" ? { passwordHash, credentialVersion: user.credentialVersion + 1, failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() } : { emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
    if (purpose === "password_reset") await tx.update(refreshTokens).set({ revokedAt: new Date(), revokedReason: "password_reset" }).where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));
  });
}
export async function verifyMfaLogin(userId: string, code?: string): Promise<void> {
  const valid = await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update").limit(1);
    if (!user?.isActive) return false;
    if (!user.mfaEnabled) return true;
    if (!code || !user.mfaSecret) return false;
    const recoveryHash = digestIdentity(code);
    if (user.mfaRecoveryHashes.includes(recoveryHash)) {
      await tx.update(users).set({ mfaRecoveryHashes: user.mfaRecoveryHashes.filter((h) => h !== recoveryHash) }).where(eq(users.id, user.id));
      return true;
    }
    const step = matchingTotpStep(decryptMfa(user.mfaSecret, user.id), code, user.mfaLastStep);
    if (step === null) return false;
    await tx.update(users).set({ mfaLastStep: step }).where(eq(users.id, user.id));
    return true;
  });
  if (!valid) throw new AppError(401, "INVALID_CREDENTIALS", "Valid authenticator or recovery code required");
}
