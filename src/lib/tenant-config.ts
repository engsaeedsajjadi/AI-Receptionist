import { createHash } from "node:crypto";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { assertTenantScope } from "@/lib/request-context";
import { readTenantCache, writeTenantCache } from "@/lib/tenant-cache";
export const tenantFeaturesSchema = z.object({
  agent: z.boolean().default(true), knowledge: z.boolean().default(true), voice: z.boolean().default(true), crm: z.boolean().default(true), automation: z.boolean().default(true),
});
export type TenantFeatures = z.infer<typeof tenantFeaturesSchema>;
export async function requireTenantFeature(businessId: string, feature: keyof TenantFeatures) {
  assertTenantScope(businessId);
  const [business] = await db.select({ settings: businesses.settings, updatedAt: businesses.updatedAt }).from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.isActive, true))).limit(1);
  if (!business) throw new AppError(403, "FORBIDDEN", "Business is inactive");
  // Versioned cache keys prevent old flags being used after configuration changes.
  const version = business.updatedAt.toISOString() + ":" + createHash("sha256").update(JSON.stringify(business.settings.features ?? {})).digest("hex");
  let features = await readTenantCache<TenantFeatures>(businessId, "features", version);
  if (!features) {
    features = tenantFeaturesSchema.parse(business.settings.features ?? {});
    await writeTenantCache(businessId, "features", version, features, 60);
  }
  if (!features[feature]) throw new AppError(403, "FORBIDDEN", "Feature disabled for this tenant");
  return features;
}
