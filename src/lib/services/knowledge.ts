import { meteredEmbeddings } from "@/lib/services/metered-ai";
import { requireTenantFeature } from "@/lib/tenant-config";
import { assertTenantScope } from "@/lib/request-context";
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
import { knowledgeAccessPredicate, knowledgeLifecyclePredicate, knowledgeMetadataPredicate, type KnowledgeMetadataFilters, type RetrievalPrincipal } from "@/lib/rag/access";
import { recordStoredObjectStandalone, forgetStoredObjectStandalone } from "@/lib/services/storage-usage";
import { malwarePolicy, scanUpload } from "@/lib/services/identity-provisioning";
import { enqueueOutbox } from "@/lib/services/outbox";

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
  const results = await meteredEmbeddings(input.businessId, provider,
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
 * Record a rejected upload: the document row stays `failed` (retrieval only ever
 * reads `indexed` documents, so it can never be searched), the verdict is kept in
 * metadata, and the original is archived best-effort for evidence.
 */
async function quarantineRejectedUpload(input: {
  businessId: string;
  validated: ReturnType<typeof validateUpload>;
  buffer: Buffer;
  title?: string;
  errorMessage: string;
  scan: Record<string, unknown>;
  requestId?: string;
}): Promise<void> {
  const [doc] = await db
    .insert(knowledgeDocuments)
    .values({
      businessId: input.businessId,
      title: normalizePersianText(input.title ?? input.validated.filename),
      sourceType: input.validated.docType,
      fileName: input.validated.filename,
      mimeType: input.validated.mimeType,
      fileSize: input.validated.size,
      status: "failed",
      // Never indexed (retrieval reads only `indexed` rows), kept for the audit
      // trail with the reason it was refused.
      content: "",
      errorMessage: input.errorMessage.slice(0, 1000),
      metadata: { malwareScan: input.scan, quarantined: true },
    })
    .returning({ id: knowledgeDocuments.id });
  try {
    const key = tenantKey(input.businessId, "quarantine", doc.id, input.validated.filename);
    await getStorageProvider().upload({ key, data: input.buffer, contentType: input.validated.mimeType });
    await recordStoredObjectStandalone({
      businessId: input.businessId,
      key,
      bytes: input.buffer.length,
      contentType: input.validated.mimeType,
      category: "knowledge",
      sourceType: "knowledge_quarantine",
      sourceId: doc.id,
    });
    await db.update(knowledgeDocuments).set({ storageKey: key, updatedAt: new Date() }).where(eq(knowledgeDocuments.id, doc.id));
  } catch (err) {
    logWarn("Quarantined upload could not be archived", {
      requestId: input.requestId,
      businessId: input.businessId,
      operation: "knowledge.quarantine",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Full ingestion pipeline for binary uploads:
 * validate → scan → extract → clean → normalize → chunk → embed → store (+archive original).
 */
export async function ingestFile(input: IngestFileInput) {
  assertTenantScope(input.businessId);
  await requireTenantFeature(input.businessId, "knowledge");
  const validated = validateUpload({ filename: input.filename, mimeType: input.mimeType, size: input.buffer.length });

  // Scan before anything is extracted, archived or indexed. A verdict is part of
  // the document's provenance, and a rejected file still leaves an audit trail.
  const verdict = await scanUpload({ data: input.buffer, filename: validated.filename, contentType: validated.mimeType });
  const policy = malwarePolicy();
  const scan = {
    status: verdict.status,
    engine: verdict.engine,
    signature: verdict.signature ?? null,
    detail: verdict.detail ?? null,
    strict: policy.strict,
  };
  if (verdict.status === "infected" || (verdict.status === "unavailable" && policy.strict)) {
    const infected = verdict.status === "infected";
    await quarantineRejectedUpload({
      businessId: input.businessId,
      validated,
      buffer: input.buffer,
      title: input.title,
      errorMessage: infected
        ? `Malware signature detected: ${verdict.signature ?? "unknown"}`
        : `Malware scan unavailable (${verdict.detail ?? "unknown"}); rejected under strict policy`,
      scan,
      requestId: input.requestId,
    });
    logWarn("Knowledge upload rejected by malware policy", {
      requestId: input.requestId,
      businessId: input.businessId,
      operation: "knowledge.ingest",
      status: infected ? "infected" : "scan_unavailable",
    });
    throw infected
      ? new AppError(400, "MALWARE_DETECTED", "File rejected: malware signature detected")
      : new AppError(503, "SCANNER_UNAVAILABLE", "File could not be scanned for malware; upload rejected");
  }

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
      metadata: { pages: pages ?? null, malwareScan: scan },
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
    // Successful uploads are metered into `storage_bytes`; a rejected quota
    // rolls the accounting back with the transaction that recorded it.
    let storageKey: string | null = null;
    try {
      storageKey = tenantKey(input.businessId, "knowledge", doc.id, validated.filename);
      await getStorageProvider().upload({ key: storageKey, data: input.buffer, contentType: validated.mimeType });
      await recordStoredObjectStandalone({
        businessId: input.businessId,
        key: storageKey,
        bytes: input.buffer.length,
        contentType: validated.mimeType,
        category: "knowledge",
        sourceType: "knowledge_document",
        sourceId: doc.id,
      });
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
  assertTenantScope(input.businessId);
  await requireTenantFeature(input.businessId, "knowledge");
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
  assertTenantScope(businessId);
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
  assertTenantScope(businessId);
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
      await forgetStoredObjectStandalone(businessId, doc.storageKey);
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
  /** Which retriever(s) returned this chunk after RRF fusion. */
  source: "vector" | "keyword" | "both";
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

async function vectorSearch(businessId: string, embedding: number[], limit: number, scope?: RetrievalScope): Promise<RetrievedChunk[]> {
  const literal = `[${embedding.join(",")}]`;
  // ACL + lifecycle + metadata predicates are part of the SQL: unauthorized
  // documents never enter the candidate set (no retrieve-then-filter).
  const access = scope ? knowledgeAccessPredicate(scope.principal, "kd") : sql`TRUE`;
  const lifecycle = knowledgeLifecyclePredicate(scope?.filters ?? { tags: [], includeDrafts: false }, new Date(), "kd");
  const metadata = knowledgeMetadataPredicate(scope?.filters ?? { tags: [], includeDrafts: false }, "kd");
  const rows = await db.execute<VectorRow>(sql`
    SELECT kc.id, kc.document_id, kc.content, kd.title,
           1 - (kc.embedding <=> ${literal}::vector) AS similarity
    FROM knowledge_chunks kc
    JOIN knowledge_documents kd ON kd.id = kc.document_id
    WHERE kc.business_id = ${businessId}
      AND kd.business_id = ${businessId}
      AND ${lifecycle}
      AND ${access}
      ${metadata ? sql`AND ${metadata}` : sql``}
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

async function keywordSearch(businessId: string, query: string, limit: number, scope?: RetrievalScope): Promise<RetrievedChunk[]> {
  const normalized = normalizeForSearch(query);
  const terms = normalized.split(" ").filter((t) => t.length >= 2).slice(0, 8);
  if (terms.length === 0) return [];
  // Rank by term match-count computed in SQL: a chunk matching 3 of 3 query
  // terms outranks one matching 1 of 3, regardless of recency. Recency is
  // only the tiebreak. Terms are bound parameters (LIKE-escaped), never
  // interpolated, so this is injection-safe.
  const termPatterns = terms.map((t) => `%${escapeLike(t)}%`);
  const matchCount = sql<number>`(${sql.join(
    termPatterns.map((p) => sql`CASE WHEN ${knowledgeChunks.content} ILIKE ${p} THEN 1 ELSE 0 END`),
    sql` + `,
  )})`;
  const rows = await db
    .select({
      id: knowledgeChunks.id,
      documentId: knowledgeChunks.documentId,
      content: knowledgeChunks.content,
      title: knowledgeDocuments.title,
      matchCount,
    })
    .from(knowledgeChunks)
    .innerJoin(knowledgeDocuments, eq(knowledgeChunks.documentId, knowledgeDocuments.id))
    .where(
      and(
        eq(knowledgeChunks.businessId, businessId),
        eq(knowledgeDocuments.businessId, businessId),
        or(...termPatterns.map((p) => ilike(knowledgeChunks.content, p))),
        knowledgeLifecyclePredicate(scope?.filters ?? { tags: [], includeDrafts: false }),
        scope ? knowledgeAccessPredicate(scope.principal) : sql`TRUE`,
        knowledgeMetadataPredicate(scope?.filters ?? { tags: [], includeDrafts: false }),
      ),
    )
    .orderBy(desc(matchCount), desc(knowledgeChunks.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    documentId: r.documentId,
    documentTitle: r.title,
    content: r.content,
    // Real coverage score: fraction of query terms matched. Used only as a
    // per-list signal; cross-list fusion is done by RRF on ranks, not scores.
    score: Number(r.matchCount) / terms.length,
    source: "keyword" as const,
  }));
}

/** Default RRF smoothing constant (the standard k=60 from the RRF paper). */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion over per-retriever ranked lists.
 *
 * Each list contributes 1/(k + rank + 1) per document (rank is 0-based, so
 * rank #1 contributes 1/(k+1)); contributions for the same document sum.
 * This fuses *ranks*, so the vector cosine scale and the keyword coverage
 * scale are never mixed. Documents returned by more than one retriever are
 * marked `source: "both"`. Pure function — deterministic, no I/O.
 */
export function reciprocalRankFuse(rankedLists: RetrievedChunk[][], k: number = RRF_K): RetrievedChunk[] {
  const fused = new Map<string, { chunk: RetrievedChunk; rrf: number }>();
  for (const list of rankedLists) {
    list.forEach((chunk, rank) => {
      const contribution = 1 / (k + rank + 1);
      const existing = fused.get(chunk.id);
      if (!existing) {
        fused.set(chunk.id, { chunk: { ...chunk }, rrf: contribution });
      } else {
        existing.rrf += contribution;
        if (existing.chunk.source !== chunk.source) existing.chunk.source = "both";
      }
    });
  }
  return [...fused.values()].sort((a, b) => b.rrf - a.rrf).map(({ chunk, rrf }) => ({ ...chunk, score: rrf }));
}

/** Access + metadata scope applied inside every retrieval query. */
export type RetrievalScope = { principal: RetrievalPrincipal; filters: KnowledgeMetadataFilters };

export async function hybridSearch(input: {
  businessId: string;
  query: string;
  topK?: number;
  minSimilarity?: number;
  requestId?: string;
  /** ACL + structured metadata scope. Omit only for trusted server-side callers. */
  scope?: RetrievalScope;
  /**
   * Deterministic embedding override for tests (mirrors the agent `llm?`
   * override pattern). Production callers omit it and always use the
   * configured provider. pgvector ranking stays real either way.
   */
  embed?: (normalizedQuery: string) => Promise<number[]>;
}): Promise<{ chunks: RetrievedChunk[]; degraded: boolean }> {
  assertTenantScope(input.businessId);
  await requireTenantFeature(input.businessId, "knowledge");
  const topK = Math.max(1, Math.min(Math.trunc(input.topK ?? 5) || 5, 20));
  const minSimilarity = input.minSimilarity ?? 0.25;
  const normalized = normalizePersianText(input.query);
  if (!normalized) return { chunks: [], degraded: false };

  let vectorResults: RetrievedChunk[] = [];
  let degraded = false;
  try {
    const embedding = input.embed
      ? await input.embed(normalized)
      : (await meteredEmbeddings(input.businessId, getEmbeddingProvider(), [normalized], { requestId: input.requestId }))[0].embedding;
    assertDimensions(embedding);
    vectorResults = (await vectorSearch(input.businessId, embedding, topK, input.scope)).filter((r) => r.score >= minSimilarity);
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

  const keywordResults = await keywordSearch(input.businessId, normalized, topK, input.scope);

  // Fuse by rank (RRF, k=60): vector list is ranked by cosine similarity,
  // keyword list by term match-count. In degraded mode the vector list is
  // empty and fusion degrades to the keyword ranking with RRF scores.
  const fused = reciprocalRankFuse([vectorResults, keywordResults]);
  return { chunks: fused.slice(0, topK), degraded };
}

export async function getDocument(businessId: string, documentId: string) {
  assertTenantScope(businessId);
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
