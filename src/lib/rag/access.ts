import { and, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { knowledgeDocuments } from "@/db/schema";

/**
 * Knowledge document access control.
 *
 * Access is applied as a SQL predicate INSIDE the retrieval queries (vector and
 * keyword), never as post-retrieval filtering: an unauthorized document cannot
 * reach the candidate set, the reranker, the LLM context, or an analytics
 * payload. The filter is built from the *database* role of the caller — not
 * from a JWT claim and never from model output.
 */

export const KnowledgeAclSchema = z
  .object({
    /** Tenant-wide by default; every other visibility is an explicit allowlist. */
    roles: z.array(z.string().min(1).max(60)).max(30).default([]),
    userIds: z.array(z.string().uuid()).max(200).default([]),
    agentIds: z.array(z.string().uuid()).max(200).default([]),
    categories: z.array(z.string().min(1).max(80)).max(50).default([]),
    departments: z.array(z.string().min(1).max(120)).max(50).default([]),
  })
  .strict();
export type KnowledgeAcl = z.infer<typeof KnowledgeAclSchema>;

export const KnowledgeVisibility = z.enum(["TENANT", "ROLE", "AGENT", "CATEGORY", "PRIVATE"]);
export type KnowledgeVisibilityType = z.infer<typeof KnowledgeVisibility>;

/** Who is asking. `role`/`userId` come from the verified session, `agentId` from the runtime. */
export const RetrievalPrincipalSchema = z
  .object({
    role: z.string().min(1).max(60),
    userId: z.string().uuid().nullable().default(null),
    agentId: z.string().uuid().nullable().default(null),
    /** Platform administrators may read a tenant's knowledge only with explicit support access. */
    platformSupport: z.boolean().default(false),
  })
  .strict();
export type RetrievalPrincipal = z.infer<typeof RetrievalPrincipalSchema>;

export const KnowledgeMetadataFiltersSchema = z
  .object({
    language: z.string().min(2).max(10).optional(),
    documentType: z.string().min(1).max(60).optional(),
    category: z.string().min(1).max(80).optional(),
    product: z.string().min(1).max(120).optional(),
    service: z.string().min(1).max(120).optional(),
    branch: z.string().min(1).max(120).optional(),
    department: z.string().min(1).max(120).optional(),
    tags: z.array(z.string().min(1).max(60)).max(20).default([]),
    includeDrafts: z.boolean().default(false),
    asOf: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type KnowledgeMetadataFilters = z.infer<typeof KnowledgeMetadataFiltersSchema>;

/**
 * SQL predicate for "this caller may retrieve this document".
 *
 * - TENANT: visible to the whole tenant.
 * - ROLE: role allowlist (empty allowlist ⇒ tenant admins only).
 * - AGENT: agent allowlist (empty ⇒ the document is unreachable by the runtime).
 * - CATEGORY: category/department match.
 * - PRIVATE: explicit user allowlist.
 * Support sessions are read-only and never bypass ACLs.
 */
/**
 * Column reference for a document alias. `alias` is a constant chosen by this
 * module (never caller input), so the identifier interpolation is safe.
 */
function docColumn(alias: string, name: string): SQL {
  return sql.raw(`"${alias}"."${name}"`);
}

/**
 * SQL predicate for "this caller may retrieve this document".
 *
 * - TENANT: visible to the whole tenant.
 * - ROLE: role allowlist (empty allowlist ⇒ unreachable without a match).
 * - AGENT: agent allowlist (empty ⇒ unreachable by the runtime).
 * - CATEGORY: category/department match.
 * - PRIVATE: explicit user allowlist.
 * Support sessions are read-only and never bypass ACLs.
 *
 * `alias` must match the alias used by the enclosing query so the predicate can
 * be embedded in raw SQL (vector search) and Drizzle queries alike.
 */
export function knowledgeAccessPredicate(principal: RetrievalPrincipal, alias = "knowledge_documents"): SQL {
  const p = RetrievalPrincipalSchema.parse(principal);
  const visibility = docColumn(alias, "visibility");
  const acl = docColumn(alias, "acl");
  const roleMatch = sql`(${visibility} = 'ROLE' AND ${acl} -> 'roles' ? ${p.role})`;
  const agentMatch = p.agentId
    ? sql`(${visibility} = 'AGENT' AND ${acl} -> 'agentIds' ? ${p.agentId})`
    : sql`FALSE`;
  const ownerMatch = p.userId
    ? sql`(${visibility} = 'PRIVATE' AND ${acl} -> 'userIds' ? ${p.userId})`
    : sql`FALSE`;
  const categoryMatch = sql`(${visibility} = 'CATEGORY' AND (
      ${acl} -> 'categories' ? COALESCE(${docColumn(alias, "category")}, '')
      OR ${acl} -> 'departments' ? COALESCE(${docColumn(alias, "department")}, '')
    ))`;
  return sql`(${visibility} = 'TENANT' OR ${roleMatch} OR ${agentMatch} OR ${ownerMatch} OR ${categoryMatch})`;
}

/**
 * Effective-window + lifecycle predicate. Only ACTIVE documents inside their
 * validity window are retrievable; drafts/failed/archived versions never enter
 * the candidate set.
 */
export function knowledgeLifecyclePredicate(filters: KnowledgeMetadataFilters, at = new Date(), alias = "knowledge_documents"): SQL {
  const asOf = filters.asOf ? new Date(filters.asOf) : at;
  const status = docColumn(alias, "status");
  const lifecycle = docColumn(alias, "lifecycle");
  const effectiveFrom = docColumn(alias, "effective_from");
  const effectiveUntil = docColumn(alias, "effective_until");
  const parts: SQL[] = [
    sql`${status} = 'indexed'`,
    filters.includeDrafts ? sql`${lifecycle} IN ('ACTIVE', 'DRAFT')` : sql`${lifecycle} = 'ACTIVE'`,
    sql`(${effectiveFrom} IS NULL OR ${effectiveFrom} <= ${asOf.toISOString()})`,
    sql`(${effectiveUntil} IS NULL OR ${effectiveUntil} > ${asOf.toISOString()})`,
  ];
  return and(...parts)!;
}

function arrayLiteral(values: string[]): SQL {
  return sql.raw(`ARRAY[${values.map((value) => `'${value.replace(/'/g, "''")}'`).join(",")}]::text[]`);
}

/** Structured metadata filters, applied before vector ranking. */
export function knowledgeMetadataPredicate(filters: KnowledgeMetadataFilters, alias = "knowledge_documents"): SQL | undefined {
  const parts: SQL[] = [];
  const col = (name: string) => docColumn(alias, name);
  if (filters.language) parts.push(sql`${col("language")} = ${filters.language}`);
  if (filters.documentType) parts.push(sql`${col("document_type")} = ${filters.documentType}`);
  if (filters.category) parts.push(sql`${col("category")} = ${filters.category}`);
  if (filters.product) parts.push(sql`${col("product")} = ${filters.product}`);
  if (filters.service) parts.push(sql`${col("service")} = ${filters.service}`);
  if (filters.branch) parts.push(sql`${col("branch")} = ${filters.branch}`);
  if (filters.department) parts.push(sql`${col("department")} = ${filters.department}`);
  if (filters.tags.length) parts.push(sql`${col("tags")} ?| ${arrayLiteral(filters.tags)}`);
  return parts.length ? and(...parts)! : undefined;
}

/** True when the ACL grants this principal access to a document row. */
export function canAccessDocument(
  principal: RetrievalPrincipal,
  document: { visibility: string; acl: Record<string, unknown>; category?: string | null; department?: string | null },
): boolean {
  const p = RetrievalPrincipalSchema.parse(principal);
  const acl = KnowledgeAclSchema.parse(document.acl ?? {});
  switch (document.visibility) {
    case "TENANT":
      return true;
    case "ROLE":
      return acl.roles.includes(p.role);
    case "AGENT":
      return Boolean(p.agentId && acl.agentIds.includes(p.agentId));
    case "PRIVATE":
      return Boolean(p.userId && acl.userIds.includes(p.userId));
    case "CATEGORY":
      return acl.categories.includes(document.category ?? "") || acl.departments.includes(document.department ?? "");
    default:
      return false;
  }
}
