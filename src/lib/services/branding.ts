import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLogs, businesses } from "@/db/schema";
import { mapUniqueViolation } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { assertTenantScope, requestContext } from "@/lib/request-context";
import { readTenantCache, writeTenantCache } from "@/lib/tenant-cache";
import { requireTenantFeature, tenantFeaturesSchema } from "@/lib/tenant-config";

/**
 * White-labeling (P2): per-tenant product name, logo, accent colour, support
 * address and custom domain.
 *
 * Rules that keep this safe and honest:
 *  - the whole surface is **entitlement-gated** server-side (`whiteLabel`
 *    feature): a tenant without the entitlement gets the platform defaults and a
 *    403 on write, never a silent fallback that looks branded;
 *  - a custom domain is a first-class unique column (`businesses.custom_domain`)
 *    so two tenants can never claim the same host (unique index is the guard,
 *    the pre-check only produces a friendlier error);
 *  - resolution by domain never leaks tenant existence: unknown, suspended or
 *    non-entitled domains all return the platform branding;
 *  - logo URLs must be `https://` so stored branding can never inject
 *    `javascript:`/`data:` into an `<img src>`.
 */

const DOMAIN_PATTERN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const HTTPS_URL = /^https:\/\/[^\s"'<>]+$/i;

export const BrandingSchema = z.object({
  /** Empty means "inherit the platform product name". */
  productName: z.string().trim().max(60),
  accentColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-f]{6}$/i, "accentColor must be a #RRGGBB hex colour")
    // Normalise case so "stored value" comparisons and cache versions are stable.
    .transform((value) => value.toLowerCase()),
  logoUrl: z.union([z.literal(""), z.string().trim().max(500).regex(HTTPS_URL, "logoUrl must be an https:// URL")]),
  supportEmail: z.union([z.literal(""), z.string().trim().email().max(255)]),
  customDomain: z
    .union([z.literal(""), z.string().trim().max(253).regex(DOMAIN_PATTERN, "customDomain must be a bare hostname")]),
  hidePlatformBranding: z.boolean(),
});
export type Branding = z.infer<typeof BrandingSchema>;
export const BrandingPatchSchema = BrandingSchema.partial();
export type BrandingPatch = z.infer<typeof BrandingPatchSchema>;

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export function platformBranding(): Branding {
  let productName = "AI Receptionist";
  try {
    productName = getEnv().NEXT_PUBLIC_APP_NAME;
  } catch {
    // Env not validated yet (unit tests / early boot): the constant is the default.
  }
  return { productName, accentColor: "#0f172a", logoUrl: "", supportEmail: "", customDomain: "", hidePlatformBranding: false };
}

/** Parse stored branding leniently: invalid stored values fall back to defaults. */
function parseStored(value: unknown): Branding {
  const parsed = BrandingPatchSchema.safeParse(value ?? {});
  const merged = { ...platformBranding(), ...(parsed.success ? parsed.data : {}) };
  return { ...merged, customDomain: merged.customDomain ? normalizeDomain(merged.customDomain) : "" };
}

function cacheVersion(updatedAt: Date, stored: unknown): string {
  return createHash("sha256").update(`${updatedAt.toISOString()}:${JSON.stringify(stored ?? {})}`).digest("hex").slice(0, 32);
}

export function brandingEnabled(settings: Record<string, unknown> | null | undefined): boolean {
  return tenantFeaturesSchema.parse(settings?.features ?? {}).whiteLabel;
}

/** Tenant-scoped read. Callers get the platform branding when unentitled. */
export async function getTenantBranding(businessId: string): Promise<{ enabled: boolean; branding: Branding }> {
  assertTenantScope(businessId);
  const [row] = await db
    .select({
      settings: businesses.settings,
      customDomain: businesses.customDomain,
      updatedAt: businesses.updatedAt,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!row) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
  if (!brandingEnabled(row.settings)) return { enabled: false, branding: platformBranding() };

  const version = cacheVersion(row.updatedAt, row.settings.branding);
  const cached = await readTenantCache<Branding>(businessId, "branding", version);
  if (cached) return { enabled: true, branding: cached };

  const branding = { ...parseStored(row.settings.branding), customDomain: normalizeDomain(row.customDomain ?? "") };
  await writeTenantCache(businessId, "branding", version, branding, 300);
  return { enabled: true, branding };
}

/** Entitlement-gated write; every change is recorded in the audit log. */
export async function updateTenantBranding(input: {
  businessId: string;
  userId?: string;
  patch: BrandingPatch;
}): Promise<{ enabled: boolean; branding: Branding }> {
  const { businessId, userId } = input;
  assertTenantScope(businessId);
  await requireTenantFeature(businessId, "whiteLabel");
  const patch = BrandingPatchSchema.parse(input.patch);

  const branding = await db
    .transaction(async (tx) => {
      const [row] = await tx
        .select({ settings: businesses.settings, customDomain: businesses.customDomain })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .for("update")
        .limit(1);
      if (!row) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");

      const next: Branding = { ...parseStored(row.settings.branding), ...patch };
      if (patch.customDomain !== undefined) next.customDomain = patch.customDomain ? normalizeDomain(patch.customDomain) : "";
      const domain = next.customDomain || null;

      if (domain && domain !== (row.customDomain ?? null)) {
        const [clash] = await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.customDomain, domain)).limit(1);
        if (clash && clash.id !== businessId) throw new AppError(409, "DOMAIN_TAKEN", "Custom domain is already in use");
      }

      const settings = { ...((row.settings as Record<string, unknown>) ?? {}), branding: next };
      try {
        await tx
          .update(businesses)
          .set({ settings, customDomain: domain, updatedAt: new Date() })
          .where(eq(businesses.id, businessId));
      } catch (error) {
        // Concurrent claim: the unique index is the real guard.
        mapUniqueViolation(error, {
          businesses_custom_domain_idx: { code: "DOMAIN_TAKEN", message: "Custom domain is already in use" },
        });
      }

      await tx.insert(auditLogs).values({
        businessId,
        actorType: userId ? "user" : "system",
        actorId: userId,
        action: "branding.updated",
        entityType: "business",
        entityId: businessId,
        requestId: requestContext.getStore()?.requestId,
        metadata: { changed: Object.keys(patch), customDomain: domain },
      });
      return next;
    })
    .catch((error: unknown) => {
      mapUniqueViolation(error, {
        businesses_custom_domain_idx: { code: "DOMAIN_TAKEN", message: "Custom domain is already in use" },
      });
    });

  // The cache key embeds the configuration version (updatedAt + stored value),
  // so the new write is read fresh and the previous entry ages out via its TTL.
  return { enabled: true, branding };
}

/**
 * Public, host-based resolution used by the marketing/edge layer.
 * Never reveals whether a host belongs to a tenant.
 */
export async function resolveBrandingByDomain(domain: string): Promise<{ branded: boolean; branding: Branding }> {
  const normalized = normalizeDomain(domain);
  if (!DOMAIN_PATTERN.test(normalized)) return { branded: false, branding: platformBranding() };
  const [row] = await db
    .select({ id: businesses.id, settings: businesses.settings, isActive: businesses.isActive, status: businesses.status })
    .from(businesses)
    .where(and(eq(businesses.customDomain, normalized)))
    .limit(1);
  if (!row || !row.isActive || row.status !== "ACTIVE") return { branded: false, branding: platformBranding() };
  if (!brandingEnabled(row.settings)) return { branded: false, branding: platformBranding() };
  return { branded: true, branding: parseStored(row.settings.branding) };
}
