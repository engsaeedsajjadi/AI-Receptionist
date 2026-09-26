import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeChunks, knowledgeDocuments } from "@/db/schema";
import {
  chunkText,
  cleanText,
  estimateTokens,
  extractText,
  validateUpload,
  type SupportedDocType,
} from "@/lib/documents";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { logInfo, logWarn } from "@/lib/logger";
import { normalizeForSearch, normalizePersianText } from "@/lib/normalization";
import { expectedEmbeddingDimensions, getEmbeddingProvider } from "@/lib/providers/embeddings";
import { getStorageProvider, tenantKey } from "@/lib/providers/storage";
import { recordEmbeddingUsage } from "@/lib/services/usage";

export type IngestFileInput = {
  businessId: string;
  title?: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
  requestId?: string;
};

export type IngestContentInput = {
  businessId: string;
  title: string;
  content: string;
  sourceType?: string;
  sourceUrl?: string;
  requestId?: string;
};

function assertDimensions(embedding: number[]): void {
  const expected = expectedEmbeddingDimensions();
  if (embedding.length !== expected) {
    throw new AppError(
      500,
      "EMBEDDING_ERROR",
      `Embedding dimension mismatch: got ${embedding.length}, expected ${expected}. ` +
        `The embedding model changed — update EMBEDDING_DIMENSIONS and migrate the pgvector column.`,
    );
  }
}

async function embedAndStore(input: {
  businessId: string;
  documentId: string;
  chunks: Array<{ content: string; index: number; tokenCount: number }>;
  requestId?: string;
}): Promise<{ embedded: number; tokens: number }> {
  if (input.chunks.length === 0) return { embedded: 0, tokens: 0 };
  const provider = getEmbeddingProvider();
  const results = await provider.embedMany(
    input.chunks.map((c) => c.content),
    { requestId: input.requestId },
  );
  if (results.length !== input.chunks.length) {
    throw new AppError(502, "EMBEDDING_ERROR", "Embedding provider returned an incomplete batch");
  }
  let tokens = 0;
  const rows = results.map((r, i) => {
    assertDimensions(r.embedding);
    tokens += r.usage.embeddingTokens ?? estimateTokens(input.chunks[i].content);
    return {
      businessId: input.businessId,
      documentId: input.documentId,
      chunkIndex: input.chunks[i].index,
      content: input.chunks[i].content,
      embedding: r.embedding,
      tokenCount: input.chunks[i].tokenCount,
      metadata: { model: r.model },
    };
  });
  await db.insert(knowledgeChunks).values(rows);
  await recordEmbeddingUsage({
    businessId: input.businessId,
    tokens,
    provider: provider.name,
    idempotencyKey: `embed:${input.documentId}`,
    metadata: { documentId: input.documentId, chunks: rows.length },
  });
  return { embedded: rows.length, tokens };
}

/**
 * Full ingestion pipeline for binary uploads:
 * validate → extract → clean → normalize → chunk → embed → store (+archive original).
 */
export async function ingestFile(input: IngestFileInput) {
  const validated = validateUpload({ filename: input.filename, mimeType: input.mimeType, size: input.buffer.length });
  const { text, pages } = await extractText(input.buffer, validated.docType);
  const cleaned = cleanText(text);
  if (cleaned.length < 20) {
    throw new AppError(400, "VALIDATION_ERROR", "No extractable text found in the uploaded file");
  }

  const [doc] = await db
    .insert(knowledgeDocuments)
    .values({
      businessId: input.businessId,
      title: normalizePersianText(input.title ?? validated.filename),
      sourceType: validated.docType,
      fileName: validated.filename,
      mimeType: validated.mimeType,
      fileSize: validated.size,
      status: "indexing",
      content: cleaned.slice(0, 500_000),
      metadata: { pages: pages ?? null },
    })
    .returning();

  try {
    const chunks = chunkText(cleaned);
    const { embedded } = await embedAndStore({
      businessId: input.businessId,
      documentId: doc.id,
      chunks,
      requestId: input.requestId,
    });

    // Archive the original file (best effort — extracted content is already stored).
    let storageKey: string | null = null;
    try {
      storageKey = tenantKey(input.businessId, "knowledge", doc.id, validated.filename);
      await getStorageProvider().upload({ key: storageKey, data: input.buffer, contentType: validated.mimeType });
    } catch (err) {
      logWarn("Knowledge original archival failed (content already indexed)", {
        requestId: input.requestId,
        businessId: input.businessId,
        operation: "knowledge.archive",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      storageKey = null;
    }

    const [updated] = await db
      .update(knowledgeDocuments)
      .set({ status: "indexed", chunkCount: embedded, storageKey, updatedAt: new Date() })
      .where(eq(knowledgeDocuments.id, doc.id))
      .returning();

    logInfo("Knowledge document indexed", {
      requestId: input.requestId,
      businessId: input.businessId,
      operation: "knowledge.ingest",
      status: "ok",
    });
    return { document: updated, chunks: embedded };
  } catch (err) {
    await db
      .update(knowledgeDocuments)
      .set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message.slice(0, 1000) : "indexing_failed",
        updatedAt: new Date(),
      })
      .where(eq(knowledgeDocuments.id, doc.id));
    throw err;
  }
}

/** Ingestion for manual/pasted text content (same chunk+embed pipeline). */
export async function ingestContent(input: IngestContentInput) {
  const cleaned = cleanText(input.content);
  if (cleaned.length < 20) {
    throw new AppError(400, "VALIDATION_ERROR", "Content is too short to index");
  }
  const [doc] = await db
    .insert(knowledgeDocuments)
    .values({
      businessId: input.businessId,
      title: normalizePersianText(input.title),
      sourceType: input.sourceType ?? "manual",
      sourceUrl: input.sourceUrl ?? null,
      status: "indexing",
      content: cleaned.slice(0, 500_000),
    })
    .returning();
  try {
    const chunks = chunkText(cleaned);
    const { embedded } = await embedAndStore({
      businessId: input.businessId,
      documentId: doc.id,
      chunks,
      requestId: input.requestId,
    });
    const [updated] = await db
      .update(knowledgeDocuments)
      .set({ status: "indexed", chunkCount: embedded, updatedAt: new Date() })
      .where(eq(knowledgeDocuments.id, doc.id))
      .returning();
    return { document: updated, chunks: embedded };
  } catch (err) {
    await db
      .update(knowledgeDocuments)
      .set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message.slice(0, 1000) : "indexing_failed",
        updatedAt: new Date(),
      })
      .where(eq(knowledgeDocuments.id, doc.id));
    throw err;
  }
}

/** Re-chunk + re-embed an existing document from its stored content. */
export async function reindexDocument(businessId: string, documentId: string, opts?: { requestId?: string }) {
  const [doc] = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.businessId, businessId)))
    .limit(1);
  if (!doc) throw new AppError(404, "KNOWLEDGE_NOT_FOUND", "Document not found");

  await db
    .update(knowledgeDocuments)
    .set({ status: "indexing", errorMessage: null, updatedAt: new Date() })
    .where(eq(knowledgeDocuments.id, doc.id));
  try {
    await db.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, doc.id));
    const chunks = chunkText(cleanText(doc.content));
    const { embedded } = await embedAndStore({ businessId, documentId: doc.id, chunks, requestId: opts?.requestId });
    const [updated] = await db
      .update(knowledgeDocuments)
      .set({ status: "indexed", chunkCount: embedded, updatedAt: new Date() })
      .where(eq(knowledgeDocuments.id, doc.id))
      .returning();
    return { document: updated, chunks: embedded };
  } catch (err) {
    await db
      .update(knowledgeDocuments)
      .set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message.slice(0, 1000) : "indexing_failed",
        updatedAt: new Date(),
      })
      .where(eq(knowledgeDocuments.id, doc.id));
    throw err;
  }
}

export async function deleteDocument(businessId: string, documentId: string): Promise<void> {
  const [doc] = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.businessId, businessId)))
    .limit(1);
  if (!doc) throw new AppError(404, "KNOWLEDGE_NOT_FOUND", "Document not found");
  await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, doc.id));
  if (doc.storageKey) {
    try {
      await getStorageProvider().delete(doc.storageKey);
    } catch (err) {
      logWarn("Knowledge storage cleanup failed", {
        businessId,
        operation: "knowledge.delete",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Hybrid retrieval: vector similarity + keyword search + tenant filtering
// ---------------------------------------------------------------------------

export type RetrievedChunk = {
  id: string;
  documentId: string;
  documentTitle: string;
  content: string;
  score: number;
  source: "vector" | "keyword";
};

function escapeLike(pattern: string): string {
  return pattern.replace(/[\\%_]/g, (c) => `\\${c}`);
}

type VectorRow = {
  id: string;
  document_id: string;
  content: string;
  title: string;
  similarity: string | number;
};

async function vectorSearch(businessId: string, embedding: number[], limit: number): Promise<RetrievedChunk[]> {
  const literal = `[${embedding.join(",")}]`;
  const rows = await db.execute<VectorRow>(sql`
    SELECT kc.id, kc.document_id, kc.content, kd.title,
           1 - (kc.embedding <=> ${literal}::vector) AS similarity
    FROM knowledge_chunks kc
    JOIN knowledge_documents kd ON kd.id = kc.document_id
    WHERE kc.business_id = ${businessId}
      AND kd.business_id = ${businessId}
      AND kc.embedding IS NOT NULL
    ORDER BY kc.embedding <=> ${literal}::vector
    LIMIT ${limit}
  `);
  const list = (rows as unknown as { rows?: VectorRow[] }).rows ?? (rows as unknown as VectorRow[]);
  return (Array.isArray(list) ? list : []).map((r) => ({
    id: r.id,
    documentId: r.document_id,
    documentTitle: r.title,
    content: r.content,
    score: Number(r.similarity),
    source: "vector" as const,
  }));
}

async function keywordSearch(businessId: string, query: string, limit: number): Promise<RetrievedChunk[]> {
  const normalized = normalizeForSearch(query);
  const terms = normalized.split(" ").filter((t) => t.length >= 2).slice(0, 8);
  if (terms.length === 0) return [];
  const termConditions = terms.map((t) => ilike(knowledgeChunks.content, `%${escapeLike(t)}%`));
  const rows = await db
    .select({
      id: knowledgeChunks.id,
      documentId: knowledgeChunks.documentId,
      content: knowledgeChunks.content,
      title: knowledgeDocuments.title,
    })
    .from(knowledgeChunks)
    .innerJoin(knowledgeDocuments, eq(knowledgeChunks.documentId, knowledgeDocuments.id))
    .where(
      and(
        eq(knowledgeChunks.businessId, businessId),
        eq(knowledgeDocuments.businessId, businessId),
        or(...termConditions),
      ),
    )
    .orderBy(desc(knowledgeChunks.createdAt))
    .limit(limit);
  return rows.map((r, i) => ({
    id: r.id,
    documentId: r.documentId,
    documentTitle: r.title,
    content: r.content,
    score: 0.5 - i * 0.01, // keyword hits rank below vector hits
    source: "keyword" as const,
  }));
}

export async function hybridSearch(input: {
  businessId: string;
  query: string;
  topK?: number;
  minSimilarity?: number;
  requestId?: string;
}): Promise<{ chunks: RetrievedChunk[]; degraded: boolean }> {
  const topK = Math.min(input.topK ?? 5, 20);
  const minSimilarity = input.minSimilarity ?? 0.25;
  const normalized = normalizePersianText(input.query);
  if (!normalized) return { chunks: [], degraded: false };

  let vectorResults: RetrievedChunk[] = [];
  let degraded = false;
  try {
    const provider = getEmbeddingProvider();
    const { embedding } = await provider.embed(normalized, { requestId: input.requestId });
    assertDimensions(embedding);
    vectorResults = (await vectorSearch(input.businessId, embedding, topK)).filter((r) => r.score >= minSimilarity);
  } catch (err) {
    // Degraded mode: embedding unavailable → keyword-only retrieval.
    degraded = true;
    logWarn("Vector search unavailable, falling back to keyword search", {
      requestId: input.requestId,
      businessId: input.businessId,
      operation: "knowledge.search",
      status: "degraded",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const keywordResults = await keywordSearch(input.businessId, normalized, topK);

  // Merge → deduplicate (vector wins) → rerank by score → top K.
  const seen = new Set<string>();
  const merged: RetrievedChunk[] = [];
  for (const r of [...vectorResults, ...keywordResults]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  merged.sort((a, b) => b.score - a.score);
  return { chunks: merged.slice(0, topK), degraded };
}

export async function getDocument(businessId: string, documentId: string) {
  const [doc] = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.businessId, businessId)))
    .limit(1);
  if (!doc) throw new AppError(404, "KNOWLEDGE_NOT_FOUND", "Document not found");
  return doc;
}

export function supportedDocTypes(): SupportedDocType[] {
  return ["PDF", "DOCX", "TXT", "MARKDOWN"];
}

export function uploadConstraints() {
  const e = getEnv();
  return {
    maxBytes: e.MAX_UPLOAD_BYTES,
    allowedMime: e.ALLOWED_UPLOAD_MIME.split(",").map((m) => m.trim()),
    supportedTypes: supportedDocTypes(),
  };
}
