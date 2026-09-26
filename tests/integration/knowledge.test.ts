import { afterAll, beforeAll, describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { knowledgeChunks, knowledgeDocuments } from "@/db/schema";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createBusiness, createKnowledgeDoc } from "../helpers/fixtures";

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
    const result = await hybridSearch({ businessId, query: "آپارتمان سعادت‌آباد", topK: 5 });
    // In CI without embedding keys, the provider throws → degraded keyword mode.
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].content).toContain("سعادت‌آباد");
  });

  itDb("returns empty results for unrelated queries", async () => {
    const { hybridSearch } = await import("@/lib/services/knowledge");
    const result = await hybridSearch({ businessId, query: "zxqv-unrelated-terms-here", topK: 5 });
    expect(result.chunks).toEqual([]);
  });

  itDb("deletes documents with their chunks", async () => {
    const { deleteDocument } = await import("@/lib/services/knowledge");
    const [doc] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, businessId)).limit(1);
    await deleteDocument(businessId, doc.id);
    const remaining = await db.select().from(knowledgeChunks).where(eq(knowledgeChunks.documentId, doc.id));
    expect(remaining).toEqual([]);
  });
});
