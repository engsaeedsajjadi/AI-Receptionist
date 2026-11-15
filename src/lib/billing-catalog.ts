import { z } from "zod";
export const PAID_PLANS = ["STARTER", "BUSINESS", "ENTERPRISE"] as const;
export const PaidPlanSchema = z.enum(PAID_PLANS);
export const CurrencySchema = z.enum(["USD", "EUR", "GBP", "IRR"]);
const CatalogSchema = z.object({
  issuer: z.string().trim().min(3).max(2000),
  paymentInstructions: z.string().trim().min(10).max(4000),
  plans: z.array(z.object({ plan: PaidPlanSchema, amountMinor: z.number().int().positive().max(2_000_000_000), currency: CurrencySchema }).strict()).min(1).max(3),
}).strict().refine((catalog) => new Set(catalog.plans.map((plan) => plan.plan)).size === catalog.plans.length, "Duplicate plan");
export function billingCatalog(raw = process.env.BILLING_CATALOG_JSON) {
  if (!raw) return null;
  return CatalogSchema.parse(JSON.parse(raw));
}
export function addCalendarMonth(date: Date): Date {
  const next = new Date(date);
  const day = next.getUTCDate();
  next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1);
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next;
}
export function effectivePlan(subscription: { plan: string; periodEnd: Date | null } | undefined, now = new Date()) {
  return subscription?.periodEnd && subscription.periodEnd > now ? subscription.plan : "FREE";
}
