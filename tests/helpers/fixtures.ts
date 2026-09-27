import { hash } from "bcryptjs";
import { db } from "@/db";
import { agents, businesses, calls, customers, knowledgeDocuments, leads, properties, users } from "@/db/schema";

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export async function createBusiness(name?: string) {
  const [biz] = await db
    .insert(businesses)
    .values({ name: name ?? unique("Biz"), slug: unique("biz").toLowerCase().replace(/[^a-z0-9-]/g, "-") })
    .returning();
  return biz;
}

export async function createUser(businessId: string, role: "ADMIN" | "MANAGER" | "AGENT" = "ADMIN", password = "Test1234!") {
  const [user] = await db
    .insert(users)
    .values({
      businessId,
      name: "Test User",
      email: `${unique("user")}@example.com`,
      passwordHash: await hash(password, 10),
      role,
    })
    .returning();
  return { user, password };
}

export async function createAgent(businessId: string) {
  const [agent] = await db
    .insert(agents)
    .values({ businessId, name: "Test Agent", systemPrompt: "test", configuration: {} })
    .returning();
  return agent;
}

export async function createCustomer(businessId: string, phone = "09123456789") {
  const [customer] = await db
    .insert(customers)
    .values({ businessId, phone, name: "Test Customer" })
    .returning();
  return customer;
}

export async function createLead(businessId: string, customerId: string, status: "NEW" | "LOST" | "WON" = "NEW") {
  const [lead] = await db
    .insert(leads)
    .values({ businessId, customerId, type: "BUY", status, location: "تهران" })
    .returning();
  return lead;
}

export async function createProperty(businessId: string, overrides?: Partial<typeof properties.$inferInsert>) {
  const [property] = await db
    .insert(properties)
    .values({
      businessId,
      code: unique("PROP"),
      title: "Test Apartment",
      transactionType: "sale",
      propertyType: "apartment",
      city: "تهران",
      neighborhood: "سعادت‌آباد",
      location: "تهران، سعادت‌آباد",
      price: "5000000000",
      area: "100",
      bedrooms: 2,
      isAvailable: true,
      ...overrides,
    })
    .returning();
  return property;
}

export async function createCall(businessId: string, phone = "09123456789") {
  const [call] = await db
    .insert(calls)
    .values({
      businessId,
      externalCallId: unique("call"),
      phoneNumber: phone,
      status: "IN_PROGRESS",
      startedAt: new Date(),
    })
    .returning();
  return call;
}

export async function createKnowledgeDoc(businessId: string, content = "ساعات کاری دفتر شنبه تا پنجشنبه ۹ تا ۱۸ است.") {
  const [doc] = await db
    .insert(knowledgeDocuments)
    .values({ businessId, title: "Test Doc", sourceType: "manual", status: "indexed", content })
    .returning();
  return doc;
}
