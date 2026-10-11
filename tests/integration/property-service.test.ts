import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { properties } from "@/db/schema";
import { createProperty, getProperty, searchProperties, updateProperty } from "@/lib/services/properties";
import { PropertySearchSchema, PropertyUpsertSchema } from "@/lib/services/properties";
import { createBusiness } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

const base = {
  title: "آپارتمان لوکس",
  transactionType: "sale" as const,
  location: "تهران، سعادت‌آباد",
  price: "12 میلیارد تومان",
  area: "120 متر",
  bedrooms: 3,
  features: ["پارکینگ", "آسانسور", "استخر"],
  city: "تهران",
  neighborhood: "سعادت‌آباد",
  propertyType: "آپارتمان",
};

describe.skipIf(!hasTestDatabase())("property service search and mutation", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  itDb("applies every documented search filter without leaking tenants", async () => {
    const business = await createBusiness();
    const other = await createBusiness();
    const created = await createProperty(business.id, { ...base, code: "AB-100" });
    await createProperty(business.id, {
      ...base,
      title: "ویلا شمال",
      propertyType: "ویلا",
      city: "رامسر",
      neighborhood: "ساحل",
      location: "رامسر، ساحل",
      transactionType: "rent",
      price: "200 میلیون تومان",
      area: "300 متر",
      bedrooms: 5,
      features: ["استخر"],
      isAvailable: false,
    });
    await createProperty(other.id, { ...base, title: "ملک دیگری", code: "ZZ-1" });

    // The default search excludes unavailable listings and other tenants.
    const all = await searchProperties(business.id, {});
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("آپارتمان لوکس");

    expect(await searchProperties(business.id, { code: "ab-100" })).toHaveLength(1);
    expect(await searchProperties(business.id, { code: "AB-100" })).toHaveLength(1);
    expect(await searchProperties(business.id, { code: "AB100" })).toHaveLength(0); // code separators are significant
    expect(await searchProperties(business.id, { code: "missing" })).toHaveLength(0);
    expect(await searchProperties(business.id, { transactionType: "sale" })).toHaveLength(1);
    expect(await searchProperties(business.id, { listingStatus: "rent" })).toHaveLength(0); // unavailable
    expect(await searchProperties(business.id, { propertyType: "آپارتمان" })).toHaveLength(1);
    expect(await searchProperties(business.id, { propertyType: "زمین" })).toHaveLength(0);
    expect(await searchProperties(business.id, { city: "تهران" })).toHaveLength(1);
    expect(await searchProperties(business.id, { city: "کرج" })).toHaveLength(0);
    expect(await searchProperties(business.id, { neighborhood: "سعادت" })).toHaveLength(1);
    expect(await searchProperties(business.id, { location: "سعادت" })).toHaveLength(1);
    expect(await searchProperties(business.id, { location: "تهران" })).toHaveLength(1);
    // Price/area/bedroom bounds are compared numerically, not lexically.
    expect(await searchProperties(business.id, { maxPrice: "5 میلیارد تومان" })).toHaveLength(0);
    expect(await searchProperties(business.id, { minPrice: "1000000000" })).toHaveLength(1);
    expect(await searchProperties(business.id, { minArea: 100, maxArea: 130 })).toHaveLength(1);
    expect(await searchProperties(business.id, { maxArea: "50 متر" })).toHaveLength(0);
    expect(await searchProperties(business.id, { bedrooms: "3" })).toHaveLength(1);
    expect(await searchProperties(business.id, { bedrooms: 5 })).toHaveLength(0);
    expect(await searchProperties(business.id, { features: ["پارکینگ", "استخر"] })).toHaveLength(1);
    expect(await searchProperties(business.id, { features: ["روف گاردن"] })).toHaveLength(0);
    expect(await searchProperties(business.id, { limit: 1 })).toHaveLength(1);
    // Wildcards in caller input are escaped, so `%` cannot match everything.
    expect(await searchProperties(business.id, { city: "%" })).toHaveLength(0);
    // tenant scope is enforced before the query
    await expect(searchProperties("", {})).rejects.toThrow();
    await expect(searchProperties(business.id, { limit: 999 })).rejects.toThrow();
    expect(PropertySearchSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(PropertySearchSchema.safeParse({ transactionType: "lease" }).success).toBe(false);
    expect(PropertySearchSchema.parse({}).limit).toBe(10);
    expect(created.code).toBe("AB-100");
  });

  itDb("validates, normalises and rejects malformed property payloads", async () => {
    const business = await createBusiness();
    await expect(createProperty(business.id, {})).rejects.toThrow();
    await expect(createProperty(business.id, { ...base, price: "رایگان" })).rejects.toThrow(/Invalid property price/);
    await expect(createProperty(business.id, { ...base, area: "بزرگ" })).rejects.toThrow(/Invalid property area/);
    await expect(createProperty(business.id, { ...base, price: "0" })).rejects.toThrow(/Invalid property price/);
    await expect(createProperty(business.id, { ...base, area: 0 })).rejects.toThrow(/Invalid property area/);

    const created = await createProperty(business.id, {
      ...base,
      title: "  آپارتمان   لوکس  ",
      code: " ab 200 ",
      price: "۱۲۰۰۰۰۰۰۰۰۰",
      area: "۱۲۵ متر",
      features: ["  پارکینگ  "],
      metadata: { source: "seed" },
    });
    expect(created.title).toBe("آپارتمان لوکس");
    expect(created.code).toBe("AB200");
    expect(Number(created.price)).toBe(12_000_000_000);
    expect(Number(created.area)).toBe(125);
    expect(created.priceCurrency).toBe("TOMAN");
    expect(created.metadata).toEqual({ source: "seed" });
    expect(PropertyUpsertSchema.parse({ ...base, price: 1 }).price).toBe(1);
    expect(PropertyUpsertSchema.safeParse({ ...base, yearBuilt: 1200 }).success).toBe(false);
    expect(PropertyUpsertSchema.safeParse({ ...base, features: ["x".repeat(51)] }).success).toBe(false);
  });

  itDb("updates only supplied fields and refuses cross-tenant ids", async () => {
    const business = await createBusiness();
    const other = await createBusiness();
    const property = await createProperty(business.id, base);
    expect((await getProperty(business.id, property.id)).id).toBe(property.id);
    await expect(getProperty(other.id, property.id)).rejects.toThrow(/Property not found/);
    await expect(getProperty(business.id, crypto.randomUUID())).rejects.toThrow(/Property not found/);

    const updated = await updateProperty(business.id, property.id, {
      title: "آپارتمان نوساز",
      description: "",
      price: "13 میلیارد تومان",
      area: 130,
      isAvailable: false,
      features: ["پارکینگ"],
      code: "",
      bathrooms: 2,
      yearBuilt: 1400,
      metadata: { renovated: true },
      propertyType: undefined,
    });
    expect(updated.title).toBe("آپارتمان نوساز");
    expect(updated.description).toBeNull();
    expect(updated.code).toBeNull();
    expect(Number(updated.price)).toBe(13_000_000_000);
    expect(Number(updated.area)).toBe(130);
    expect(updated.isAvailable).toBe(false);
    expect(updated.bathrooms).toBe(2);
    expect(updated.yearBuilt).toBe(1400);
    expect(updated.propertyType).toBe("آپارتمان");

    await expect(updateProperty(business.id, property.id, { price: "بی‌ارزش" })).rejects.toThrow(/Invalid property price/);
    await expect(updateProperty(business.id, property.id, { area: -3 })).rejects.toThrow();
    await expect(updateProperty(other.id, property.id, { title: "دزدی" })).rejects.toThrow(/Property not found/);
    await expect(updateProperty(business.id, crypto.randomUUID(), { title: "ناموجود" })).rejects.toThrow(/Property not found/);

    await expect(updateProperty(business.id, property.id, { bedrooms: "سه" })).rejects.toThrow(/Validation/);
    const cleared = await updateProperty(business.id, property.id, { bathrooms: null, yearBuilt: null, city: "" });
    expect(cleared.bathrooms).toBeNull();
    expect(cleared.yearBuilt).toBeNull();
    expect(cleared.city).toBeNull();
    // The row still belongs to its tenant after all updates.
    const [row] = await db.select().from(properties).where(eq(properties.id, property.id));
    expect(row.businessId).toBe(business.id);
  });
});
