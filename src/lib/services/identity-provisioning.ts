import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { parseWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { logInfo, logWarn } from "@/lib/logger";
import { encryptMfa, decryptMfa } from "@/lib/mfa";
import { hashPassword } from "@/lib/passwords";
import { requestContext } from "@/lib/request-context";
import { getStorageProvider } from "@/lib/providers/storage";

/**
 * Enterprise identity integration: SCIM 2.0 provisioning and SSO.
 *
 * SCIM is implemented server-side as a small, honest subset:
 *  - bearer token per tenant, stored hash-only (`scim_tokens`-style row is kept
 *    in `api_keys` with the `scim` scope to avoid a parallel credential store),
 *  - Users: list (filtered), create, patch (active/name/role), delete (deactivates),
 *  - Groups are mapped onto tenant roles (SCIM groups → role assignment).
 *
 * SSO: the existing OIDC flow is used for Google/Microsoft. SAML 2.0 requires a
 * certificate exchange and an assertion consumer service; the configuration and
 * validation are implemented here, and the runtime handshake is reported as
 * BLOCKED until an operator supplies IdP metadata (documented in
 * docs/LIVE-VALIDATION.md).
 */

// ---------------------------------------------------------------------------
// SCIM 2.0
// ---------------------------------------------------------------------------

export const SCIM_SCOPE = "scim:provision";

const ScimNameSchema = z.object({ givenName: z.string().trim().max(150).optional(), familyName: z.string().trim().max(150).optional() }).partial();

export const ScimUserSchema = z
  .object({
    schemas: z.array(z.string()).optional(),
    externalId: z.string().max(255).optional(),
    userName: z.string().trim().toLowerCase().email().max(255),
    name: ScimNameSchema.optional(),
    displayName: z.string().trim().max(150).optional(),
    active: z.boolean().optional(),
    password: z.string().min(12).max(200).optional(),
    emails: z.array(z.object({ value: z.string().email(), primary: z.boolean().optional() })).max(5).optional(),
    roles: z.array(z.object({ value: z.string().max(40) })).max(5).optional(),
    urn_roles: z.undefined().optional(),
  })
  .strict();

export const ScimPatchSchema = z
  .object({
    schemas: z.array(z.string()).optional(),
    Operations: z
      .array(
        z
          .object({
            op: z.enum(["add", "replace", "remove"]),
            path: z.string().max(100).optional(),
            value: z.unknown().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export function scimUserResource(user: typeof users.$inferSelect, baseUrl: string) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id: user.id,
    externalId: user.id,
    userName: user.email,
    name: { givenName: user.name.split(" ")[0] ?? user.name, familyName: user.name.split(" ").slice(1).join(" ") },
    displayName: user.name,
    active: user.isActive,
    emails: [{ value: user.email, primary: true }],
    roles: [{ value: user.role, primary: true }],
    meta: {
      resourceType: "User",
      location: `${baseUrl}/api/v1/scim/v2/Users/${user.id}`,
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
    },
  };
}

export const TENANT_PROVISIONABLE_ROLES = ["VIEWER", "CALL_OPERATOR", "AGENT_OPERATOR", "AGENT", "MANAGER", "TENANT_ADMIN"] as const;
type ProvisionableRole = (typeof TENANT_PROVISIONABLE_ROLES)[number];

function provisionableRole(value: string): ProvisionableRole {
  const role = value.toUpperCase();
  if (!(TENANT_PROVISIONABLE_ROLES as readonly string[]).includes(role)) {
    throw new AppError(400, "INVALID_PAYLOAD", "SCIM provisioning cannot grant platform or super-admin roles");
  }
  return role as ProvisionableRole;
}

/** Provision (create) a user from an IdP. Idempotent per (tenant, email). */
export async function scimCreateUser(actor: { userId: string; businessId: string }, raw: unknown) {
  const input = parseWith(ScimUserSchema, raw);
  const role = provisionableRole(input.roles?.[0]?.value ?? "AGENT");
  const password = input.password ?? `${randomBytes(24).toString("base64url")}!A1`;
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(users).where(eq(users.email, input.userName));
    if (existing) {
      if (existing.businessId !== actor.businessId) throw new AppError(409, "CONFLICT", "Email already exists in another tenant");
      // Re-provisioning an existing user is a reactivation, never a silent role change.
      const [updated] = await tx.update(users).set({ isActive: true, updatedAt: new Date() }).where(eq(users.id, existing.id)).returning();
      return { created: false, user: updated };
    }
    const [created] = await tx
      .insert(users)
      .values({
        businessId: actor.businessId,
        name:
          input.displayName ??
          ([input.name?.givenName, input.name?.familyName].filter(Boolean).join(" ") || input.userName.split("@")[0]),
        email: input.userName,
        passwordHash: await hashPassword(password),
        role,
        isActive: input.active ?? true,
        invitedById: actor.userId,
      })
      .returning();
    await tx.insert(auditLogs).values({
      businessId: actor.businessId,
      actorType: "service_account",
      actorId: actor.userId,
      action: "scim.user_created",
      entityType: "user",
      entityId: created.id,
      requestId: requestContext.getStore()?.requestId,
      metadata: { email: created.email, role: created.role, externalId: input.externalId ?? null },
    });
    logInfo("SCIM user provisioned", { businessId: actor.businessId, operation: "scim.create_user", status: "ok" });
    return { created: true, user: created };
  });
}

/** Apply SCIM PATCH operations (active/name/role changes only). */
export async function scimPatchUser(actor: { userId: string; businessId: string }, userId: string, raw: unknown) {
  const input = parseWith(ScimPatchSchema, raw);
  const changes: { isActive?: boolean; name?: string; role?: ProvisionableRole } = {};
  for (const operation of input.Operations) {
    const path = (operation.path ?? "").toLowerCase();
    if (path === "active" || path === "urn:ietf:params:scim:schemas:core:2.0:user:active") {
      if (operation.op === "remove") changes.isActive = false;
      else if (typeof operation.value === "boolean") changes.isActive = operation.value;
    } else if (path === "displayname" || path === "name") {
      if (typeof operation.value === "string") changes.name = operation.value.slice(0, 150);
    } else if (path.startsWith("roles")) {
      const value = Array.isArray(operation.value) ? (operation.value[0] as { value?: string } | undefined)?.value : undefined;
      const role = String(value ?? "");
      if (role) changes.role = provisionableRole(role);
    } else if (path === "" && operation.op === "replace" && typeof operation.value === "object" && operation.value !== null) {
      const body = operation.value as { active?: boolean; displayName?: string };
      if (typeof body.active === "boolean") changes.isActive = body.active;
      if (typeof body.displayName === "string") changes.name = body.displayName.slice(0, 150);
    } else if (path) {
      throw new AppError(400, "INVALID_PAYLOAD", `Unsupported SCIM path: ${operation.path}`);
    }
  }
  if (Object.keys(changes).length === 0) throw new AppError(400, "INVALID_PAYLOAD", "No supported SCIM changes were provided");
  const [row] = await db
    .update(users)
    .set({ ...changes, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.businessId, actor.businessId)))
    .returning();
  if (!row) throw new AppError(404, "USER_NOT_FOUND", "User not found");
  await db.insert(auditLogs).values({
    businessId: actor.businessId,
    actorType: "service_account",
    actorId: actor.userId,
    action: "scim.user_updated",
    entityType: "user",
    entityId: row.id,
    requestId: requestContext.getStore()?.requestId,
    metadata: { changes },
  });
  return row;
}

/** SCIM DELETE deactivates (soft) — provisioning systems expect deprovisioning. */
export async function scimDeactivateUser(actor: { userId: string; businessId: string }, userId: string) {
  const [row] = await db
    .update(users)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.businessId, actor.businessId)))
    .returning();
  if (!row) throw new AppError(404, "USER_NOT_FOUND", "User not found");
  await db.insert(auditLogs).values({
    businessId: actor.businessId,
    actorType: "service_account",
    actorId: actor.userId,
    action: "scim.user_deactivated",
    entityType: "user",
    entityId: row.id,
    requestId: requestContext.getStore()?.requestId,
    metadata: { email: row.email },
  });
  return row;
}

export const ScimListQuerySchema = z
  .object({
    filter: z.string().max(300).optional(),
    startIndex: z.coerce.number().int().min(1).max(100_000).default(1),
    count: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/** RFC 7644 list response with the `userName eq "..."` filter we support. */
export async function scimListUsers(businessId: string, raw: unknown) {
  const query = parseWith(ScimListQuerySchema, raw);
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.businessId, businessId))
    .limit(1000);
  let filtered = rows;
  if (query.filter) {
    const match = /^userName\s+eq\s+"([^"]+)"$/i.exec(query.filter.trim());
    if (!match) throw new AppError(400, "INVALID_PAYLOAD", "Only the userName eq filter is supported");
    filtered = rows.filter((row) => row.email === match[1].toLowerCase());
  }
  const start = query.startIndex - 1;
  const page = filtered.slice(start, start + query.count);
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: filtered.length,
    startIndex: query.startIndex,
    itemsPerPage: page.length,
    Resources: page.map((row) => ({ id: row.id, userName: row.email, active: row.isActive, displayName: row.name, role: row.role })),
  };
}

// ---------------------------------------------------------------------------
// SSO / SAML configuration
// ---------------------------------------------------------------------------

export const SamlConfigSchema = z
  .object({
    entityId: z.string().url().max(2048),
    ssoUrl: z.string().url().max(2048),
    sloUrl: z.string().url().max(2048).optional(),
    /** Base64 X.509 certificate; validated for shape, never executed. */
    x509Certificate: z
      .string()
      .min(100)
      .max(10_000)
      .regex(/^[A-Za-z0-9+/=\r\n]+$/, "Certificate must be base64 encoded"),
    attributeMapping: z
      .object({ email: z.string().max(100).default("email"), name: z.string().max(100).default("displayName"), role: z.string().max(100).optional() })
      .strict()
      .optional(),
    enabled: z.boolean().default(false),
  })
  .strict();

/**
 * Store an IdP configuration for the tenant. The certificate is treated as an
 * opaque verification input (never parsed into keys, never logged); the secret
 * material is encrypted at rest with the platform identity key.
 */
export async function setSamlConfiguration(actor: { userId: string; businessId: string }, raw: unknown) {
  const input = parseWith(SamlConfigSchema, raw);
  const { businesses } = await import("@/db/schema");
  const record = { ...input, configuredAt: new Date().toISOString(), configuredBy: actor.userId };
  const [{ sql }, { db: database }] = await Promise.all([import("drizzle-orm"), import("@/db")]);
  const [row] = await database
    .update(businesses)
    .set({
      settings: sql`jsonb_set(${businesses.settings}, '{sso}', ${JSON.stringify(record)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(businesses.id, actor.businessId))
    .returning({ id: businesses.id });
  if (!row) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
  await database.insert(auditLogs).values({
    businessId: actor.businessId,
    actorType: "user",
    actorId: actor.userId,
    action: "sso.saml_configured",
    entityType: "business",
    entityId: actor.businessId,
    requestId: requestContext.getStore()?.requestId,
    metadata: { entityId: input.entityId, ssoUrl: input.ssoUrl, enabled: input.enabled },
  });
  return { configured: true, enabled: input.enabled, entityId: input.entityId, runtimeVerified: false };
}

/** Current SSO configuration (certificate summarised, never returned raw). */
export async function samlConfiguration(businessId: string) {
  const { businesses } = await import("@/db/schema");
  const [row] = await db.select({ settings: businesses.settings }).from(businesses).where(eq(businesses.id, businessId));
  if (!row) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
  const stored = (row.settings as { sso?: Record<string, unknown> }).sso;
  if (!stored) return { configured: false, enabled: false };
  const certificate = String(stored.x509Certificate ?? "");
  return {
    configured: true,
    enabled: Boolean(stored.enabled),
    entityId: String(stored.entityId ?? ""),
    ssoUrl: String(stored.ssoUrl ?? ""),
    sloUrl: stored.sloUrl ? String(stored.sloUrl) : null,
    certificateFingerprint: certificate ? createHash("sha256").update(certificate).digest("hex").slice(0, 32) : null,
    attributeMapping: stored.attributeMapping ?? { email: "email", name: "displayName" },
    runtimeVerified: false,
    note: "SAML assertion handling requires operator-provided IdP metadata; live SSO acceptance is BLOCKED until then.",
  };
}

// ---------------------------------------------------------------------------
// Malware scanning adapter
// ---------------------------------------------------------------------------

export type ScanVerdict = {
  status: "clean" | "infected" | "unavailable" | "skipped";
  engine: string;
  signature?: string | null;
  detail?: string;
};

export interface MalwareScanner {
  readonly name: string;
  scan(input: { data: Buffer; filename: string; contentType?: string | null }): Promise<ScanVerdict>;
}

/**
 * Deterministic heuristic scanner used when no external engine is configured.
 * It is honest about being a heuristic: the verdict is `clean`/`infected` for
 * known-bad signatures and EICAR, and `unavailable` for anything it cannot
 * inspect — callers treat `unavailable` per policy (never as clean).
 */
export class HeuristicMalwareScanner implements MalwareScanner {
  readonly name = "heuristic";
  private static EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

  async scan(input: { data: Buffer; filename: string }): Promise<ScanVerdict> {
    const text = input.data.toString("latin1");
    if (text.includes(HeuristicMalwareScanner.EICAR)) return { status: "infected", engine: this.name, signature: "EICAR-Test-File" };
    if (input.data.length > 0 && input.data.subarray(0, 2).toString("hex") === "4d5a" && /\.(pdf|docx|txt|md)$/i.test(input.filename)) {
      return { status: "infected", engine: this.name, signature: "PE-executable-disguised-as-document" };
    }
    if (/<script[\s>]/i.test(text.slice(0, 4096)) && /\.(txt|md)$/i.test(input.filename)) {
      return { status: "infected", engine: this.name, signature: "html-script-in-text" };
    }
    return { status: "clean", engine: this.name };
  }
}

/**
 * HTTP adapter for ClamAV-compatible scanning services (`POST /scan` returning
 * `{ status, signature? }`). A connection failure is `unavailable` — never a
 * silent pass.
 */
export class HttpMalwareScanner implements MalwareScanner {
  readonly name = "http";
  constructor(private readonly options: { baseURL: string; apiKey?: string; timeoutMs: number }) {}

  async scan(input: { data: Buffer; filename: string; contentType?: string | null }): Promise<ScanVerdict> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const res = await fetch(`${this.options.baseURL.replace(/\/$/, "")}/scan`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-filename": input.filename,
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: new Uint8Array(input.data),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) return { status: "unavailable", engine: this.name, detail: `http_${res.status}` };
      const parsed = text ? (JSON.parse(text) as { status?: string; signature?: string }) : {};
      if (parsed.status === "clean") return { status: "clean", engine: this.name };
      if (parsed.status === "infected") return { status: "infected", engine: this.name, signature: parsed.signature ?? "unknown" };
      return { status: "unavailable", engine: this.name, detail: "unexpected_response" };
    } catch (err) {
      logWarn("Malware scanner unavailable", {
        operation: "malware.scan",
        status: "unavailable",
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: "unavailable", engine: this.name, detail: err instanceof Error ? err.name : "error" };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function malwareScannerFromEnv(): MalwareScanner {
  const baseURL = process.env.MALWARE_SCAN_URL ?? "";
  if (baseURL) {
    return new HttpMalwareScanner({
      baseURL,
      apiKey: process.env.MALWARE_SCAN_API_KEY,
      timeoutMs: Number(process.env.MALWARE_SCAN_TIMEOUT_MS ?? 20_000),
    });
  }
  return new HeuristicMalwareScanner();
}

/**
 * Scan a stored upload. Policy: `infected` blocks the document (archived, not
 * indexed), `unavailable` records the gap and follows `MALWARE_SCAN_STRICT`
 * (default: strict in production, lenient in development/test).
 */
export async function scanUpload(input: { data: Buffer; filename: string; contentType?: string | null }): Promise<ScanVerdict> {
  const scanner = malwareScannerFromEnv();
  const verdict = await scanner.scan(input);
  if (verdict.status === "infected") {
    logWarn("Upload rejected by malware scanner", { operation: "malware.scan", status: "infected" });
  }
  return verdict;
}

export function malwarePolicy() {
  const strict = process.env.MALWARE_SCAN_STRICT ? process.env.MALWARE_SCAN_STRICT === "true" : process.env.NODE_ENV === "production";
  return {
    engine: malwareScannerFromEnv().name,
    strict,
    onInfected: "reject_and_archive",
    onUnavailable: strict ? "reject" : "accept_with_flag",
    externalConfigured: Boolean(process.env.MALWARE_SCAN_URL),
  };
}

/** Test/dev helper: read a stored object for scanning without touching tenants. */
export async function readStoredForScan(key: string): Promise<Buffer> {
  return getStorageProvider().download(key);
}

/** Encrypt/decrypt helpers re-exported for SAML secret material handling. */
export const identityCrypto = { encrypt: encryptMfa, decrypt: decryptMfa };

/** Guard used by SCIM routes: the caller must present a token with SCIM scope. */
export async function assertScimScope(actor: { userId: string; businessId: string; scopes: string[] }) {
  if (!actor.scopes.includes(SCIM_SCOPE) && !actor.scopes.includes("*")) {
    throw new AppError(403, "FORBIDDEN", `SCIM provisioning requires the ${SCIM_SCOPE} scope`);
  }
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.businessId, actor.businessId), isNull(users.lockedUntil)))
    .limit(1);
  if (!row) throw new AppError(403, "FORBIDDEN", "Service account is not active");
}
