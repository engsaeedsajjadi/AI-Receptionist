import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { knowledgeChunks, knowledgeDocuments, retrievalEvents, users } from "@/db/schema";
import {
  canAccessDocument,
  knowledgeAccessPredicate,
  knowledgeLifecyclePredicate,
  knowledgeMetadataPredicate,
  RetrievalPrincipalSchema,
} from "@/lib/rag/access";
import {
  archiveDocument,
  documentChunkCount,
  listDocumentVersions,
  markEvidenceUsed,
  publishDocumentVersion,
  recordRetrievalEvent,
  retrievalAnalytics,
  searchKnowledgeGoverned,
  updateDocumentGovernance,
} from "@/lib/services/knowledge-governance";
import { HttpReranker, LexicalReranker, rerankerFromEnv, rerankWithFallback } from "@/lib/providers/reranker";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/** Deterministic embedding used instead of a live provider (dimension = 1536). */
const embed = async (): Promise<number[]> => {
  const vector = new Array(1536).fill(0);
  vector[0] = 1;
  return vector;
};

async function tenant(role: "ADMIN" | "AGENT" = "ADMIN") {
  const business = await createBusiness();
  const { user } = await createUser(business.id, "ADMIN");
  if (role !== "ADMIN") await db.update(users).set({ role }).where(eq(users.id, user.id));
  return { business, user };
}

async function seedDocument(businessId: string, overrides: Partial<typeof knowledgeDocuments.$inferInsert> = {}) {
  const [doc] = await db
    .insert(knowledgeDocuments)
    // Published documents are ACTIVE; drafts are seeded explicitly by a test.
    .values({ businessId, title: "سند دانش", content: "محتوای سند", status: "indexed", lifecycle: "ACTIVE", sourceType: "manual", ...overrides })
    .returning();
  return doc;
}

async function seedChunk(businessId: string, documentId: string, content: string, index = 0) {
  await db.insert(knowledgeChunks).values({ businessId, documentId, chunkIndex: index, content, tokenCount: content.length, metadata: {} });
}

describe.skipIf(!hasTestDatabase())("knowledge governance", () => {
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

  itDb("updates governance metadata and refuses cross-tenant writes", async () => {
    const a = await tenant();
    const b = await tenant();
    const doc = await seedDocument(a.business.id);
    const updated = await updateDocumentGovernance(a.business.id, doc.id, {
      visibility: "ROLE",
      acl: { roles: ["MANAGER"] },
      language: "fa",
      category: "پشتیبانی",
      tags: ["billing", "faq"],
      effectiveFrom: new Date().toISOString(),
      effectiveUntil: null,
    });
    expect(updated).toMatchObject({ visibility: "ROLE", language: "fa", tags: ["billing", "faq"] });
    await expect(updateDocumentGovernance(b.business.id, doc.id, { visibility: "TENANT" })).rejects.toMatchObject({ status: 404 });
    await expect(updateDocumentGovernance(a.business.id, doc.id, { visibility: "PUBLIC" as never })).rejects.toMatchObject({ status: 400 });
  });

  itDb("versions a document as a new blessed copy and keeps history immutable", async () => {
    const { business, user } = await tenant();
    const doc = await seedDocument(business.id, { content: "نسخه یک قرارداد اجاره" });
    const published = await publishDocumentVersion({
      businessId: business.id,
      documentId: doc.id,
      content: "نسخه دو قرارداد اجاره با الحاقیه",
      actorId: user.id,
      // Ingestion is injected: the embedding provider is not available in CI and
      // the versioning logic must not depend on it.
      ingest: async (args) => {
        const created = await seedDocument(args.businessId, { title: args.title, content: args.content, version: 2 });
        await seedChunk(args.businessId, created.id, args.content);
        return { document: { id: created.id, version: 2 }, chunks: 1 };
      },
    });
    expect(published.version).toBe(2);
    const [previous] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, doc.id));
    expect(previous.lifecycle).toBe("ARCHIVED");
    expect(previous.content).toBe("نسخه یک قرارداد اجاره");

    const versions = await listDocumentVersions(business.id, doc.id);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    await expect(listDocumentVersions(business.id, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ status: 404 });
  });

  itDb("archives documents and reports chunk counts per tenant", async () => {
    const a = await tenant();
    const b = await tenant();
    const doc = await seedDocument(a.business.id);
    await seedChunk(a.business.id, doc.id, "بخش اول");
    await seedChunk(a.business.id, doc.id, "بخش دوم", 1);
    expect(await documentChunkCount(a.business.id, doc.id)).toBe(2);
    expect(await documentChunkCount(b.business.id, doc.id)).toBe(0);
    const archived = await archiveDocument(a.business.id, doc.id);
    expect(archived.lifecycle).toBe("ARCHIVED");
    await expect(archiveDocument(b.business.id, doc.id)).rejects.toMatchObject({ status: 404 });
  });

  itDb("retrieves only what the principal may see (ACL enforcement)", async () => {
    const { business, user } = await tenant();
    const publicDoc = await seedDocument(business.id, { title: "عمومی", visibility: "TENANT" });
    await seedChunk(business.id, publicDoc.id, "ساعت کاری شعبه مرکزی نُه تا هجده است");
    const managerDoc = await seedDocument(business.id, { title: "مدیران", visibility: "ROLE", acl: { roles: ["MANAGER"] } });
    await seedChunk(business.id, managerDoc.id, "تخفیف مدیریتی ویژه نمایندگان");
    const privateDoc = await seedDocument(business.id, { title: "خصوصی", visibility: "PRIVATE", acl: { userIds: [user.id] } });
    await seedChunk(business.id, privateDoc.id, "یادداشت خصوصی مدیر عامل درباره قرارداد");
    const draft = await seedDocument(business.id, { title: "پیش‌نویس", lifecycle: "DRAFT" });
    await seedChunk(business.id, draft.id, "پیش‌نویس منتشر نشده قیمت‌گذاری");

    const asAgent = await searchKnowledgeGoverned({
      businessId: business.id,
      query: "قرارداد تخفیف ساعت کاری",
      principal: { role: "AGENT", userId: user.id, agentId: null, platformSupport: false },
      topK: 10,
      embed,
    });
    const titles = asAgent.chunks.map((chunk) => chunk.documentId);
    expect(titles).not.toContain(managerDoc.id);
    expect(titles).not.toContain(draft.id);

    const asManager = await searchKnowledgeGoverned({
      businessId: business.id,
      query: "تخفیف مدیریتی",
      principal: { role: "MANAGER", userId: null, agentId: null, platformSupport: false },
      topK: 10,
      embed,
    });
    expect(asManager.chunks.map((chunk) => chunk.documentId)).toContain(managerDoc.id);
    // Drafts stay invisible unless explicitly requested by an admin.
    expect(asManager.chunks.map((chunk) => chunk.documentId)).not.toContain(draft.id);
    const withDrafts = await searchKnowledgeGoverned({
      businessId: business.id,
      query: "پیش‌نویس قیمت‌گذاری",
      principal: { role: "ADMIN", userId: user.id, agentId: null, platformSupport: false },
      filters: { includeDrafts: true },
      topK: 5,
      embed,
    });
    expect(withDrafts.chunks.map((chunk) => chunk.documentId)).toContain(draft.id);
  });

  itDb("records retrieval analytics and evidence usage per tenant", async () => {
    const a = await tenant();
    const b = await tenant();
    const doc = await seedDocument(a.business.id);
    await seedChunk(a.business.id, doc.id, "پاسخ سوال مشتری");
    const unused = await seedDocument(a.business.id, { title: "سند بی‌استفاده" });
    await seedChunk(a.business.id, unused.id, "پاسخ سوال پشتیبانی درباره فاکتور");
    const result = await searchKnowledgeGoverned({
      businessId: a.business.id,
      query: "پاسخ سوال",
      principal: { role: "ADMIN", userId: null, agentId: null, platformSupport: false },
      topK: 3,
      embed,
    });
    expect(result.retrievalId).toBeTruthy();
    expect(await markEvidenceUsed(a.business.id, result.retrievalId!, result.documentIds.slice(0, 1))).toBe(true);
    // Evidence usage is recorded once; a second call must not overwrite it.
    expect(await markEvidenceUsed(a.business.id, result.retrievalId!, [])).toBe(false);
    const events = await db.select().from(retrievalEvents).where(eq(retrievalEvents.businessId, a.business.id));
    expect(events).toHaveLength(1);
    expect(events[0].usedDocumentIds.length).toBeGreaterThan(0);
    expect(events[0].reranker).toBeTruthy();

    await recordRetrievalEvent(a.business.id, {
      query: "بدون نتیجه",
      candidateIds: [],
      usedIds: [],
      retrievalMs: 12,
      rerankMs: null,
      reranker: null,
      outcome: "failed",
    });
    const analytics = await retrievalAnalytics(a.business.id, { days: 7 });
    expect(analytics).toMatchObject({ windowDays: 7, queries: 2, zeroResultQueries: 1, failedQueries: 1 });
    expect(analytics.zeroResultRate).toBeCloseTo(0.5, 2);
    expect(analytics.unusedRetrievedEvidence).toBeGreaterThanOrEqual(1);
    expect(analytics.answerWithEvidenceRate).toBeCloseTo(0.5, 2);
    expect(Object.keys(analytics.topDocuments).length).toBeGreaterThan(0);
    // Other tenants never see these analytics.
    const other = await retrievalAnalytics(b.business.id);
    expect(other.queries).toBe(0);
    await expect(retrievalAnalytics(a.business.id, { days: 365 })).rejects.toMatchObject({ status: 400 });
    expect(await markEvidenceUsed(b.business.id, result.retrievalId!, result.documentIds)).toBe(false);
  });

  itDb("exposes SQL predicates that never widen access", async () => {
    const { business, user } = await tenant();
    const doc = await seedDocument(business.id, { title: "مقایسه predicates" });
    const principal = RetrievalPrincipalSchema.parse({ role: "AGENT", userId: user.id });
    const rows = await db
      .select({ id: knowledgeDocuments.id })
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.businessId, business.id),
          knowledgeLifecyclePredicate({ tags: [], includeDrafts: false }),
          knowledgeAccessPredicate(principal),
          knowledgeMetadataPredicate({ tags: [], includeDrafts: false }),
        ),
      );
    expect(rows.map((row) => row.id)).toContain(doc.id);
    const agentPrincipal = { role: "AGENT", userId: null, agentId: null, platformSupport: false };
    expect(canAccessDocument(principal, { visibility: doc.visibility, acl: doc.acl, category: doc.category, department: doc.department })).toBe(true);
    expect(canAccessDocument(agentPrincipal, { visibility: "PRIVATE", acl: { userIds: [crypto.randomUUID()] } })).toBe(false);
    expect(canAccessDocument(agentPrincipal, { visibility: "TENANT", acl: {} })).toBe(true);
    expect(canAccessDocument(agentPrincipal, { visibility: "ROLE", acl: { roles: ["MANAGER"] } })).toBe(false);
    expect(canAccessDocument({ ...agentPrincipal, role: "MANAGER" }, { visibility: "ROLE", acl: { roles: ["MANAGER"] } })).toBe(true);
    expect(canAccessDocument({ ...agentPrincipal, agentId: crypto.randomUUID() }, { visibility: "AGENT", acl: { agentIds: [] } })).toBe(false);
    expect(canAccessDocument(agentPrincipal, { visibility: "CATEGORY", acl: { categories: ["پشتیبانی"] }, category: "پشتیبانی" })).toBe(true);
    expect(canAccessDocument(agentPrincipal, { visibility: "CATEGORY", acl: { categories: ["پشتیبانی"] }, category: "فروش" })).toBe(false);
  });
});

describe.skipIf(!hasTestDatabase())("reranking", () => {
  itDb("lexical reranker orders by term overlap and honours topN", async () => {
    const reranker = new LexicalReranker();
    const candidates = [
      { id: "1", documentId: "d1", content: "قیمت اجاره آپارتمان در سعادت‌آباد", score: 0.2 },
      { id: "2", documentId: "d2", content: "ساعت کاری دفتر", score: 0.9 },
    ];
    const ranked = await reranker.rerank("قیمت اجاره آپارتمان", candidates);
    expect(ranked[0].id).toBe("1");
    expect(await reranker.rerank("قیمت اجاره", candidates, { topN: 1 })).toHaveLength(1);
    // A query with no usable terms keeps the incoming order.
    expect((await reranker.rerank("x", candidates)).map((c) => c.id)).toEqual(["1", "2"]);
  });

  itDb("fallback reranker never fails closed on a provider error", async () => {
    const failing = {
      name: "broken",
      model: "broken-v1",
      rerank: async () => {
        throw new Error("provider exploded");
      },
    };
    const candidates = [
      { id: "1", documentId: "d1", content: "یک", score: 0.5 },
      { id: "2", documentId: "d2", content: "دو", score: 0.4 },
    ];
    const result = await rerankWithFallback({ query: "یک", candidates, provider: failing as never, topN: 2 });
    expect(result.usedFallback).toBe(true);
    expect(result.provider).toBe("rrf");
    expect(result.candidates.map((c) => c.id)).toEqual(["1", "2"]);

    const lexical = await rerankWithFallback({ query: "یک", candidates, provider: new LexicalReranker(), topN: 2 });
    expect(lexical.usedFallback).toBe(false);
    expect(lexical.provider).toBe("lexical");
    // No provider configured → RRF order preserved, marked as not degraded.
    const none = await rerankWithFallback({ query: "یک", candidates, provider: null, topN: 2 });
    expect(none.candidates.map((c) => c.id)).toEqual(["1", "2"]);
  });

  itDb("http reranker parses provider responses and degrades on failure", async () => {
    const provider = new HttpReranker({ baseURL: "https://rerank.example.com", apiKey: "k", model: "m", timeoutMs: 500 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.99 }, { index: 0, relevance_score: 0.1 }] }), { status: 200 })) as unknown as typeof fetch;
    const ranked = await provider.rerank("q", [
      { id: "1", documentId: "d1", content: "a", score: 0.5 },
      { id: "2", documentId: "d2", content: "b", score: 0.4 },
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["2", "1"]);

    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(provider.rerank("q", [])).rejects.toThrow();
    globalThis.fetch = originalFetch;
    expect(rerankerFromEnv()).toBeNull();
  });
});
