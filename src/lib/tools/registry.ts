import { z } from "zod";
import { db } from "@/db";
import { auditLogs, businesses, calls } from "@/db/schema";
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
import { checkAvailability, createAppointment, localSlotTime } from "@/lib/services/appointments";
import { hybridSearch } from "@/lib/services/knowledge";
import { KnowledgeMetadataFiltersSchema, runtimePrincipal } from "@/lib/rag/access";
import { notify } from "@/lib/services/notifications";
import { requestTransfer } from "@/lib/services/calls";
import { normalizePersianText, normalizePhone } from "@/lib/normalization";
import { and as dbAnd, eq as dbEq } from "drizzle-orm";

export type ToolContext = {
  businessId: string;
  callId?: string;
  userId?: string;
  /** Agent answering the call, when the tool runs inside the AI runtime. */
  agentId?: string | null;
  requestId: string;
  /** Who invoked the tool: "voice-webhook" | "agent-runtime" | "api" | user id. */
  actor: string;
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
    // Runtime principal: TENANT/AGENT/CATEGORY documents are searchable, while
    // role- or user-restricted documents stay invisible to a caller-facing AI.
    const { chunks, degraded } = await hybridSearch({
      businessId: ctx.businessId,
      query,
      topK,
      requestId: ctx.requestId,
      scope: { principal: runtimePrincipal({ agentId: ctx.agentId ?? null }), filters: KnowledgeMetadataFiltersSchema.parse({}) },
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
    });
    const { lead, outcome } = await createOrUpdateLead({
      businessId: ctx.businessId,
      customerId: customer.id,
      extraction,
      source: "call",
      callId: ctx.callId,
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
    const lead = await getLead(ctx.businessId, args.leadId as string);
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
    const [updated] = await db
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
  description:
    "Check visit-appointment availability for a date (YYYY-MM-DD, business timezone). Pass `time` (HH:MM, local) when the caller asked for a specific time: the result says whether exactly that time is free and gives the nearest free alternatives. Times are local; book with the returned `scheduledAt` unchanged.",
  schema: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    durationMinutes: z.number().int().min(10).max(480).optional(),
  }),
  handler: async (args, ctx) => {
    const result = await checkAvailability({
      businessId: ctx.businessId,
      date: args.date as string,
      durationMinutes: args.durationMinutes as number | undefined,
    });
    const local = result.slots.map((slot) => ({ ...localSlotTime(slot.start, result.timezone), available: slot.available }));
    const free = local.filter((s) => s.available).map(({ time, scheduledAt }) => ({ time, scheduledAt }));
    const requested = args.time as string | undefined;
    if (requested) {
      const match = local.find((s) => s.time === requested);
      const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
      const alternatives = [...free]
        .sort((a, b) => Math.abs(minutes(a.time) - minutes(requested)) - Math.abs(minutes(b.time) - minutes(requested)))
        .slice(0, 3)
        .sort((a, b) => minutes(a.time) - minutes(b.time));
      if (match?.available) {
        return {
          status: "SUCCESS",
          data: { date: result.date, timezone: result.timezone, requestedTime: requested, requestedTimeAvailable: true,
            scheduledAt: match.scheduledAt },
        };
      }
      if (alternatives.length === 0) {
        return { status: "UNAVAILABLE", error: `No availability on ${result.date}.` };
      }
      return {
        status: "SUCCESS",
        data: { date: result.date, timezone: result.timezone, requestedTime: requested, requestedTimeAvailable: false,
          reason: match ? "already booked" : "outside working hours", alternatives },
      };
    }
    if (free.length === 0) {
      return { status: "UNAVAILABLE", error: `No availability on ${result.date}.` };
    }
    return { status: "SUCCESS", data: { date: result.date, timezone: result.timezone, slots: free.slice(0, 16) } };
  },
};

const createAppointmentTool: ToolDefinition = {
  name: "create_appointment",
  description:
    "Book a visit appointment for an identified caller at a `scheduledAt` returned by check_availability (pass it unchanged). Pass the leadId returned by create_lead (or a customerId); if the caller is not identified yet, first ask their name and phone number and call create_lead. NEVER claim success unless this tool returns SUCCESS.",
  schema: z.object({
    scheduledAt: z.string().datetime({ offset: true }),
    durationMinutes: z.number().int().min(10).max(480).default(30),
    leadId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    notes: z.string().max(2000).optional(),
  }),
  handler: async (args, ctx) => {
    // An appointment nobody can be contacted about is worse than no appointment:
    // a caller who hangs up after "booked" would leave an ownerless slot. Use the
    // caller already linked to this call, else the number they are calling from,
    // otherwise require an explicit lead/customer.
    let leadId = args.leadId as string | undefined;
    let customerId = args.customerId as string | undefined;
    if (!leadId && !customerId && ctx.callId) {
      const [call] = await db
        .select({ leadId: calls.leadId, customerId: calls.customerId, phoneNumber: calls.phoneNumber })
        .from(calls)
        .where(dbAnd(dbEq(calls.id, ctx.callId), dbEq(calls.businessId, ctx.businessId)))
        .limit(1);
      leadId = call?.leadId ?? undefined;
      customerId = call?.customerId ?? undefined;
      // A withheld or malformed caller ID does not normalize and identifies nobody.
      if (!leadId && !customerId && call && normalizePhone(call.phoneNumber)) {
        customerId = (await findOrCreateCustomer({ businessId: ctx.businessId, phone: call.phoneNumber })).id;
      }
    }
    if (!leadId && !customerId) {
      return {
        status: "FAILED",
        error:
          "Nothing was booked: the caller is not identified. Ask for the caller's name and phone number, call create_lead, then call create_appointment again with the returned leadId.",
      };
    }
    try {
      const created = await createAppointment(
        ctx.businessId,
        { ...args, ...(leadId ? { leadId } : {}), ...(customerId ? { customerId } : {}) },
        { requestId: ctx.requestId },
      );
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
      idempotencyKey: `tool:${ctx.requestId}:callback`,
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
    const result = await requestTransfer(ctx.businessId, ctx.callId, {
      destination: args.destination as string | undefined,
      reason: args.reason as string | undefined,
      requestId: ctx.requestId,
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
      idempotencyKey: `tool:${ctx.requestId}:${String(args.title).slice(0, 40)}`,
      requestId: ctx.requestId,
      metadata: { callId: ctx.callId, actor: ctx.actor },
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
    await db.insert(auditLogs).values({
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
  /** Agent answering the call, when the tool runs inside the AI runtime. */
  agentId?: string | null;
  tool: string;
  args: Record<string, unknown>;
  requestId: string;
  actor: string;
}): Promise<ToolResult> {
  const ctx: ToolContext = {
    businessId: input.businessId,
    callId: input.callId,
    userId: input.userId,
    agentId: input.agentId ?? null,
    requestId: input.requestId,
    actor: input.actor,
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

  try {
    const result = await tool.handler(parsed.data as Record<string, unknown>, ctx);
    await auditToolCall(ctx, tool.name, result.status, result.status === "SUCCESS");
    logInfo("Tool executed", {
      requestId: ctx.requestId,
      businessId: ctx.businessId,
      callId: ctx.callId,
      operation: `tool.${tool.name}`,
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

