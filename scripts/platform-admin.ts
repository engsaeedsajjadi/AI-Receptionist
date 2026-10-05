import "dotenv/config";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { closeDb, db } from "../src/db";
import { auditLogs, businesses, refreshTokens, users } from "../src/db/schema";
// Infrastructure operator command; never exposed as a tenant API.
async function main() {
  const id = z.string().uuid().parse(process.argv[2]);
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, id)).for("update");
    if (!user || !user.isActive || !user.mfaEnabled || !user.emailVerifiedAt) throw new Error("User must be active, email verified, and enrolled in MFA before promotion");
    const [tenant] = await tx.select().from(businesses).where(eq(businesses.id, user.businessId));
    if (!tenant?.isActive) throw new Error("Platform tenant must be active");
    if (user.role === "SUPER_ADMIN") return;
    await tx.update(users).set({ role: "SUPER_ADMIN", credentialVersion: sql`${users.credentialVersion} + 1`, updatedAt: new Date() }).where(eq(users.id, id));
    await tx.update(refreshTokens).set({ revokedAt: new Date(), revokedReason: "platform_promotion" }).where(and(eq(refreshTokens.userId, id), isNull(refreshTokens.revokedAt)));
    await tx.insert(auditLogs).values({ businessId: user.businessId, actorType: "infrastructure_operator", action: "platform.admin_promoted", entityType: "user", entityId: id, metadata: { previousRole: user.role } });
  });
  console.log("Platform administrator configured. Sign in again with MFA.");
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Promotion failed"); process.exitCode = 1; }).finally(closeDb);
