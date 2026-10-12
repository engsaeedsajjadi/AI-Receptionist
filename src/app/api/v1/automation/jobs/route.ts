import { and, desc, eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { automationJobs } from "@/db/schema";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { ok, parseJsonWith, AppError } from "@/lib/api";
import { withApiHandling, checkGlobalPublicRateLimit } from "@/lib/server-core";
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req); const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new AppError(403, "FORBIDDEN", "Insufficient permissions");
    const jobs = await db.select({ id: automationJobs.id, event: automationJobs.event, status: automationJobs.status,
      attempts: automationJobs.attempts, availableAt: automationJobs.availableAt, createdAt: automationJobs.createdAt }).from(automationJobs)
      .where(eq(automationJobs.businessId, auth.businessId)).orderBy(desc(automationJobs.createdAt)).limit(100);
    return ok({ jobs });
  });
}
export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req); const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new AppError(403, "FORBIDDEN", "Insufficient permissions");
    const { id } = await parseJsonWith(req, z.object({ id: z.string().uuid() }));
    const rows = await db.update(automationJobs).set({ status: "pending", attempts: 0, availableAt: new Date(), lastError: null })
      .where(and(eq(automationJobs.id, id), eq(automationJobs.businessId, auth.businessId), inArray(automationJobs.status, ["dead"]))).returning({ id: automationJobs.id });
    if (!rows.length) throw new AppError(404, "NOT_FOUND", "Dead-letter job not found");
    return ok({ ok: true });
  });
}
