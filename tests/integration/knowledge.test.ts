import { afterAll, beforeAll, describe, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { knowledgeChunks, knowledgeDocuments } from "@/db/schema";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createBusiness, createKnowledgeDoc } from "../helpers/fixtures";
import { runtimePrincipal } from "@/lib/rag/access";

const runIntegration = hasTestDatabase();

describe.skipIf(!runIntegration)("knowledge retrieval (real database)", () => {
  let businessId: string;

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    businessId = (await createBusiness("KB Biz")).id;
    const doc = await createKnowledgeDoc(businessId, "آپارتمان ۱۲۰ متری در سعادت‌آباد با قیمت مناسب موجود است.");
    // Seed a chunk directly (no embedding provider needed for keyword mode).
    await db.insert(knowledgeChunks).values({
      businessId,
      documentId: doc.id,
      chunkIndex: 0,
      content: "آپارتمان ۱۲۰ متری در سعادت‌آباد با قیمت مناسب موجود است.",
      tokenCount: 20,
      metadata: {},
    });
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  itDb("falls back to keyword search when embeddings are unavailable (degraded)", async () => {
    const { hybridSearch } = await import("@/lib/services/knowledge");
    const result = await hybridSearch({
      businessId,
      query: "آپارتمان سعادت‌آباد",
      topK: 5,
      scope: { principal: runtimePrincipal(), filters: { tags: [], includeDrafts: false } },
    });
    // In CI without embedding keys, the provider throws → degraded keyword mode.
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].content).toContain("سعادت‌آباد");
  });

  itDb("returns empty results for unrelated queries", async () => {
    const { hybridSearch } = await import("@/lib/services/knowledge");
    const result = await hybridSearch({
      businessId,
      query: "zxqv-unrelated-terms-here",
      topK: 5,
      scope: { principal: runtimePrincipal(), filters: { tags: [], includeDrafts: false } },
    });
    expect(result.chunks).toEqual([]);
  });

  itDb("ranks keyword hits by term match-count, not recency", async () => {
    const { hybridSearch } = await import("@/lib/services/knowledge");
    const biz = await createBusiness("RRF Kw Biz");
    const doc = await createKnowledgeDoc(biz.id, "rrf keyword doc");
    const seed = async (content: string, index: number) => {
      const [row] = await db
        .insert(knowledgeChunks)
        .values({ businessId: biz.id, documentId: doc.id, chunkIndex: index, content, tokenCount: 20, metadata: {} })
        .returning();
      return row;
    };
    // Best match inserted FIRST (oldest): recency must not win.
    const all = await seed("آپارتمان فروشی در تهران با سند آماده", 0);
    const two = await seed("آپارتمان در تهران", 1);
    const one = await seed("آپارتمان نوساز", 2);
    const result = await hybridSearch({
      businessId: biz.id,
      query: "آپارتمان تهران فروشی",
      topK: 5,
      scope: { principal: runtimePrincipal(), filters: { tags: [], includeDrafts: false } },
    });
    expect(result.degraded).toBe(true); // dev embedding provider throws in tests
    expect(result.chunks.map((c) => c.id)).toEqual([all.id, two.id, one.id]);
    expect(result.chunks.map((c) => c.source)).toEqual(["keyword", "keyword", "keyword"]);
    // Single-list fusion: RRF scores follow keyword rank.
    expect(result.chunks[0].score).toBeCloseTo(1 / 61, 10);
    expect(result.chunks[1].score).toBeCloseTo(1 / 62, 10);
    expect(result.chunks[2].score).toBeCloseTo(1 / 63, 10);
  });

  itDb("fuses vector and keyword ranks with RRF over real pgvector", async () => {
    const { hybridSearch } = await import("@/lib/services/knowledge");
    const { expectedEmbeddingDimensions } = await import("@/lib/providers/embeddings");
    const dims = expectedEmbeddingDimensions();
    const unit = (i: number) => Array.from({ length: dims }, (_, j) => (j === i ? 1 : 0));
    const queryVec = unit(0);
    // Unit vector with cosine 0.9 against the query vector.
    const mixed = Array.from({ length: dims }, (_, j) =>
      j === 0 ? 0.9 : j === 1 ? Math.sqrt(1 - 0.81) : 0,
    );
    const biz = await createBusiness("RRF Fuse Biz");
    const doc = await createKnowledgeDoc(biz.id, "rrf fuse doc");
    const seed = async (content: string, index: number, embedding: number[]) => {
      const [row] = await db
        .insert(knowledgeChunks)
        .values({ businessId: biz.id, documentId: doc.id, chunkIndex: index, content, tokenCount: 20, metadata: {} })
        .returning();
      await db.execute(sql`UPDATE knowledge_chunks SET embedding = ${`[${embedding.join(",")}]`}::vector WHERE id = ${row.id}`);
      return row;
    };
    // V1: vector #1 (sim 1.0), keyword #2 (2/3 terms).
    const v1 = await seed("آپارتمان در تهران", 0, queryVec);
    // B: vector #2 (sim 0.9), keyword #3 (1/3 terms).
    const b = await seed("آپارتمان نوساز", 1, mixed);
    // K1: keyword #1 (3/3 terms), orthogonal embedding → filtered from vector list.
    const k1 = await seed("آپارتمان فروشی در تهران با سند آماده", 2, unit(1));
    const result = await hybridSearch({
      businessId: biz.id,
      query: "آپارتمان تهران فروشی",
      topK: 5,
      embed: async () => queryVec,
      scope: { principal: runtimePrincipal(), filters: { tags: [], includeDrafts: false } },
    });
    expect(result.degraded).toBe(false);
    // V1 = 1/61+1/62 ≈ 0.03252 > B = 1/62+1/63 ≈ 0.03200 > K1 = 1/61 ≈ 0.01639.
    expect(result.chunks.map((c) => c.id)).toEqual([v1.id, b.id, k1.id]);
    expect(result.chunks.map((c) => c.source)).toEqual(["both", "both", "keyword"]);
    expect(result.chunks[0].score).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(result.chunks[1].score).toBeCloseTo(1 / 62 + 1 / 63, 10);
    expect(result.chunks[2].score).toBeCloseTo(1 / 61, 10);
  });

  itDb("deletes documents with their chunks", async () => {
    const { deleteDocument } = await import("@/lib/services/knowledge");
    const [doc] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, businessId)).limit(1);
    await deleteDocument(businessId, doc.id);
    const remaining = await db.select().from(knowledgeChunks).where(eq(knowledgeChunks.documentId, doc.id));
    expect(remaining).toEqual([]);
  });
});
