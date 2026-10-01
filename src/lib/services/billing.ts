import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { invoices, plans, subscriptions, tenantWorkspaces, usageMeters } from "@/db/saas-schema";

export async function getTenantForBusiness(businessId: string) {
  const row = await db.select().from(tenantWorkspaces).where(eq(tenantWorkspaces.businessId, businessId)).limit(1);
  return row[0] ?? null;
}

export async function getBillingOverview(businessId: string) {
  const workspace = await getTenantForBusiness(businessId);
  if (!workspace) return null;
  const subscription = await db.select({
    id: subscriptions.id, status: subscriptions.status, currentPeriodStart: subscriptions.currentPeriodStart,
    currentPeriodEnd: subscriptions.currentPeriodEnd, plan: plans,
  }).from(subscriptions).innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.tenantId, workspace.tenantId)).orderBy(desc(subscriptions.createdAt)).limit(1).then(r => r[0] ?? null);
  const periodStart = subscription?.currentPeriodStart ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const usage = await db.select({ metric: usageMeters.metric, total: sql<string>`coalesce(sum(${usageMeters.quantity}),0)` })
    .from(usageMeters).where(and(eq(usageMeters.tenantId, workspace.tenantId), gte(usageMeters.occurredAt, periodStart)))
    .groupBy(usageMeters.metric);
  const recentInvoices = await db.select().from(invoices).where(eq(invoices.tenantId, workspace.tenantId))
    .orderBy(desc(invoices.issuedAt)).limit(20);
  return { tenantId: workspace.tenantId, subscription, usage, invoices: recentInvoices };
}
