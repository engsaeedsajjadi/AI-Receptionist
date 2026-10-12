import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
// Static imports on purpose: a dynamic `await import("@/db")` inside the setup
// function is resolved by the ESM loader, which does not apply the tsconfig
// `paths` mapping, so it fails at runtime with "Cannot find module '@/db'".
// Statically imported files go through Playwright's transform, which does.
import { seedBrowserTenant } from "./seed-tenant";
import { hashPassword } from "@/lib/auth";
import { closeDb, db } from "@/db";
import { businesses, users } from "@/db/schema";

export const SEED_FILE = path.join(process.cwd(), "test-results", "browser-seed.json");

export type BrowserSeed = {
  businessId: string;
  businessName: string;
  adminUserId: string;
  adminEmail: string;
  adminPassword: string;
  viewerUserId: string;
  viewerEmail: string;
  viewerPassword: string;
  agentName: string;
  propertyTitle: string;
  knowledgeTitle: string;
  customerPhone: string;
};

/**
 * Seeds a disposable tenant for the browser journeys.
 *
 * Safety rails (the suite must never touch production data):
 *  - TEST_DATABASE_URL must be set, or DATABASE_URL must look like a test DB.
 *  - the tenant is created with a random slug, so it can be truncated afterwards.
 */
export default async function globalSetup(): Promise<void> {
  loadEnvConfig(process.cwd());
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  const looksLikeTest = /test|local|127\.0\.0\.1|localhost/i.test(url);
  if (!url || (!looksLikeTest && !process.env.TEST_DATABASE_URL)) {
    throw new Error(
      "Browser journeys need a disposable database: set TEST_DATABASE_URL (or a DATABASE_URL pointing at a local/test database). Refusing to seed a production database.",
    );
  }

  const businessName = `آژانس آرنا ${Date.now()}`;
  // The phone is uniquely indexed (that is what routes inbound calls to a
  // tenant), so a fixed value makes a second run against a non-empty database
  // fail with a duplicate-key error. Derive it from the run instead.
  const runSuffix = Date.now().toString(36);
  const [business] = await db
    .insert(businesses)
    .values({ name: businessName, slug: `e2e-${runSuffix}`, phone: `+989${String(Date.now()).slice(-9)}` })
    .returning();

  const adminEmail = `admin-${Date.now().toString(36)}@e2e.example.com`;
  const viewerEmail = `viewer-${Date.now().toString(36)}@e2e.example.com`;
  const adminPassword = "BrowserTest1234!";
  const viewerPassword = "BrowserTest1234!";
  const [adminUser, viewerUser] = await db.insert(users).values([
    { businessId: business.id, name: "مدیر آژانس", email: adminEmail, passwordHash: await hashPassword(adminPassword), role: "ADMIN", emailVerifiedAt: new Date() },
    { businessId: business.id, name: "کارشناس", email: viewerEmail, passwordHash: await hashPassword(viewerPassword), role: "VIEWER", emailVerifiedAt: new Date() },
  ]).returning({ id: users.id });

  const seed = await seedBrowserTenant(business.id, businessName);
  mkdirSync(path.dirname(SEED_FILE), { recursive: true });
  const payload: BrowserSeed = {
    businessId: business.id,
    businessName,
    adminUserId: adminUser.id,
    adminEmail,
    adminPassword,
    viewerUserId: viewerUser.id,
    viewerEmail,
    viewerPassword,
    ...seed,
  };
  writeFileSync(SEED_FILE, JSON.stringify(payload, null, 2), "utf8");
  await closeDb();
}
