import { z } from "zod";
import { db } from "@/db";
import { auditLogs, businesses } from "@/db/schema";
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
      const created = await createAppointment(ctx.businessId, args, { requestId: ctx.requestId });
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
  tool: string;
  args: Record<string, unknown>;
  requestId: string;
  actor: string;
}): Promise<ToolResult> {
  const ctx: ToolContext = {
    businessId: input.businessId,
    callId: input.callId,
    userId: input.userId,
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

