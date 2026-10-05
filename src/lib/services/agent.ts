import { meteredCompletion } from "@/lib/services/metered-ai";
import { loadAgentMemory, summarizeConversation } from "@/lib/services/memory";
import { hybridSearch } from "@/lib/services/knowledge";
import { requireTenantFeature } from "@/lib/tenant-config";
import { assertTenantScope } from "@/lib/request-context";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, businesses, callMessages, calls } from "@/db/schema";
import { collectRagEvidence, evidencePrompt, evidenceFallback, isKnowledgeDenial } from "@/lib/rag-evidence";
import { AppError } from "@/lib/errors";
import { TOOL_FAILURE_MESSAGE_FA, UNKNOWN_INFO_MESSAGE_FA, buildSystemPrompt } from "@/lib/guardrails";
import { logWarn } from "@/lib/logger";
import { getLLMProvider, type ChatMessage, type LLMProvider } from "@/lib/providers/llm";
import { normalizePersianText } from "@/lib/normalization";
import { recordLlmUsage } from "@/lib/services/usage";
import { executeToolCall, getToolDefinitions } from "@/lib/tools/registry";

export const AgentConfigSchema = z.object({
  agentName: z.string().max(150).optional(),
  greeting: z.string().max(1000).optional(),
  tone: z.string().max(500).optional(),
  language: z.string().max(20).default("fa"),
  businessInfo: z.string().max(5000).optional(),
  transferNumber: z.string().max(30).optional(),
  fallbackBehavior: z.string().max(1000).optional(),
  systemInstructions: z.string().max(5000).optional(),
  memoryEnabled: z.boolean().default(false),
  retrievalMode: z.enum(["tools", "automatic"]).default("tools"),
  model: z.string().min(1).max(150).nullable().optional(),
  allowedTools: z.array(z.string().min(1).max(100)).max(50).nullable().optional(),
  temperature: z.number().min(0).max(2).default(0.2),
  maxToolIterations: z.number().int().min(1).max(10).default(5),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

const MAX_HISTORY_MESSAGES = 30;

async function loadAgent(businessId: string, agentId?: string) {
  if (agentId) {
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.businessId, businessId), eq(agents.isActive, true)))
      .limit(1);
    if (!row) throw new AppError(404, "AGENT_NOT_FOUND", "Agent not found");
    return row;
  }
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.businessId, businessId), eq(agents.isActive, true)))
    .orderBy(desc(agents.createdAt))
    .limit(1);
  if (!row) throw new AppError(404, "AGENT_NOT_FOUND", "No active agent configured for this business");
  return row;
}

function parseAgentConfig(agent: typeof agents.$inferSelect): AgentConfig {
  const raw = (agent.configuration as Record<string, unknown>) ?? {};
  const parsed = AgentConfigSchema.safeParse({
    agentName: agent.name,
    language: agent.language?.startsWith("fa") ? "fa" : agent.language,
    ...raw,
  });
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Agent configuration is invalid; correct it before running the agent");
  }
  return parsed.data;
}

async function loadCallHistory(businessId: string, callId: string): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(callMessages)
    .where(and(eq(callMessages.callId, callId), eq(callMessages.businessId, businessId)))
    .orderBy(desc(callMessages.timestamp))
    .limit(MAX_HISTORY_MESSAGES);
  return rows.reverse().map((r) => ({
    role: r.role === "CUSTOMER" ? "user" : r.role === "AGENT" ? "assistant" : "user",
    content: r.content,
  }));
}

export type AgentTurnInput = {
  businessId: string;
  agentId?: string;
  callId?: string;
  /** Latest caller utterance (Persian). */
  userMessage: string;
  requestId: string;
  actor?: string;
  /** Provider override for tests/embeddings; defaults to the configured LLM. */
  llm?: LLMProvider;
};

export type AgentTurnResult = {
  reply: string;
  toolCalls: Array<{ tool: string; status: string }>;
  agentId: string;
  /** Tenant-configured voice for this agent (synthesis override; see voice-safety). */
  voiceId: string;
  usage: { inputTokens: number; outputTokens: number };
};

/**
 * The real AI runtime: guardrailed system prompt + RAG/property context +
 * bounded tool-calling loop + usage tracking.
 *
 * The LLM never touches the database; all side effects go through the
 * audited tool registry with tenant context.
 */
export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  assertTenantScope(input.businessId);
  await requireTenantFeature(input.businessId, "agent");
  // Normalize Persian input BEFORE any downstream processing (tool parsing,
  // history persistence, LLM): ي/ي, ک/ك, digits, tashkeel, spacing.
  const userMessage = normalizePersianText(input.userMessage).trim().slice(0, 4000);
  if (!userMessage) throw new AppError(400, "INVALID_PAYLOAD", "Message must not be empty");

  if (input.callId) {
    // Tenant check FIRST: callIds arrive from callers (dashboard playground,
    // voice loop), so a foreign id must 404 before any history is loaded,
    // written, or billed — never leak another tenant's transcript.
    const [call] = await db
      .select({ id: calls.id })
      .from(calls)
      .where(and(eq(calls.id, input.callId), eq(calls.businessId, input.businessId)))
      .limit(1);
    if (!call) throw new AppError(404, "CALL_NOT_FOUND", "Call not found");
  }
  const [agent, business] = await Promise.all([
    loadAgent(input.businessId, input.agentId),
    db.select().from(businesses).where(eq(businesses.id, input.businessId)).limit(1).then((r) => r[0] ?? null),
  ]);
  if (!business) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
  const config = parseAgentConfig(agent);

  const history: ChatMessage[] = input.callId ? await loadCallHistory(input.businessId, input.callId) : [];
  history.push({ role: "user", content: userMessage });

  // Preload lightweight business context for the prompt (no secrets).
  const settings = (business.settings as Record<string, unknown>) ?? {};
  const businessContext = [
    `نام: ${business.name}`,
    business.phone ? `تلفن: ${business.phone}` : null,
    business.address ? `نشانی: ${business.address}` : null,
    config.businessInfo ?? null,
  ]
    .filter(Boolean)
    .join("\n");
  void settings;

  let systemPrompt = buildSystemPrompt({
    language: config.language,
    businessName: business.name,
    agentName: config.agentName ?? agent.name,
    greeting: config.greeting,
    tone: config.tone,
    businessInstructions: [agent.systemPrompt, config.systemInstructions].filter(Boolean).join("\n"),
    businessContext,
  });

  if (config.memoryEnabled && input.callId) systemPrompt += "\n" + await loadAgentMemory(input.businessId, input.callId);
  const llm = input.llm ?? getLLMProvider();
  const tools = getToolDefinitions().filter((tool) => !config.allowedTools || config.allowedTools.includes(tool.name));
  const allowedTools = new Set(tools.map((tool) => tool.name));
  const evidence = new Map<string, { document: string; content: string }>();
  if (config.retrievalMode === "automatic" && allowedTools.has("search_knowledge")) {
    const found = await hybridSearch({ businessId: input.businessId, query: userMessage, topK: 5, requestId: input.requestId });
    for (const chunk of found.chunks) evidence.set(chunk.id, { document: chunk.documentTitle, content: chunk.content.slice(0, 1500) });
  }
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt + (evidence.size ? "\n" + evidencePrompt([...evidence.values()]) : "") }, ...history.slice(-MAX_HISTORY_MESSAGES)];

  let inputTokens = 0;
  let outputTokens = 0;
  const executed: Array<{ tool: string; status: string }> = [];
  let reply: string | null = null;
  let idempotencySeq = 0;

  for (let iteration = 0; iteration < config.maxToolIterations; iteration++) {
    const result = await meteredCompletion(input.businessId, llm, messages, {
      model: config.model ?? undefined,
      tools,
      toolChoice: "auto",
      temperature: config.temperature,
      requestId: input.requestId,
      businessId: input.businessId,
      callId: input.callId,
    });
    inputTokens += result.usage.inputTokens ?? 0;
    outputTokens += result.usage.outputTokens ?? 0;
    await recordLlmUsage({
      businessId: input.businessId,
      usage: result.usage,
      provider: llm.name,
      model: result.model,
      idempotencyKey: `agent:${input.requestId}:${idempotencySeq++}`,
      metadata: { callId: input.callId, agentId: agent.id },
    });

    if (result.toolCalls.length === 0) {
      reply = result.content?.trim() || null;
      break;
    }

    messages.push({
      role: "assistant",
      content: result.content ?? "",
      toolCalls: result.toolCalls.map((t) => ({ id: t.id, name: t.name, arguments: JSON.stringify(t.arguments), thoughtSignature: t.thoughtSignature })),
    });

    for (const tc of result.toolCalls) {
      const toolResult = allowedTools.has(tc.name) ? await executeToolCall({
        businessId: input.businessId,
        callId: input.callId,
        tool: tc.name,
        args: tc.arguments,
        requestId: input.requestId,
        actor: input.actor ?? "agent-runtime",
      }) : { status: "FAILED" as const, error: "Tool is not allowed for this agent" };
      if (tc.name === "search_knowledge" && toolResult.status === "SUCCESS") {
        for (const item of collectRagEvidence(toolResult.data)) evidence.set(`${item.document}:${item.content}`, item);
      }
      executed.push({ tool: tc.name, status: toolResult.status });
      messages.push({
        role: "tool",
        toolCallId: tc.id,
        content: JSON.stringify({
          status: toolResult.status,
          ...(toolResult.status === "SUCCESS" ? { data: toolResult.data } : { error: toolResult.error }),
        }).slice(0, 8000),
      });
    }
    // Rebuild from original system instructions, never accumulate arbitrary
    // tool text as instructions. Evidence is bounded, quoted, and read-only.
    if (evidence.size) messages[0] = { role: "system", content: systemPrompt + "\n" + evidencePrompt([...evidence.values()]) };
  }

  if (evidence.size && (!reply || isKnowledgeDenial(reply))) {
    reply = evidenceFallback([...evidence.values()], config.language);
  }

  if (!reply) {
    logWarn("Agent turn exhausted tool iterations without a reply", {
      requestId: input.requestId,
      businessId: input.businessId,
      callId: input.callId,
      operation: "agent.turn",
      status: "no_reply",
    });
    reply = UNKNOWN_INFO_MESSAGE_FA;
  }

  // Persist the turn to the call transcript when part of a call.
  if (input.callId) {
    const [call] = await db
      .select({ id: calls.id })
      .from(calls)
      .where(and(eq(calls.id, input.callId), eq(calls.businessId, input.businessId)))
      .limit(1);
    if (call) {
      await db.insert(callMessages).values([
        { businessId: input.businessId, callId: input.callId, role: "CUSTOMER", content: userMessage },
        { businessId: input.businessId, callId: input.callId, role: "AGENT", content: reply },
      ]);
    }
  }

  if (config.memoryEnabled && input.callId) {
    try { await summarizeConversation({ businessId: input.businessId, callId: input.callId, requestId: input.requestId, llm, model: config.model ?? undefined }); }
    catch (error) { logWarn("Conversation summary unavailable", { businessId: input.businessId, callId: input.callId, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { reply, toolCalls: executed, agentId: agent.id, voiceId: agent.voiceId, usage: { inputTokens, outputTokens } };
}

/** Safe fallback reply when the LLM call itself fails. */
export function agentFailureReply(): string {
  return TOOL_FAILURE_MESSAGE_FA;
}
