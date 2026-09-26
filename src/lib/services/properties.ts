import { and, eq, gte, ilike, lte, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { properties } from "@/db/schema";
import { AppError } from "@/lib/errors";
import {
  normalizeForSearch,
  normalizePersianText,
  normalizePropertyCode,
  parseArea,
  parseBedrooms,
  parsePrice,
} from "@/lib/normalization";

export const PropertySearchSchema = z.object({
  city: z.string().max(100).optional(),
  neighborhood: z.string().max(100).optional(),
  location: z.string().max(500).optional(),
  propertyType: z.string().max(30).optional(),
  transactionType: z.enum(["sale", "rent"]).optional(),
  listingStatus: z.enum(["sale", "rent"]).optional(),
  minPrice: z.union([z.string(), z.number()]).optional(),
  maxPrice: z.union([z.string(), z.number()]).optional(),
  minArea: z.union([z.string(), z.number()]).optional(),
  maxArea: z.union([z.string(), z.number()]).optional(),
  bedrooms: z.union([z.string(), z.number()]).optional(),
  features: z.array(z.string().max(50)).max(20).optional(),
  code: z.string().max(50).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export type PropertySearchInput = z.infer<typeof PropertySearchSchema>;

export const PropertyUpsertSchema = z.object({
  code: z.string().max(50).optional(),
  title: z.string().min(2).max(255),
  description: z.string().max(5000).optional(),
  transactionType: z.enum(["sale", "rent"]),
  propertyType: z.string().max(30).optional(),
  city: z.string().max(100).optional(),
  neighborhood: z.string().max(100).optional(),
  address: z.string().max(1000).optional(),
  location: z.string().min(1).max(1000),
  price: z.union([z.string(), z.number()]),
  priceCurrency: z.enum(["TOMAN", "RIAL"]).default("TOMAN"),
  area: z.union([z.string(), z.number()]),
  bedrooms: z.number().int().min(0).max(50).default(0),
  bathrooms: z.number().int().min(0).max(50).optional(),
  yearBuilt: z.number().int().min(1300).max(1500).optional(),
  features: z.array(z.string().max(50)).max(50).default([]),
  isAvailable: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type PropertyUpsertInput = z.infer<typeof PropertyUpsertSchema>;

/**
 * Tenant-scoped property search with Persian normalization.
 * The AI may ONLY mention properties returned by this search.
 */
export async function searchProperties(businessId: string, raw: unknown) {
  const filters = PropertySearchSchema.parse(raw);
  const conditions: SQL[] = [eq(properties.businessId, businessId), eq(properties.isAvailable, true)];

  const txn = filters.transactionType ?? filters.listingStatus;
  if (txn) conditions.push(eq(properties.transactionType, txn));
  if (filters.propertyType) conditions.push(eq(properties.propertyType, filters.propertyType));
  if (filters.city) conditions.push(ilike(properties.city, `%${normalizeForSearch(filters.city)}%`));
  if (filters.neighborhood) {
    conditions.push(ilike(properties.neighborhood, `%${normalizeForSearch(filters.neighborhood)}%`));
  }
  if (filters.location) {
    const loc = `%${normalizeForSearch(filters.location)}%`;
    conditions.push(or(ilike(properties.location, loc), ilike(properties.neighborhood, loc), ilike(properties.city, loc))!);
  }
  if (filters.code) {
    const code = normalizePropertyCode(filters.code);
    if (code) conditions.push(eq(properties.code, code));
  }

  const minPrice = filters.minPrice != null ? parsePrice(filters.minPrice)?.amountToman : null;
  const maxPrice = filters.maxPrice != null ? parsePrice(filters.maxPrice)?.amountToman : null;
  const minArea = filters.minArea != null ? parseArea(filters.minArea) : null;
  const maxArea = filters.maxArea != null ? parseArea(filters.maxArea) : null;
  const bedrooms = filters.bedrooms != null ? parseBedrooms(filters.bedrooms) : null;

  if (minPrice != null) conditions.push(gte(properties.price, String(minPrice)));
  if (maxPrice != null) conditions.push(lte(properties.price, String(maxPrice)));
  if (minArea != null) conditions.push(gte(properties.area, String(minArea)));
  if (maxArea != null) conditions.push(lte(properties.area, String(maxArea)));
  if (bedrooms != null) conditions.push(gte(properties.bedrooms, bedrooms));

  const rows = await db
    .select()
    .from(properties)
    .where(and(...conditions))
    .limit(filters.limit * 2); // over-fetch for feature filtering

  let filtered = rows;
  if (filters.features?.length) {
    const wanted = filters.features.map((f) => normalizeForSearch(f));
    filtered = rows.filter((p) => {
      const have = (p.features ?? []).map((f) => normalizeForSearch(f));
      return wanted.every((w) => have.some((h) => h.includes(w) || w.includes(h)));
    });
  }

  return filtered.slice(0, filters.limit).map((p) => ({
    id: p.id,
    code: p.code,
    title: p.title,
    description: p.description,
    transactionType: p.transactionType,
    propertyType: p.propertyType,
    city: p.city,
    neighborhood: p.neighborhood,
    location: p.location,
    price: p.price,
    priceCurrency: p.priceCurrency,
    area: p.area,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    features: p.features,
    isAvailable: p.isAvailable,
  }));
}

export async function createProperty(businessId: string, raw: unknown) {
  const input = PropertyUpsertSchema.parse(raw);
  const price = parsePrice(input.price)?.amountToman;
  const area = parseArea(input.area);
  if (price == null || price <= 0) throw new AppError(400, "VALIDATION_ERROR", "Invalid property price");
  if (area == null || area <= 0) throw new AppError(400, "VALIDATION_ERROR", "Invalid property area");

  const [created] = await db
    .insert(properties)
    .values({
      businessId,
      code: input.code ? normalizePropertyCode(input.code) : null,
      title: normalizePersianText(input.title),
      description: input.description ? normalizePersianText(input.description) : null,
      transactionType: input.transactionType,
      propertyType: input.propertyType ?? null,
      city: input.city ? normalizePersianText(input.city) : null,
      neighborhood: input.neighborhood ? normalizePersianText(input.neighborhood) : null,
      address: input.address ? normalizePersianText(input.address) : null,
      location: normalizePersianText(input.location),
      price: String(price),
      priceCurrency: "TOMAN",
      area: String(area),
      bedrooms: input.bedrooms,
      bathrooms: input.bathrooms ?? null,
      yearBuilt: input.yearBuilt ?? null,
      features: input.features.map((f) => normalizePersianText(f)),
      isAvailable: input.isAvailable,
      metadata: input.metadata,
    })
    .returning();
  return created;
}

export async function getProperty(businessId: string, propertyId: string) {
  const [row] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.businessId, businessId)))
    .limit(1);
  if (!row) throw new AppError(404, "PROPERTY_NOT_FOUND", "Property not found");
  return row;
}

export async function updateProperty(businessId: string, propertyId: string, raw: unknown) {
  const input = PropertyUpsertSchema.partial().parse(raw);
  const patch: Partial<typeof properties.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = normalizePersianText(input.title);
  if (input.description !== undefined) patch.description = input.description ? normalizePersianText(input.description) : null;
  if (input.transactionType !== undefined) patch.transactionType = input.transactionType;
  if (input.propertyType !== undefined) patch.propertyType = input.propertyType ?? null;
  if (input.city !== undefined) patch.city = input.city ? normalizePersianText(input.city) : null;
  if (input.neighborhood !== undefined) patch.neighborhood = input.neighborhood ? normalizePersianText(input.neighborhood) : null;
  if (input.address !== undefined) patch.address = input.address ? normalizePersianText(input.address) : null;
  if (input.location !== undefined) patch.location = normalizePersianText(input.location);
  if (input.price !== undefined) {
    const price = parsePrice(input.price)?.amountToman;
    if (price == null || price <= 0) throw new AppError(400, "VALIDATION_ERROR", "Invalid property price");
    patch.price = String(price);
    patch.priceCurrency = "TOMAN";
  }
  if (input.area !== undefined) {
    const area = parseArea(input.area);
    if (area == null || area <= 0) throw new AppError(400, "VALIDATION_ERROR", "Invalid property area");
    patch.area = String(area);
  }
  if (input.bedrooms !== undefined) patch.bedrooms = input.bedrooms;
  if (input.bathrooms !== undefined) patch.bathrooms = input.bathrooms ?? null;
  if (input.yearBuilt !== undefined) patch.yearBuilt = input.yearBuilt ?? null;
  if (input.features !== undefined) patch.features = input.features.map((f) => normalizePersianText(f));
  if (input.isAvailable !== undefined) patch.isAvailable = input.isAvailable;
  if (input.metadata !== undefined) patch.metadata = input.metadata as Record<string, unknown>;
  if (input.code !== undefined) patch.code = input.code ? normalizePropertyCode(input.code) : null;

  const [updated] = await db
    .update(properties)
    .set(patch)
    .where(and(eq(properties.id, propertyId), eq(properties.businessId, businessId)))
    .returning();
  if (!updated) throw new AppError(404, "PROPERTY_NOT_FOUND", "Property not found");
  return updated;
}
