import { and, desc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/db";
import { knowledgeChunks, knowledgeDocuments, retrievalEvents } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { assertTenantScope } from "@/lib/request-context";
import { logInfo, logWarn } from "@/lib/logger";
import { metrics } from "@/lib/telemetry";
import {
  KnowledgeAclSchema,
  KnowledgeMetadataFiltersSchema,
  RetrievalPrincipalSchema,
  type KnowledgeMetadataFilters,
  type RetrievalPrincipal,
} from "@/lib/rag/access";
import { rerankWithFallback, type RerankerProvider } from "@/lib/providers/reranker";
import { hybridSearch, type RetrievedChunk, type RetrievalScope } from "@/lib/services/knowledge";
import { parseWith } from "@/lib/api";

/**
 * Knowledge governance: explicit document versions (draft/active/archived),
 * retrieval-time ACL + metadata filtering, optional reranking and retrieval
 * analytics. Retrieval order is always:
 *   tenant scope → ACL → lifecycle/effective window → metadata → rank → rerank.
 */

export const DocumentGovernanceSchema = z
  .object({
    lifecycle: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
    visibility: z.enum(["TENANT", "ROLE", "AGENT", "CATEGORY", "PRIVATE"]).optional(),
    acl: KnowledgeAclSchema.partial().optional(),
    language: z.string().min(2).max(10).optional(),
    documentType: z.string().max(60).nullish(),
    category: z.string().max(80).nullish(),
    product: z.string().max(120).nullish(),
    service: z.string().max(120).nullish(),
    branch: z.string().max(120).nullish(),
    department: z.string().max(120).nullish(),
    tags: z.array(z.string().min(1).max(60)).max(30).optional(),
    effectiveFrom: z.string().datetime({ offset: true }).nullish(),
    effectiveUntil: z.string().datetime({ offset: true }).nullish(),
  })
  .strict();

export type DocumentGovernance = z.infer<typeof DocumentGovernanceSchema>;

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/** Update governance metadata on a document (tenant-scoped). */
export async function updateDocumentGovernance(businessId: string, documentId: string, raw: unknown) {
  assertTenantScope(businessId);
  const input = parseWith(DocumentGovernanceSchema, raw);
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.businessId, businessId)))
      .for("update");
    if (!doc) throw new AppError(404, "KNOWLEDGE_NOT_FOUND", "Document not found");
    if (input.effectiveFrom && input.effectiveUntil && new Date(input.effectiveFrom) >= new Date(input.effectiveUntil))
      throw new AppError(400, "VALIDATION_ERROR", "effectiveFrom must be before effectiveUntil");
    const acl = input.acl ? { ...KnowledgeAclSchema.parse(doc.acl ?? {}), ...input.acl } : undefined;
    const [updated] = await tx
      .update(knowledgeDocuments)
      .set({
        lifecycle: input.lifecycle ?? doc.lifecycle,
        visibility: input.visibility ?? doc.visibility,
        acl: acl ?? doc.acl,
        language: input.language ?? doc.language,
        documentType: input.documentType === undefined ? doc.documentType : input.documentType,
        category: input.category === undefined ? doc.category : input.category,
        product: input.product === undefined ? doc.product : input.product,
        service: input.service === undefined ? doc.service : input.service,
        branch: input.branch === undefined ? doc.branch : input.branch,
        department: input.department === undefined ? doc.department : input.department,
        tags: input.tags ?? doc.tags,
        effectiveFrom: input.effectiveFrom === undefined ? doc.effectiveFrom : toDate(input.effectiveFrom),
        effectiveUntil: input.effectiveUntil === undefined ? doc.effectiveUntil : toDate(input.effectiveUntil),
        updatedAt: new Date(),
      })
      .where(eq(knowledgeDocuments.id, doc.id))
      .returning();
    return updated;
  });
}

/**
 * Publish a new version of a document. The previous version is archived and
 * linked through `supersedesDocumentId`; history is retained for audit.
 * Versions are immutable: publishing never rewrites the older row.
 */
export async function publishDocumentVersion(input: {
  businessId: string;
  documentId: string;
  content: string;
  title?: string;
  governance?: DocumentGovernance;
  actorId?: string | null;
  requestId?: string;
  /** Injected chunk+embed pipeline (defaults to the ingestion service). */
  ingest?: (args: { businessId: string; title: string; content: string; requestId?: string }) => Promise<{ document: { id: string; version: number }; chunks: number }>;
}) {
  assertTenantScope(input.businessId);
  const [previous] = await db
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, input.documentId), eq(knowledgeDocuments.businessId, input.businessId)))
    .limit(1);
  if (!previous) throw new AppError(404, "KNOWLEDGE_NOT_FOUND", "Document not found");
  const ingest = input.ingest ?? (async (args) => {
    const { ingestContent } = await import("@/lib/services/knowledge");
    return ingestContent({ ...args, sourceType: "version" });
  });
  const { document, chunks } = await ingest({
    businessId: input.businessId,
    title: input.title ?? `${previous.title} (v${previous.version + 1})`,
    content: input.content,
    requestId: input.requestId,
  });
  const governance = input.governance ? DocumentGovernanceSchema.parse(input.governance) : {};
  await db.transaction(async (tx) => {
    const [latest] = await tx
      .update(knowledgeDocuments)
      .set({
        version: previous.version + 1,
        supersedesDocumentId: previous.id,
        lifecycle: "ACTIVE",
        visibility: governance.visibility ?? previous.visibility,
        acl: governance.acl ? { ...KnowledgeAclSchema.parse(previous.acl ?? {}), ...governance.acl } : previous.acl,
        language: governance.language ?? previous.language,
        category: governance.category === undefined ? previous.category : governance.category,
        documentType: governance.documentType === undefined ? previous.documentType : governance.documentType,
        tags: governance.tags ?? previous.tags,
        effectiveFrom: governance.effectiveFrom ? new Date(governance.effectiveFrom) : null,
        effectiveUntil: governance.effectiveUntil ? new Date(governance.effectiveUntil) : null,
        updatedAt: new Date(),
      })
      .where(and(eq(knowledgeDocuments.id, document.id), eq(knowledgeDocuments.businessId, input.businessId)))
      .returning();
    // Superseded versions leave retrieval immediately (kept for audit/history).
    await tx
      .update(knowledgeDocuments)
      .set({ lifecycle: "ARCHIVED", updatedAt: new Date() })
      .where(and(eq(knowledgeDocuments.id, previous.id), eq(knowledgeDocuments.businessId, input.businessId)));
    const { enqueueOutbox } = await import("@/lib/services/outbox");
    await enqueueOutbox(tx, {
      businessId: input.businessId,
      topic: "knowledge.updated",
      idempotencyKey: `knowledge.updated:${document.id}`,
      payload: {
        businessId: input.businessId,
        id: document.id,
        documentId: document.id,
        version: latest.version,
        supersedesDocumentId: previous.id,
        chunks,
        actorId: input.actorId ?? null,
      },
    });
  });
  logInfo("Knowledge document version published", {
    requestId: input.requestId,
    businessId: input.businessId,
    operation: "knowledge.publish_version",
    status: "ok",
  });
  return { documentId: document.id, version: previous.version + 1, supersedesDocumentId: previous.id, chunks };
}

/** Archive a document without deleting it (audit-safe removal from retrieval). */
export async function archiveDocument(businessId: string, documentId: string) {
  assertTenantScope(businessId);
  const [updated] = await db
    .update(knowledgeDocuments)
    .set({ lifecycle: "ARCHIVED", updatedAt: new Date() })
    .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.businessId, businessId)))
    .returning();
  if (!updated) throw new AppError(404, "KNOWLEDGE_NOT_FOUND", "Document not found");
  return updated;
}

/** Version history for a document family (oldest first). */
export async function listDocumentVersions(businessId: string, documentId: string) {
  assertTenantScope(businessId);
  const [exists] = await db
    .select({ id: knowledgeDocuments.id })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.businessId, businessId)))
    .limit(1);
  if (!exists) throw new AppError(404, "KNOWLEDGE_NOT_FOUND", "Document not found");
  const rows = await db
    .select({
      id: knowledgeDocuments.id,
      title: knowledgeDocuments.title,
      version: knowledgeDocuments.version,
      lifecycle: knowledgeDocuments.lifecycle,
      supersedesDocumentId: knowledgeDocuments.supersedesDocumentId,
      chunkCount: knowledgeDocuments.chunkCount,
      createdAt: knowledgeDocuments.createdAt,
    })
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.businessId, businessId))
    .orderBy(desc(knowledgeDocuments.createdAt))
    .limit(500);
  const family = rows.filter((row) => row.id === documentId || chainContains(rows, documentId, row.id));
  return family.sort((a, b) => a.version - b.version);
}

function chainContains(rows: { id: string; supersedesDocumentId: string | null }[], rootId: string, candidateId: string): boolean {
  const byId = new Map(rows.map((row) => [row.id, row]));
  let cursor: string | null = candidateId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const row = byId.get(cursor);
    if (!row) return false;
    if (row.supersedesDocumentId === rootId) return true;
    cursor = row.supersedesDocumentId;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Retrieval analytics
// ---------------------------------------------------------------------------

export type RetrievalRecord = {
  query: string;
  /** Chunk ids that were candidates (bounded, tenant-owned). */
  candidateIds: string[];
  /** Documents behind the candidate chunks; defaults to `candidateIds`. */
  documentIds?: string[];
  usedIds: string[];
  retrievalMs: number;
  reranker: string | null;
  rerankMs: number | null;
  agentId?: string | null;
  callId?: string | null;
  outcome?: "ok" | "empty" | "degraded" | "failed";
};

/**
 * Persist retrieval analytics. Document ids are stored (they are tenant-owned
 * and required for "top retrieved documents"); query text is stored only as a
 * hash plus a bounded excerpt for tenant-facing analytics, never with customer
 * identifiers.
 */
export async function recordRetrievalEvent(businessId: string, record: RetrievalRecord): Promise<string | null> {
  assertTenantScope(businessId);
  try {
    const queryHash = createHash("sha256").update(record.query).digest("hex");
    const [row] = await db.insert(retrievalEvents).values({
      businessId,
      query: record.query.slice(0, 2000),
      queryHash,
      strategy: "hybrid_rrf",
      candidateCount: record.candidateIds.length,
      resultCount: record.candidateIds.length,
      documentIds: (record.documentIds ?? record.candidateIds).slice(0, 100),
      usedDocumentIds: record.usedIds.slice(0, 100),
      reranker: record.reranker,
      rerankMs: record.rerankMs,
      retrievalMs: Math.max(0, Math.round(record.retrievalMs)),
      agentId: record.agentId ?? null,
      callId: record.callId ?? null,
      outcome: record.outcome ?? (record.candidateIds.length === 0 ? "empty" : "ok"),
    }).returning({ id: retrievalEvents.id });
    return row?.id ?? null;
  } catch (err) {
    // Analytics must never break retrieval.
    logWarn("Retrieval analytics write failed", {
      businessId,
      operation: "knowledge.analytics",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export const RetrievalAnalyticsQuerySchema = z
  .object({ days: z.coerce.number().int().min(1).max(90).default(30) })
  .strict();

/** Tenant-facing retrieval quality summary (no customer identifiers). */
export async function retrievalAnalytics(businessId: string, raw?: unknown) {
  assertTenantScope(businessId);
  const { days } = parseWith(RetrievalAnalyticsQuerySchema, raw ?? {});
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const rows = await db
    .select()
    .from(retrievalEvents)
    .where(and(eq(retrievalEvents.businessId, businessId), sql`${retrievalEvents.createdAt} >= ${since.toISOString()}`))
    .orderBy(desc(retrievalEvents.createdAt))
    .limit(5000);

  const total = rows.length;
  const zeroResult = rows.filter((row) => row.resultCount === 0).length;
  const failed = rows.filter((row) => row.outcome === "failed").length;
  const withEvidence = rows.filter((row) => row.usedDocumentIds.length > 0).length;
  const avgLatency = total ? rows.reduce((sum, row) => sum + row.retrievalMs, 0) / total : 0;
  const topDocuments = new Map<string, number>();
  for (const row of rows) for (const id of row.documentIds) topDocuments.set(id, (topDocuments.get(id) ?? 0) + 1);
  const unusedEvidence = rows.reduce(
    (sum, row) => sum + row.documentIds.filter((id) => !row.usedDocumentIds.includes(id)).length,
    0,
  );

  return {
    windowDays: days,
    queries: total,
    zeroResultQueries: zeroResult,
    zeroResultRate: total ? Number((zeroResult / total).toFixed(4)) : null,
    failedQueries: failed,
    retrievalFailureRate: total ? Number((failed / total).toFixed(4)) : null,
    answerWithEvidenceRate: total ? Number((withEvidence / total).toFixed(4)) : null,
    unusedRetrievedEvidence: unusedEvidence,
    averageLatencyMs: Number(avgLatency.toFixed(2)),
    rerankedQueries: rows.filter((row) => row.reranker && row.reranker !== "rrf").length,
    topDocuments: [...topDocuments.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([documentId, count]) => ({ documentId, count })),
  };
}

// ---------------------------------------------------------------------------
// Governed retrieval entry point
// ---------------------------------------------------------------------------

export type GovernedSearchInput = {
  businessId: string;
  query: string;
  principal: RetrievalPrincipal;
  filters?: unknown;
  topK?: number;
  minSimilarity?: number;
  requestId?: string;
  agentId?: string | null;
  callId?: string | null;
  embed?: (normalizedQuery: string) => Promise<number[]>;
  reranker?: RerankerProvider | null;
  /** Skip analytics writes (read-only support sessions). */
  skipAnalytics?: boolean;
};

export type GovernedSearchResult = {
  chunks: RetrievedChunk[];
  degraded: boolean;
  reranker: string;
  rerankMs: number | null;
  retrievalMs: number;
  candidates: number;
  outcome: "ok" | "empty" | "degraded" | "failed";
  /** Id of the persisted retrieval event (null when analytics are disabled). */
  retrievalId: string | null;
  /** Documents that produced the final evidence set. */
  documentIds: string[];
};

/**
 * ACL-scoped retrieval with optional reranking and analytics.
 * The ACL predicate runs inside SQL, so filtered-out documents are never
 * candidates, never reranked, and never counted as evidence.
 */
export async function searchKnowledgeGoverned(input: GovernedSearchInput): Promise<GovernedSearchResult> {
  assertTenantScope(input.businessId);
  const principal = RetrievalPrincipalSchema.parse(input.principal);
  const filters: KnowledgeMetadataFilters = KnowledgeMetadataFiltersSchema.parse(input.filters ?? {});
  const scope: RetrievalScope = { principal, filters };
  const started = Date.now();
  const topK = Math.max(1, Math.min(Math.trunc(input.topK ?? 5) || 5, 20));
  // Fetch a wider candidate set than the final evidence set when a reranker is
  // configured, so reranking has real choices.
  const candidateLimit = Math.min(topK * 3, 60);

  let result: { chunks: RetrievedChunk[]; degraded: boolean };
  let failed = false;
  try {
    result = await hybridSearch({
      businessId: input.businessId,
      query: input.query,
      topK: candidateLimit,
      minSimilarity: input.minSimilarity,
      requestId: input.requestId,
      scope,
      embed: input.embed,
    });
  } catch (err) {
    failed = true;
    result = { chunks: [], degraded: true };
    logWarn("Knowledge retrieval failed", {
      requestId: input.requestId,
      businessId: input.businessId,
      operation: "knowledge.search",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const retrievalMs = Date.now() - started;

  const rerank = await rerankWithFallback({
    query: input.query,
    candidates: result.chunks.map((chunk) => ({ id: chunk.id, documentId: chunk.documentId, content: chunk.content, score: chunk.score })),
    provider: input.reranker,
    topN: topK,
  });
  const byId = new Map(result.chunks.map((chunk) => [chunk.id, chunk]));
  const chunks = rerank.candidates
    .map((candidate) => {
      const original = byId.get(candidate.id);
      return original ? { ...original, score: candidate.score } : null;
    })
    .filter((chunk): chunk is RetrievedChunk => chunk !== null);
  metrics().retrievalDuration.observe((Date.now() - started) / 1000);

  const outcome: GovernedSearchResult["outcome"] = failed ? "failed" : chunks.length === 0 ? "empty" : result.degraded ? "degraded" : "ok";
  let retrievalId: string | null = null;
  if (!input.skipAnalytics) {
    retrievalId = await recordRetrievalEvent(input.businessId, {
      query: input.query,
      candidateIds: result.chunks.map((chunk) => chunk.id),
      documentIds: [...new Set(result.chunks.map((chunk) => chunk.documentId))],
      // Evidence usage is unknown at retrieval time: it is recorded later via
      // markEvidenceUsed() once the answer (and its citations) exist.
      usedIds: [],
      retrievalMs,
      reranker: rerank.provider,
      rerankMs: rerank.latencyMs,
      agentId: input.agentId ?? principal.agentId,
      callId: input.callId,
      outcome,
    });
  }

  return {
    chunks,
    degraded: result.degraded,
    reranker: rerank.provider,
    rerankMs: rerank.latencyMs,
    retrievalMs,
    candidates: result.chunks.length,
    outcome,
    retrievalId,
    documentIds: [...new Set(chunks.map((chunk) => chunk.documentId))],
  };
}

/**
 * Record which documents actually influenced the answer for a retrieval event.
 * Only the first call per event wins: evidence usage is a fact about the query,
 * not something a later (less reliable) caller may overwrite.
 */
export async function markEvidenceUsed(businessId: string, retrievalId: string, documentIds: string[]): Promise<boolean> {
  assertTenantScope(businessId);
  if (!retrievalId) return false;
  const updated = await db
    .update(retrievalEvents)
    .set({ usedDocumentIds: jsonbArray(documentIds.slice(0, 100)) })
    .where(
      and(
        eq(retrievalEvents.businessId, businessId),
        eq(retrievalEvents.id, retrievalId),
        sql`jsonb_array_length(${retrievalEvents.usedDocumentIds}) = 0`,
      ),
    )
    .returning({ id: retrievalEvents.id });
  return updated.length > 0;
}

/** jsonb array literal built from a bound parameter (never string-concatenated). */
function jsonbArray(values: string[]) {
  return sql`${JSON.stringify(values)}::jsonb`;
}

/** Chunk count for a document (used by version diffing and reporting). */
export async function documentChunkCount(businessId: string, documentId: string): Promise<number> {
  assertTenantScope(businessId);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.businessId, businessId), eq(knowledgeChunks.documentId, documentId)));
  return row?.count ?? 0;
}
