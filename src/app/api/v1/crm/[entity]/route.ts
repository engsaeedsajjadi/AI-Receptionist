import { and, desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { crmOpportunities, crmPipelines, crmTasks } from "@/db/schema";
import { getAuthContext, assertUserInBusiness } from "@/lib/auth";
import { AppError, ok, parseJson, parseWith } from "@/lib/api";
import { getLead } from "@/lib/services/leads";
import { requireTenantFeature } from "@/lib/tenant-config";
import { withApiHandling, checkGlobalPublicRateLimit } from "@/lib/server-core";
import { mapUniqueViolation } from "@/lib/api";
type Ctx = { params: Promise<{ entity: string }> };
const tables = { pipelines: crmPipelines, opportunities: crmOpportunities, tasks: crmTasks };
const base = z.object({ title: z.string().min(1).max(255), notes: z.string().max(10000).default(""), leadId: z.string().uuid().nullable().optional() });
const opportunity = base.extend({ pipelineId: z.string().uuid(), stage: z.string().min(1).max(100),
  value: z.string().regex(/^\d{1,18}(\.\d{1,2})?$/).default("0"), currency: z.enum(["TOMAN", "IRR", "USD", "EUR"]).default("TOMAN"), tags: z.array(z.string().min(1).max(50)).max(30).default([]) });
const task = base.extend({ assignedUserId: z.string().uuid().nullable().optional(), dueAt: z.string().datetime({ offset: true }).nullable().optional() });
function entityName(value: string): keyof typeof tables { if (!Object.hasOwn(tables, value)) throw new AppError(404, "NOT_FOUND", "CRM resource not found"); return value as keyof typeof tables; }
export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req); const auth = await getAuthContext(req); await requireTenantFeature(auth.businessId, "crm");
    const table = tables[entityName((await ctx.params).entity)];
    const data = await db.select().from(table).where(eq(table.businessId, auth.businessId)).orderBy(desc(table.createdAt)).limit(100);
    return ok({ data });
  });
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req); const auth = await getAuthContext(req); await requireTenantFeature(auth.businessId, "crm");
    const entity = entityName((await ctx.params).entity), body = await parseJson(req);
    if (entity === "pipelines") {
      const values = parseWith(z.object({ name: z.string().min(1).max(150), stages: z.array(z.string().min(1).max(100)).min(2).max(20).refine((a) => new Set(a).size === a.length, "Stages must be unique") }), body);
      try { const [row] = await db.insert(crmPipelines).values({ ...values, businessId: auth.businessId }).returning(); return ok(row, 201); }
      catch (error) { mapUniqueViolation(error, { crm_pipelines_name_idx: { code: "CONFLICT", message: "Pipeline name already exists" } }); }
    }
    if (entity === "opportunities") {
      const values = parseWith(opportunity, body);
      const [pipeline] = await db.select().from(crmPipelines).where(and(eq(crmPipelines.id, values.pipelineId), eq(crmPipelines.businessId, auth.businessId))).limit(1);
      if (!pipeline || !pipeline.stages.includes(values.stage)) throw new AppError(400, "VALIDATION_ERROR", "Invalid pipeline or stage");
      if (values.leadId) await getLead(auth.businessId, values.leadId);
      const [row] = await db.insert(crmOpportunities).values({ ...values, businessId: auth.businessId }).returning(); return ok(row, 201);
    }
    const values = parseWith(task, body);
    if (values.leadId) await getLead(auth.businessId, values.leadId);
    if (values.assignedUserId) await assertUserInBusiness(auth.businessId, values.assignedUserId);
    const [row] = await db.insert(crmTasks).values({ ...values, dueAt: values.dueAt ? new Date(values.dueAt) : null, businessId: auth.businessId }).returning(); return ok(row, 201);
  });
}
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req); const auth = await getAuthContext(req); await requireTenantFeature(auth.businessId, "crm");
    const entity = entityName((await ctx.params).entity), body = await parseJson(req);
    if (entity === "tasks") {
      const { id, status } = parseWith(z.object({ id: z.string().uuid(), status: z.enum(["OPEN", "DONE", "CANCELLED"]) }), body);
      const [row] = await db.update(crmTasks).set({ status, updatedAt: new Date() }).where(and(eq(crmTasks.id, id), eq(crmTasks.businessId, auth.businessId))).returning();
      if (!row) throw new AppError(404, "NOT_FOUND", "Task not found"); return ok(row);
    }
    if (entity !== "opportunities") throw new AppError(400, "BAD_REQUEST", "Pipeline stages are immutable; create a new pipeline to change them");
    const { id, stage } = parseWith(z.object({ id: z.string().uuid(), stage: z.string().min(1).max(100) }), body);
    const [deal] = await db.select().from(crmOpportunities).where(and(eq(crmOpportunities.id, id), eq(crmOpportunities.businessId, auth.businessId))).limit(1);
    if (!deal) throw new AppError(404, "NOT_FOUND", "Opportunity not found");
    const [pipeline] = await db.select().from(crmPipelines).where(and(eq(crmPipelines.id, deal.pipelineId), eq(crmPipelines.businessId, auth.businessId))).limit(1);
    if (!pipeline.stages.includes(stage)) throw new AppError(400, "VALIDATION_ERROR", "Invalid pipeline stage");
    const [row] = await db.update(crmOpportunities).set({ stage, updatedAt: new Date() }).where(and(eq(crmOpportunities.id, id), eq(crmOpportunities.businessId, auth.businessId))).returning(); return ok(row);
  });
}
