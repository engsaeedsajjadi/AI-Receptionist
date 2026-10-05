import { afterAll, beforeAll, describe, expect } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { knowledgeChunks, retrievalEvents } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { runtimePrincipal } from "@/lib/rag/access";
import { hybridSearch } from "@/lib/services/knowledge";
import { searchKnowledgeGoverned } from "@/lib/services/knowledge-governance";
import { runAgentTurn } from "@/lib/services/agent";
import { POST as knowledgeSearch } from "@/app/api/v1/knowledge/search/route";
import type { ChatCompletionResult, LLMProvider } from "@/lib/providers/llm";
import { createAgent, createBusiness, createKnowledgeDoc, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * RAG access control, enforced end to end.
 *
 * The bug this suite exists for: omitting the retrieval `scope` used to make the
 * ACL predicate `TRUE`, so every ROLE/AGENT/PRIVATE/CATEGORY restriction silently
 * disappeared for the AI runtime and the search API. These tests pin the
 * fail-closed behaviour, including that the caller-facing runtime cannot read
 * documents restricted to a human role or to a specific user.
 */

let ipSeq = 0;
function searchRequest(token: string, body: unknown) {
  return new NextRequest("http://localhost/api/v1/knowledge/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-real-ip": `10.17.${(ipSeq >> 8) % 250}.${(ipSeq++ % 250) + 1}`,
    },
    body: JSON.stringify(body),
  });
}

/** Seeded document with a chunk that keyword search can find. */
async function seedDoc(businessId: string, text: string, options: Partial<typeof import("@/db/schema").knowledgeDocuments.$inferInsert> = {}) {
  const doc = await createKnowledgeDoc(businessId, text);
  if (Object.keys(options).length) {
    const { knowledgeDocuments } = await import("@/db/schema");
    await db.update(knowledgeDocuments).set(options).where(eq(knowledgeDocuments.id, doc.id));
  }
  await db.insert(knowledgeChunks).values({
    businessId,
    documentId: doc.id,
    chunkIndex: 0,
    content: text,
    tokenCount: 20,
    metadata: {},
  });
  return doc;
}

const scopeFor = (principal: ReturnType<typeof runtimePrincipal>) => ({
  principal,
  filters: { tags: [], includeDrafts: false },
});

class ScriptedLLM implements LLMProvider {
  readonly name = "scripted";
  constructor(private readonly reply: string) {}
  async complete(): Promise<ChatCompletionResult> {
    return {
      content: this.reply,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: "scripted",
      latencyMs: 1,
    };
  }
}

describe.skipIf(!hasTestDatabase())("RAG access control enforcement", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  itDb("keeps role-, user- and category-restricted documents out of the runtime candidate set", async () => {
    const business = await createBusiness(`Acl ${crypto.randomUUID().slice(0, 8)}`);
    const { user } = await createUser(business.id, "ADMIN");
    const PHrase = "قاعده اختصاصی مدیران درباره تخفیف ویژه";

    const tenantDoc = await seedDoc(business.id, "ساعات کاری دفتر از شنبه تا چهارشنبه است.");
    const roleDoc = await seedDoc(business.id, PHrase, { visibility: "ROLE", acl: { roles: ["ADMIN"] } });
    const privateDoc = await seedDoc(business.id, "یادداشت خصوصی مدیر درباره پرونده ۱۱۲۲", { visibility: "PRIVATE", acl: { userIds: [user.id] } });
    const categoryDoc = await seedDoc(business.id, "فرآیند داخلی واحد حقوقی برای بازبینی قراردادها", {
      visibility: "CATEGORY",
      category: "legal",
      acl: { categories: ["legal"] },
    });

    // The runtime (a caller-facing AI) sees tenant-wide documents only.
    const runtime = await hybridSearch({
      businessId: business.id,
      query: "تخفیف ویژه",
      topK: 10,
      scope: scopeFor(runtimePrincipal()),
    });
    const runtimeIds = runtime.chunks.map((chunk) => chunk.documentId);
    expect(runtimeIds).not.toContain(roleDoc.id);
    expect(runtimeIds).not.toContain(privateDoc.id);

    // An admin session sees the role-restricted document…
    const admin = await hybridSearch({
      businessId: business.id,
      query: "تخفیف ویژه",
      topK: 10,
      scope: scopeFor({ role: "ADMIN", userId: user.id, agentId: null, platformSupport: false }),
    });
    expect(admin.chunks.map((chunk) => chunk.documentId)).toContain(roleDoc.id);

    // …and only the granting user sees the private one.
    const owner = await hybridSearch({
      businessId: business.id,
      query: "پرونده ۱۱۲۲",
      topK: 10,
      scope: scopeFor({ role: "ADMIN", userId: user.id, agentId: null, platformSupport: false }),
    });
    expect(owner.chunks.map((chunk) => chunk.documentId)).toContain(privateDoc.id);
    const colleague = await createUser(business.id, "MANAGER");
    const other = await hybridSearch({
      businessId: business.id,
      query: "پرونده ۱۱۲۲",
      topK: 10,
      scope: scopeFor({ role: "MANAGER", userId: colleague.user.id, agentId: null, platformSupport: false }),
    });
    expect(other.chunks.map((chunk) => chunk.documentId)).not.toContain(privateDoc.id);

    // Category documents need the category/department grant.
    const legal = await hybridSearch({
      businessId: business.id,
      query: "بازبینی قراردادها",
      topK: 10,
      scope: { principal: runtimePrincipal(), filters: { tags: [], includeDrafts: false, category: "legal" } },
    });
    expect(legal.chunks.map((chunk) => chunk.documentId)).toContain(categoryDoc.id);

    // Tenant-wide documents stay reachable for everyone in the tenant (queried
    // with their own terms: the first query deliberately matched nothing).
    const tenantWide = await hybridSearch({
      businessId: business.id,
      query: "ساعات کاری دفتر",
      topK: 10,
      scope: scopeFor(runtimePrincipal()),
    });
    expect(tenantWide.chunks.map((chunk) => chunk.documentId)).toContain(tenantDoc.id);
  });

  itDb("gives an agent-restricted document only to the agent it names", async () => {
    const business = await createBusiness(`AclAgent ${crypto.randomUUID().slice(0, 8)}`);
    const { agents } = await import("@/db/schema");
    const [agentA] = await db.insert(agents).values({ businessId: business.id, name: "Agent A", isActive: true }).returning();
    const [agentB] = await db.insert(agents).values({ businessId: business.id, name: "Agent B", isActive: true }).returning();
    const doc = await seedDoc(business.id, "راهنمای داخلی مخصوص ایجنت فروش ویژه", {
      visibility: "AGENT",
      acl: { agentIds: [agentA.id] },
    });

    const own = await hybridSearch({
      businessId: business.id,
      query: "راهنمای داخلی مخصوص",
      topK: 10,
      scope: scopeFor(runtimePrincipal({ agentId: agentA.id })),
    });
    expect(own.chunks.map((chunk) => chunk.documentId)).toContain(doc.id);

    const other = await hybridSearch({
      businessId: business.id,
      query: "راهنمای داخلی مخصوص",
      topK: 10,
      scope: scopeFor(runtimePrincipal({ agentId: agentB.id })),
    });
    expect(other.chunks.map((chunk) => chunk.documentId)).not.toContain(doc.id);
  });

  itDb("scopes the search API to the caller's verified role and records the retrieval", async () => {
    const business = await createBusiness(`AclApi ${crypto.randomUUID().slice(0, 8)}`);
    const { user } = await createUser(business.id, "ADMIN");
    // MANAGER has access to this endpoint (knowledge:write) but is not an ADMIN,
    // so it can reach the API yet must not see the role-restricted document.
    const { user: managerUser } = await createUser(business.id, "MANAGER");
    const { user: agentUser } = await createUser(business.id, "AGENT");
    const doc = await seedDoc(business.id, "سیاست تخفیف فقط برای مدیران معتبر است", { visibility: "ROLE", acl: { roles: ["ADMIN"] } });

    const adminToken = (await issueAuthTokens({ userId: user.id, businessId: business.id, role: "ADMIN" })).accessToken;
    const managerToken = (await issueAuthTokens({ userId: managerUser.id, businessId: business.id, role: "MANAGER" })).accessToken;
    const agentToken = (await issueAuthTokens({ userId: agentUser.id, businessId: business.id, role: "AGENT" })).accessToken;

    const adminRes = await knowledgeSearch(searchRequest(adminToken, { query: "سیاست تخفیف", topK: 5 }));
    expect(adminRes.status).toBe(200);
    const adminBody = (await adminRes.json()) as { chunks: Array<{ documentId: string }> };
    expect(adminBody.chunks.map((c) => c.documentId)).toContain(doc.id);

    // A manager session reaches the same endpoint but must not receive the
    // restricted document — and the response must not leak its content in any
    // other field either.
    const managerRes = await knowledgeSearch(searchRequest(managerToken, { query: "سیاست تخفیف", topK: 5 }));
    expect(managerRes.status).toBe(200);
    const managerBody = (await managerRes.json()) as { chunks: Array<{ documentId: string }> };
    expect(managerBody.chunks.map((c) => c.documentId)).not.toContain(doc.id);
    expect(JSON.stringify(managerBody)).not.toContain("فقط برای مدیران");

    // A role without knowledge access is refused before retrieval even runs.
    const agentRes = await knowledgeSearch(searchRequest(agentToken, { query: "سیاست تخفیف", topK: 5 }));
    expect(agentRes.status).toBe(403);
  });

  itDb("records governed retrieval for analytics and reports which documents were used", async () => {
    const business = await createBusiness(`Gov ${crypto.randomUUID().slice(0, 8)}`);
    const doc = await seedDoc(business.id, "هزینه بازدید ملک دو میلیون تومان است و قابل پرداخت آنلاین است.");
    const result = await searchKnowledgeGoverned({
      businessId: business.id,
      query: "هزینه بازدید",
      principal: runtimePrincipal(),
      topK: 5,
    });
    // CI has no embedding provider, so keyword-only retrieval reports "degraded"
    // — still a real retrieval with analytics, which is what this asserts.
    expect(["ok", "degraded"]).toContain(result.outcome);
    expect(result.documentIds).toContain(doc.id);
    expect(result.retrievalId).toBeTruthy();

    const events = await db.select().from(retrievalEvents).where(eq(retrievalEvents.businessId, business.id));
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].id).toBe(result.retrievalId);

    const { markEvidenceUsed } = await import("@/lib/services/knowledge-governance");
    expect(await markEvidenceUsed(business.id, result.retrievalId!, [doc.id])).toBe(true);
  });

  itDb("never lets a fabricated answer reach the caller when the evidence does not support it", async () => {
    const business = await createBusiness(`Ground ${crypto.randomUUID().slice(0, 8)}`);
    const { agents } = await import("@/db/schema");
    const agent = await createAgent(business.id);
    await db.update(agents).set({ configuration: { retrievalMode: "automatic" } }).where(eq(agents.id, agent.id));
    // Evidence states the opposite of what the model will claim.
    await seedDoc(business.id, "ساعت کاری مجموعه از شنبه تا چهارشنبه ۹ تا ۱۷ است و پنجشنبه تعطیل است.");

    const fabricated = await runAgentTurn({
      businessId: business.id,
      userMessage: "ساعت کاری شما چیست؟",
      requestId: crypto.randomUUID(),
      llm: new ScriptedLLM("ما هر روز هفته بیست و چهار ساعته باز هستیم و شبانه هم پاسخ می‌دهیم."),
    });
    expect(fabricated.verification).not.toBeNull();
    expect(fabricated.verification?.supportRatio).toBeLessThan(0.6);
    // The caller hears the retrieved excerpts, not the invented opening hours.
    expect(fabricated.reply).toContain("شنبه");
    expect(fabricated.reply).not.toContain("بیست و چهار ساعته");
    expect(fabricated.retrieval?.id).toBeTruthy();

    // A grounded answer passes through unchanged.
    const grounded = await runAgentTurn({
      businessId: business.id,
      userMessage: "ساعت کاری شما چیست؟",
      requestId: crypto.randomUUID(),
      llm: new ScriptedLLM("ساعت کاری مجموعه از شنبه تا چهارشنبه ۹ تا ۱۷ است و پنجشنبه تعطیل است."),
    });
    expect(grounded.verification?.verdict).toBe("grounded");
    expect(grounded.reply).toContain("شنبه تا چهارشنبه");
  });

  itDb("keeps a private document out of the agent turn entirely", async () => {
    const business = await createBusiness(`AclTurn ${crypto.randomUUID().slice(0, 8)}`);
    const { user } = await createUser(business.id, "ADMIN");
    const { agents } = await import("@/db/schema");
    const agent = await createAgent(business.id);
    await db.update(agents).set({ configuration: { retrievalMode: "automatic" } }).where(eq(agents.id, agent.id));
    const secret = "پرونده محرمانه ۹۹۸۸ برای مدیر ارشد";
    await seedDoc(business.id, secret, { visibility: "PRIVATE", acl: { userIds: [user.id] } });
    // Only the private document exists, so any retrieval would have to leak it.
    const turn = await runAgentTurn({
      businessId: business.id,
      userMessage: "پرونده محرمانه چیست؟",
      requestId: crypto.randomUUID(),
      llm: new ScriptedLLM("در حال حاضر اطلاعی ندارم."),
    });
    expect(turn.reply).not.toContain("۹۹۸۸");
    expect(turn.retrieval?.documents ?? 0).toBe(0);
  });
});
