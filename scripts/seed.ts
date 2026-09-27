/**
 * Development seed: creates a demo business + admin + agent + sample property.
 * Dev/test only — refuses to run in production.
 *
 * Env: SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_BUSINESS_NAME, SEED_BUSINESS_SLUG
 */
import "dotenv/config";
import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { agents, businesses, properties, users } from "../src/db/schema";
import { buildAgentPrompt } from "../src/lib/agent-prompt";

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed is not allowed in production");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@example.com").toLowerCase().trim();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";
  const businessName = process.env.SEED_BUSINESS_NAME ?? "Demo Real Estate";
  const slug = (process.env.SEED_BUSINESS_SLUG ?? "demo-estate").toLowerCase().trim();

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  try {
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      console.log("[seed] admin already exists, skipping");
      return;
    }
    const passwordHash = await hash(password, 12);
    const result = await db.transaction(async (tx) => {
      const [biz] = await tx.insert(businesses).values({ name: businessName, slug }).returning();
      const [user] = await tx
        .insert(users)
        .values({ businessId: biz.id, name: "Admin", email, passwordHash, role: "ADMIN" })
        .returning();
      await tx.insert(agents).values({
        businessId: biz.id,
        name: "منشی هوشمند",
        systemPrompt: buildAgentPrompt({ businessName, businessContext: "دفتر املاک - پاسخ‌گویی تماس‌ها و ثبت سرنخ" }),
      });
      await tx.insert(properties).values({
        businessId: biz.id,
        code: "DEMO-001",
        title: "آپارتمان نمونه ۱۲۰ متری",
        transactionType: "sale",
        propertyType: "apartment",
        city: "تهران",
        neighborhood: "سعادت‌آباد",
        location: "تهران، سعادت‌آباد",
        price: "8500000000",
        area: "120",
        bedrooms: 3,
        isAvailable: true,
      });
      return { biz, user };
    });
    console.log(`[seed] business=${result.biz.id} admin=${result.user.email}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[seed] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
