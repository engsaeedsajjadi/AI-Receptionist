/**
 * Audited tool registry: the ONLY way the LLM touches the world.
 *
 * Crash-safety model (P0-3): every voice-turn tool runs through
 * executeIdempotentToolCall with a stable operation id. Guarantees per
 * tool class — stated precisely, no more:
 *
 * - Pure-DB tools (create/update_lead, create_appointment,
 *   request_callback, send_notification/internal): the side effect and the
 *   stored outcome commit in ONE transaction. A crash either rolls both
 *   back (retry re-executes onto clean state) or commits both (retry
 *   replays the stored outcome). Exactly-once per operation. VERIFIED by
 *   the atomicity tests (outcome-store failure rolls the effect back).
 * - transfer_call: the gateway dial cannot join a DB transaction, so the
 *   atomic claim commits first and a same-operation retry RECONCILES
 *   (TRANSFERRED returns without re-dialing; mid-flight/failed states
 *   re-issue with a stable provider idempotencyKey). Exactly-once per
 *   operation IF the gateway honors idempotencyKey; otherwise
 *   at-least-once across the crash-during-dial window only (all other
 *   cases dedup via the claim + outcome row). PARTIAL by nature of the
 *   provider boundary — see docs/VOICE-STAGING.md.
 * - send_notification/email: SMTP cannot be transactional. Internal
 *   (default) is exactly-once per operation; email is at-least-once
 *   across crash windows (a crash after provider-send but before commit
 *   re-sends on retry), deduped everywhere else by the idempotency key.
 * - Reads (search tools, check_availability, get_business_info): no side
 *   effects; the stored outcome is a replay cache (saves provider cost
 *   and keeps crash-retries on identical rails).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { db, type DbExecutor } from "@/db";
import { auditLogs, businesses, callMessages } from "@/db/schema";
import { advisoryXactLock } from "@/lib/tx";
import { AppError } from "@/lib/errors";
import type { ToolResultStatus } from "@/lib/guardrails";
import { logError, logInfo } from "@/lib/logger";
import { PropertySearchSchema, searchProperties } from "@/lib/services/properties";
import {
  LeadExtractionSchema,
  createOrUpdateLead,
  getLead,
  normalizeLeadExtraction,
} from "@/lib/services/leads";
import { findOrCreateCustomer } from "@/lib/services/customers";
import { checkAvailability, createAppointment } from "@/lib/services/appointments";
import { hybridSearch } from "@/lib/services/knowledge";
import { notify } from "@/lib/services/notifications";
import { requestTransfer } from "@/lib/services/calls";
import { normalizePersianText } from "@/lib/normalization";
import { and as dbAnd, eq as dbEq } from "drizzle-orm";

export type ToolContext = {
  businessId: string;
  callId?: string;
  userId?: string;
  requestId: string;
  /** Who invoked the tool: "voice-webhook" | "agent-runtime" | "api" | user id. */
  actor: string;
  /**
   * Stable operation identity for this execution (the toolExecId when run
   * through executeIdempotentToolCall). Handlers MUST derive any
   * downstream idempotency keys from this — never from requestId, which
   * changes across crash-retries.
   */
  idempotencyKey?: string;
  /**
   * Database executor for this execution. Set to the outcome transaction by
   * executeIdempotentToolCall so DB-backed side effects commit atomically
   * with the stored outcome (true crash safety: a crash can neither lose
   * the outcome of a committed effect nor keep the effect of a lost
   * outcome). Absent for direct (non-idempotent) executions.
   *
   * Handlers with un-rollbackable external effects (transfer_call's gateway
   * HTTP call) deliberately IGNORE this and manage their own
   * claim-then-reconcile protocol instead — see requestTransfer.
   */
  db?: DbExecutor;
};

export type ToolResult = {
  status: ToolResultStatus;
  /** JSON-safe result payload (only on SUCCESS). */
  data?: unknown;
  /** Human-safe error message (never includes secrets). */
  error?: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodType<Record<string, unknown>>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};

// ---------------------------------------------------------------------------
// Tool implementations (tenant scope ALWAYS comes from ctx, never from args)
// ---------------------------------------------------------------------------

const searchKnowledgeTool: ToolDefinition = {
  name: "search_knowledge",
  description:
    "Search the business knowledge base for verified facts (services, pricing, policies, FAQs). Use before answering factual questions.",
  schema: z.object({ query: z.string().min(2).max(500), topK: z.number().int().min(1).max(10).default(5) }),
  handler: async (args, ctx) => {
    const { query, topK } = args as { query: string; topK: number };
    const { chunks, degraded } = await hybridSearch({
      businessId: ctx.businessId,
      query,
      topK,
      requestId: ctx.requestId,
    });
    if (chunks.length === 0) {
      return { status: "NOT_FOUND", error: "No relevant knowledge found." };
    }
    return {
      status: "SUCCESS",
      data: {
        results: chunks.map((c) => ({ document: c.documentTitle, content: c.content.slice(0, 1500), score: c.score })),
        degraded,
      },
    };
  },
};

const getBusinessInfoTool: ToolDefinition = {
  name: "get_business_info",
  description: "Get verified business profile: name, phone, address, working hours, transfer availability.",
  schema: z.object({}),
  handler: async (_args, ctx) => {
    const [biz] = await db.select().from(businesses).where(dbEq(businesses.id, ctx.businessId)).limit(1);
    if (!biz) return { status: "NOT_FOUND", error: "Business not found." };
    const settings = (biz.settings as Record<string, unknown>) ?? {};
    return {
      status: "SUCCESS",
      data: {
        name: biz.name,
        phone: biz.phone,
        address: biz.address,
        timezone: biz.timezone,
        language: biz.language,
        scheduling: settings.scheduling ?? null,
        transferConfigured: Boolean((settings.transfer as Record<string, unknown> | undefined)?.number ?? biz.phone),
      },
    };
  },
};

const searchPropertiesTool: ToolDefinition = {
  name: "search_properties",
  description:
    "Search real-estate listings for this business. ONLY mention properties returned by this tool. Never invent listings, prices, or availability.",
  schema: PropertySearchSchema as unknown as z.ZodType<Record<string, unknown>>,
  handler: async (args, ctx) => {
    const results = await searchProperties(ctx.businessId, args);
    if (results.length === 0) return { status: "NOT_FOUND", error: "No matching properties found." };
    return { status: "SUCCESS", data: { properties: results } };
  },
};

const createLeadTool: ToolDefinition = {
  name: "create_lead",
  description:
    "Create or update a sales lead from caller information (name, phone, intent, location, budget, area, bedrooms). Dedplicates automatically.",
  schema: LeadExtractionSchema as unknown as z.ZodType<Record<string, unknown>>,
  handler: async (args, ctx) => {
    const extraction = normalizeLeadExtraction(args);
    if (!extraction.phone) {
      return { status: "FAILED", error: "A valid caller phone number is required to create a lead." };
    }
    const customer = await findOrCreateCustomer({
      businessId: ctx.businessId,
      phone: extraction.phone,
      name: extraction.name ?? undefined,
      db: ctx.db,
    });
    const { lead, outcome } = await createOrUpdateLead({
      businessId: ctx.businessId,
      customerId: customer.id,
      extraction,
      source: "call",
      callId: ctx.callId,
      db: ctx.db,
    });
    return { status: "SUCCESS", data: { leadId: lead.id, customerId: customer.id, outcome, leadStatus: lead.status } };
  },
};

const updateLeadTool: ToolDefinition = {
  name: "update_lead",
  description: "Update an existing lead's fields or status. Lead must belong to this business.",
  schema: z.object({
    leadId: z.string().uuid(),
    status: z
      .enum(["NEW", "CONTACTED", "QUALIFIED", "VISIT_REQUESTED", "VISIT_SCHEDULED", "NEGOTIATION", "WON", "LOST"])
      .optional(),
    notes: z.string().max(2000).optional(),
    budgetMin: z.union([z.string(), z.number()]).optional(),
    budgetMax: z.union([z.string(), z.number()]).optional(),
    location: z.string().max(500).optional(),
    bedrooms: z.union([z.string(), z.number()]).optional(),
  }),
  handler: async (args, ctx) => {
    const { leads } = await import("@/db/schema");
    const lead = await getLead(ctx.businessId, args.leadId as string, ctx.db);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (args.status) patch.status = args.status;
    if (typeof args.notes === "string") patch.notes = normalizePersianText(args.notes);
    if (typeof args.location === "string") patch.location = normalizePersianText(args.location);
    const { parseBedrooms, parsePrice } = await import("@/lib/normalization");
    if (args.budgetMin != null) {
      const v = parsePrice(args.budgetMin as string | number)?.amountToman ?? null;
      if (v != null) patch.budgetMin = String(v);
    }
    if (args.budgetMax != null) {
      const v = parsePrice(args.budgetMax as string | number)?.amountToman ?? null;
      if (v != null) patch.budgetMax = String(v);
    }
    if (args.bedrooms != null) {
      const v = parseBedrooms(args.bedrooms as string | number);
      if (v != null) patch.bedrooms = v;
    }
    const [updated] = await (ctx.db ?? db)
      .update(leads)
      .set(patch)
      .where(dbAnd(dbEq(leads.id, lead.id), dbEq(leads.businessId, ctx.businessId)))
      .returning();
    if (!updated) return { status: "FAILED", error: "Lead update failed." };
    return { status: "SUCCESS", data: { leadId: updated.id, status: updated.status } };
  },
};

const checkAvailabilityTool: ToolDefinition = {
  name: "check_availability",
  description: "Check visit-appointment availability for a date (YYYY-MM-DD, business timezone).",
  schema: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    durationMinutes: z.number().int().min(10).max(480).optional(),
  }),
  handler: async (args, ctx) => {
    const result = await checkAvailability({
      businessId: ctx.businessId,
      date: args.date as string,
      durationMinutes: args.durationMinutes as number | undefined,
    });
    const free = result.slots.filter((s) => s.available);
    if (free.length === 0) {
      return { status: "UNAVAILABLE", error: `No availability on ${result.date}.` };
    }
    return { status: "SUCCESS", data: { date: result.date, timezone: result.timezone, slots: free.slice(0, 12) } };
  },
};

const createAppointmentTool: ToolDefinition = {
  name: "create_appointment",
  description:
    "Book a visit appointment at an available ISO time. NEVER claim success unless this tool returns SUCCESS.",
  schema: z.object({
    scheduledAt: z.string().datetime({ offset: true }),
    durationMinutes: z.number().int().min(10).max(480).default(30),
    leadId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    notes: z.string().max(2000).optional(),
  }),
  handler: async (args, ctx) => {
    try {
      const created = await createAppointment(ctx.businessId, args, { requestId: ctx.requestId, db: ctx.db });
      return {
        status: "SUCCESS",
        data: { appointmentId: created.id, scheduledAt: created.scheduledAt, durationMinutes: created.durationMinutes },
      };
    } catch (err) {
      if (err instanceof AppError && err.code === "APPOINTMENT_CONFLICT") {
        return { status: "UNAVAILABLE", error: err.message };
      }
      throw err;
    }
  },
};

const requestCallbackTool: ToolDefinition = {
  name: "request_callback",
  description: "Register a callback request so a human agent calls the customer back.",
  schema: z.object({
    phone: z.string().min(5).max(30),
    reason: z.string().max(500).optional(),
    leadId: z.string().uuid().optional(),
  }),
  handler: async (args, ctx) => {
    const { normalizePhone } = await import("@/lib/normalization");
    const phone = normalizePhone(String(args.phone ?? ""));
    if (!phone) return { status: "FAILED", error: "Invalid phone number for callback." };
    const { notifyCallbackRequested } = await import("@/lib/services/notifications");
    const result = await notifyCallbackRequested({
      businessId: ctx.businessId,
      leadId: args.leadId as string | undefined,
      phone,
      requestId: ctx.requestId,
      // Stable across crash-retries when executed idempotently; the
      // requestId fallback preserves legacy direct-execution behavior.
      idempotencyKey: ctx.idempotencyKey ? `tool:${ctx.idempotencyKey}` : `tool:${ctx.requestId}:callback`,
      db: ctx.db,
    });
    return { status: "SUCCESS", data: { callbackId: result.id, phone } };
  },
};

const transferCallTool: ToolDefinition = {
  name: "transfer_call",
  description:
    "Transfer the live call to a human agent. Returns TRANSFERRED only when the handoff truly succeeded.",
  schema: z.object({ reason: z.string().max(500).optional(), destination: z.string().max(30).optional() }),
  handler: async (args, ctx) => {
    if (!ctx.callId) return { status: "FAILED", error: "No live call to transfer." };
    // NOTE: transfer deliberately does NOT join ctx.db — its atomic claim
    // must COMMIT before the un-rollbackable gateway HTTP call. Crash
    // safety comes from claim-then-reconcile keyed by the execution id.
    const result = await requestTransfer(ctx.businessId, ctx.callId, {
      destination: args.destination as string | undefined,
      reason: args.reason as string | undefined,
      requestId: ctx.requestId,
      idempotencyKey: ctx.idempotencyKey,
    });
    if (result.status === "TRANSFERRED") {
      return { status: "SUCCESS", data: { destination: result.destination, message: result.message } };
    }
    return { status: "UNAVAILABLE", error: result.message };
  },
};

const sendNotificationTool: ToolDefinition = {
  name: "send_notification",
  description: "Send an internal notification to the business team (e.g. follow-up needed, VIP caller).",
  schema: z.object({
    title: z.string().min(2).max(255),
    message: z.string().min(2).max(2000),
    userId: z.string().uuid().optional(),
  }),
  handler: async (args, ctx) => {
    const targetUserId = (args.userId as string | undefined) ?? null;
    if (targetUserId) {
      // The LLM supplies userIds: prove same-tenant membership (404 →
      // tool NOT_FOUND) instead of trusting the model / FK existence.
      const { assertUserInBusiness } = await import("@/lib/auth");
      await assertUserInBusiness(ctx.businessId, targetUserId);
    }
    const result = await notify({
      businessId: ctx.businessId,
      userId: targetUserId,
      type: "agent_note",
      channel: "internal",
      title: normalizePersianText(String(args.title)),
      message: normalizePersianText(String(args.message)),
      idempotencyKey: ctx.idempotencyKey
        ? `tool:${ctx.idempotencyKey}`
        : `tool:${ctx.requestId}:${String(args.title).slice(0, 40)}`,
      requestId: ctx.requestId,
      metadata: { callId: ctx.callId, actor: ctx.actor },
      db: ctx.db,
    });
    return { status: "SUCCESS", data: { notificationId: result.id } };
  },
};

const TOOLS: Record<string, ToolDefinition> = {
  search_knowledge: searchKnowledgeTool,
  get_business_info: getBusinessInfoTool,
  search_properties: searchPropertiesTool,
  create_lead: createLeadTool,
  update_lead: updateLeadTool,
  check_availability: checkAvailabilityTool,
  create_appointment: createAppointmentTool,
  request_callback: requestCallbackTool,
  transfer_call: transferCallTool,
  send_notification: sendNotificationTool,
};

export function listTools(): ToolDefinition[] {
  return Object.values(TOOLS);
}

/** JSON-Schema tool definitions for the LLM (derived from the zod schemas). */
export function getToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return listTools().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: z.toJSONSchema(t.schema as z.ZodType) as unknown as Record<string, unknown>,
  }));
}

async function auditToolCall(ctx: ToolContext, tool: string, status: string, ok: boolean): Promise<void> {
  try {
    await (ctx.db ?? db).insert(auditLogs).values({
      businessId: ctx.businessId,
      actorType: "tool",
      actorId: ctx.actor,
      action: `tool.${tool}`,
      entityType: "call",
      entityId: ctx.callId ?? null,
      requestId: ctx.requestId,
      metadata: { status, ok },
    });
  } catch (err) {
    logError("Tool audit logging failed", { requestId: ctx.requestId, businessId: ctx.businessId, operation: "tool.audit", status: "error", error: err });
  }
}

/**
 * Execute a single tool call from the LLM / voice webhook.
 * - Unknown tools → FAILED (never throws for unknown names; the LLM can recover)
 * - Args validated with zod; tenant context comes ONLY from ctx
 * - All executions are audit-logged
 */
export async function executeToolCall(input: {
  businessId: string;
  callId?: string;
  userId?: string;
  tool: string;
  args: Record<string, unknown>;
  requestId: string;
  actor: string;
  /** Stable operation identity (see ToolContext.idempotencyKey). */
  idempotencyKey?: string;
  /** Run DB-backed side effects inside this executor (see ToolContext.db). */
  db?: DbExecutor;
}): Promise<ToolResult> {
  const ctx: ToolContext = {
    businessId: input.businessId,
    callId: input.callId,
    userId: input.userId,
    requestId: input.requestId,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    db: input.db,
  };
  const tool = TOOLS[input.tool];
  if (!tool) {
    await auditToolCall(ctx, input.tool, "UNKNOWN_TOOL", false);
    return { status: "FAILED", error: `Unknown tool: ${input.tool}` };
  }

  // Strip tenant-sensitive keys if the LLM echoed them; ctx is authoritative.
  const sanitized = { ...input.args };
  delete sanitized.businessId;
  delete sanitized.business_id;
  delete sanitized.callId;
  delete sanitized.call_id;

  const parsed = tool.schema.safeParse(sanitized);
  if (!parsed.success) {
    await auditToolCall(ctx, tool.name, "INVALID_ARGS", false);
    return {
      status: "FAILED",
      error: `Invalid arguments for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  }

  logInfo("Tool started", {
    requestId: ctx.requestId,
    businessId: ctx.businessId,
    callId: ctx.callId,
    operation: `tool.${tool.name}`,
    status: "started",
  });

  const toolStart = Date.now();
  try {
    const result = await tool.handler(parsed.data as Record<string, unknown>, ctx);
    await auditToolCall(ctx, tool.name, result.status, result.status === "SUCCESS");
    logInfo("Tool executed", {
      requestId: ctx.requestId,
      businessId: ctx.businessId,
      callId: ctx.callId,
      operation: `tool.${tool.name}`,
      durationMs: Date.now() - toolStart,
      status: result.status,
    });
    return result;
  } catch (err) {
    const message = err instanceof AppError ? err.message : "Tool execution failed";
    await auditToolCall(ctx, tool.name, "ERROR", false);
    logError("Tool execution failed", {
      requestId: ctx.requestId,
      businessId: ctx.businessId,
      callId: ctx.callId,
      operation: `tool.${tool.name}`,
      status: "error",
      error: err,
    });
    if (err instanceof AppError && (err.code === "NOT_FOUND" || String(err.code).endsWith("_NOT_FOUND"))) {
      return { status: "NOT_FOUND", error: message };
    }
    return { status: "FAILED", error: message };
  }
}

// ---------------------------------------------------------------------------
// Tool-level idempotency (P0-3): stored outcomes keyed by execution identity
// ---------------------------------------------------------------------------

export type StoredToolOutcome = { status: string; data?: unknown; error?: string | null };

/** Deterministic JSON encoding (sorted keys, recursive) for args hashing. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Derive a stable execution id for an agent-loop tool call. Keyed on the
 * OPERATION (turn event + tool + canonical args), not the attempt: LLM
 * toolCall ids are not stable across retries, but the same operation
 * re-emitted after a crash must replay — never re-execute.
 */
export function deriveToolExecId(eventId: string, tool: string, args: Record<string, unknown>): string {
  const hash = createHash("sha256").update(`${tool}:${stableStringify(args)}`).digest("hex").slice(0, 16);
  return `${eventId}:tool:${tool}:${hash}`.slice(0, 255);
}

/**
 * Execute a tool exactly once per (callId, toolExecId): concurrent
 * duplicates serialize on an advisory lock and the loser reads the STORED
 * outcome. Outcomes persist as TOOL-role call messages so a crash-retry of
 * the same turn replays instead of duplicating side effects (leads,
 * appointments, notifications, transfers).
 *
 * Crash safety is REAL, not just race safety: the outcome check, the tool
 * execution, and the outcome store all run inside ONE database transaction
 * (DB-backed handlers receive `tx` via ctx.db). A crash can therefore never
 * commit a side effect without its outcome row, nor an outcome row without
 * its side effect — retries either replay the stored outcome or re-execute
 * onto clean state. The sole exception is transfer_call, whose gateway HTTP
 * call cannot join a DB transaction: it reconciles via its own
 * claim-then-reconcile protocol keyed by the same execution id.
 *
 * Both entry points share this: the voice tool-call webhook (provider
 * event_id) and the agent runtime loop (derived execution ids).
 */
export async function executeIdempotentToolCall(input: {
  businessId: string;
  callId: string;
  /** Execution identity: provider event_id (webhook) or derived id (agent loop). */
  toolExecId: string;
  tool: string;
  args: Record<string, unknown>;
  requestId: string;
  actor: string;
}): Promise<{ result: ToolResult; duplicate: boolean }> {
  return db.transaction(async (tx) => {
    await advisoryXactLock(tx, `tool-exec:${input.callId}:${input.toolExecId}`);
    const [existing] = await tx
      .select({ metadata: callMessages.metadata })
      .from(callMessages)
      .where(dbAnd(dbEq(callMessages.callId, input.callId), dbEq(callMessages.eventId, input.toolExecId)))
      .limit(1);
    if (existing) {
      const stored = (existing.metadata as Record<string, unknown>)?.outcome as StoredToolOutcome | undefined;
      if (stored && typeof stored.status === "string") {
        logInfo("Tool outcome replayed (idempotent)", {
          requestId: input.requestId,
          businessId: input.businessId,
          callId: input.callId,
          operation: `tool.${input.tool}`,
          status: stored.status,
        });
        return {
          result: { status: stored.status, data: stored.data, error: stored.error ?? undefined } as ToolResult,
          duplicate: true,
        };
      }
      // Row exists but holds no outcome (shouldn't happen) — never rerun blindly.
      return {
        result: { status: "FAILED", error: "Tool execution already recorded" } as ToolResult,
        duplicate: true,
      };
    }

    // The handler runs INSIDE this transaction (ctx.db = tx): its writes and
    // the outcome insert below commit or roll back together. This closes the
    // crash window the naive check-execute-store leaves open.
    const result = await executeToolCall({
      businessId: input.businessId,
      callId: input.callId,
      tool: input.tool,
      args: input.args,
      requestId: input.requestId,
      actor: input.actor,
      idempotencyKey: input.toolExecId,
      db: tx,
    });

    await tx
      .insert(callMessages)
      .values({
        callId: input.callId,
        role: "TOOL",
        content: JSON.stringify({ tool: input.tool, status: result.status }),
        eventId: input.toolExecId,
        metadata: {
          tool: input.tool,
          status: result.status,
          requestId: input.requestId,
          actor: input.actor,
          outcome: { status: result.status, data: result.data ?? null, error: result.error ?? null } satisfies StoredToolOutcome,
        },
      })
      .onConflictDoNothing({ target: [callMessages.callId, callMessages.eventId] });

    return { result, duplicate: false };
  });
}

