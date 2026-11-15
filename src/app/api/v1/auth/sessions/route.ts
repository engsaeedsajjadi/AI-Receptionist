import { and, desc, eq, isNull, gt } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { refreshTokens, users } from "@/db/schema";
import { getAuthContext } from "@/lib/auth";
import { ok, parseJsonWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { withApiHandling, checkGlobalPublicRateLimit } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const sessions = await db.select({ id: refreshTokens.id, userAgent: refreshTokens.userAgent,
      createdAt: refreshTokens.createdAt, expiresAt: refreshTokens.expiresAt }).from(refreshTokens)
      .where(and(eq(refreshTokens.userId, auth.userId), eq(refreshTokens.businessId, auth.businessId),
        isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())))
      .orderBy(desc(refreshTokens.createdAt)).limit(100);
    return ok({ sessions });
  });
}

export async function DELETE(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { sessionId } = await parseJsonWith(req, z.object({ sessionId: z.string().uuid() }));
    await db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, auth.userId)).for("update");
      const [session] = await tx.select().from(refreshTokens).where(and(eq(refreshTokens.id, sessionId),
        eq(refreshTokens.userId, auth.userId), eq(refreshTokens.businessId, auth.businessId))).limit(1);
      if (!session) throw new AppError(404, "NOT_FOUND", "Session not found");
      // Follow rotation lineage while holding the same user lock as rotation.
      // A device revoked just after refresh must not leave its successor alive.
      let current = session;
      for (;;) {
        await tx.update(refreshTokens).set({ revokedAt: new Date(), revokedReason: "device_logout" })
          .where(eq(refreshTokens.id, current.id));
        const [next] = await tx.select().from(refreshTokens).where(and(
          eq(refreshTokens.rotatedFromId, current.id), eq(refreshTokens.userId, auth.userId),
          eq(refreshTokens.businessId, auth.businessId))).limit(1);
        if (!next) break;
        current = next;
      }
    });
    return ok({ ok: true });
  });
}
