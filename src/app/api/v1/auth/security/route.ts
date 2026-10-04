import { and, eq, isNull } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users, refreshTokens } from "@/db/schema";
import { getAuthContext, verifyPassword } from "@/lib/auth";
import { ok, parseJsonWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { decryptMfa, digestIdentity, encryptMfa, matchingTotpStep, newMfaSecret, newRecoveryCodes } from "@/lib/mfa";
import { withApiHandling } from "@/lib/server-core";
import { enforceRateLimit } from "@/lib/rate-limit";
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    const { user } = await getAuthContext(req);
    return ok({ mfaEnabled: user.mfaEnabled, emailVerified: Boolean(user.emailVerifiedAt), recoveryCodesRemaining: user.mfaRecoveryHashes.length });
  });
}
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await enforceRateLimit(req, "login");
    const auth = await getAuthContext(req);
    const body = await parseJsonWith(req, z.object({ action: z.enum(["setup", "confirm", "disable"]), password: z.string().min(1).max(128), code: z.string().max(100).optional() }));
    return db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(and(eq(users.id, auth.userId), eq(users.businessId, auth.businessId))).for("update").limit(1);
      if (!user || !(await verifyPassword(body.password, user.passwordHash))) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
      if (body.action === "setup") {
        if (user.mfaEnabled) throw new AppError(409, "CONFLICT", "MFA already enabled");
        const secret = newMfaSecret();
        await tx.update(users).set({ mfaSecret: encryptMfa(secret, user.id), mfaLastStep: -1 }).where(eq(users.id, user.id));
        return ok({ secret, otpauthUrl: `otpauth://totp/${encodeURIComponent(`AI Receptionist:${user.email}`)}?secret=${secret}&issuer=AI%20Receptionist&algorithm=SHA1&digits=6&period=30` });
      }
      if (!user.mfaSecret || !body.code) throw new AppError(400, "BAD_REQUEST", "Configure and verify the authenticator first");
      const step = matchingTotpStep(decryptMfa(user.mfaSecret, user.id), body.code, user.mfaLastStep);
      const recoveryValid = body.action === "disable" && user.mfaRecoveryHashes.includes(digestIdentity(body.code));
      if (step === null && !recoveryValid) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid or reused code");
      if (body.action === "confirm" && user.mfaEnabled) throw new AppError(409, "CONFLICT", "MFA already enabled");
      const enabled = body.action === "confirm";
      const codes = enabled ? newRecoveryCodes() : [];
      await tx.update(users).set({ credentialVersion: user.credentialVersion + 1, mfaEnabled: enabled, mfaSecret: enabled ? user.mfaSecret : null,
        mfaLastStep: step ?? user.mfaLastStep, mfaRecoveryHashes: codes.map(digestIdentity) }).where(eq(users.id, user.id));
      await tx.update(refreshTokens).set({ revokedAt: new Date(), revokedReason: "mfa_changed" }).where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));
      return ok({ mfaEnabled: enabled, recoveryCodes: codes, signInRequired: true });
    });
  });
}
