import OpenAI from "openai";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { logError, logInfo } from "@/lib/logger";
import { assertConfigured, mapSdkError, type ProviderUsage } from "@/lib/providers/types";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  /** For role=tool: the tool_call id this message responds to. */
  toolCallId?: string;
  /** Assistant tool calls (OpenAI wire shape, simplified). */
  toolCalls?: Array<{ id: string; name: string; arguments: string; thoughtSignature?: string }>;
};

export type LlmToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema object for the tool input. */
  parameters: Record<string, unknown>;
};

export type LlmToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ChatCompletionOptions = {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: LlmToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
  /** Structured output: name + JSON schema the response must follow. */
  responseFormat?: { name: string; schema: Record<string, unknown>; strict?: boolean };
  timeoutMs?: number;
  maxRetries?: number;
  /** Caller context for logging (never sent to the provider as secrets). */
  requestId?: string;
  businessId?: string;
  callId?: string;
};

export type ChatCompletionResult = {
  content: string | null;
  toolCalls: LlmToolCall[];
  finishReason: string | null;
  usage: ProviderUsage;
  model: string;
  latencyMs: number;
};

export interface LLMProvider {
  readonly name: string;
  complete(messages: ChatMessage[], options?: ChatCompletionOptions): Promise<ChatCompletionResult>;
}

type OpenAIProviderOptions = {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
};

function toWireMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: "function" as const,
          function: { name: t.name, arguments: t.arguments },
          ...(t.thoughtSignature ? { extra_content: { google: { thought_signature: t.thoughtSignature } } } : {}),
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

abstract class BaseOpenAiChatProvider implements LLMProvider {
  abstract readonly name: string;
  protected client: OpenAI;
  protected defaultModel: string;

  constructor(opts: OpenAIProviderOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs,
      maxRetries: opts.maxRetries,
    });
    this.defaultModel = opts.model;
  }

  async complete(messages: ChatMessage[], options: ChatCompletionOptions = {}): Promise<ChatCompletionResult> {
    const start = Date.now();
    const model = options.model ?? this.defaultModel;
    try {
      const response = await this.client.chat.completions.create({
        model,
        messages: toWireMessages(messages),
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens,
        tools: options.tools?.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters as Record<string, unknown>,
          },
        })),
        tool_choice: options.toolChoice,
        response_format: options.responseFormat
          ? {
              type: "json_schema" as const,
              json_schema: {
                name: options.responseFormat.name,
                schema: options.responseFormat.schema,
                strict: options.responseFormat.strict ?? true,
              },
            }
          : undefined,
      });

      const choice = response.choices[0];
      const toolCalls: LlmToolCall[] = (choice?.message.tool_calls ?? [])
        .filter((tc) => tc.type === "function")
        .map((tc) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            args = { _raw: tc.function.arguments };
          }
          const extra = (tc as unknown as { extra_content?: { google?: { thought_signature?: string } } }).extra_content;
          return { id: tc.id, name: tc.function.name, arguments: args, thoughtSignature: extra?.google?.thought_signature };
        });

      const usage: ProviderUsage = {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        totalTokens: response.usage?.total_tokens,
      };

      logInfo("LLM completion", {
        requestId: options.requestId,
        businessId: options.businessId,
        callId: options.callId,
        provider: this.name,
        operation: "llm.complete",
        durationMs: Date.now() - start,
        status: "ok",
      });

      return {
        content: choice?.message.content ?? null,
        toolCalls,
        finishReason: choice?.finish_reason ?? null,
        usage,
        model: response.model || model,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      logError("LLM completion failed", {
        requestId: options.requestId,
        businessId: options.businessId,
        callId: options.callId,
        provider: this.name,
        operation: "llm.complete",
        durationMs: Date.now() - start,
        status: "error",
        error: err,
      });
      throw mapSdkError(err, "LLM_ERROR", "LLM completion");
    }
  }

  /** Structured-output completion validated against a zod schema. */
  async completeJson<T>(
    messages: ChatMessage[],
    schema: z.ZodType<T>,
    schemaName: string,
    options: ChatCompletionOptions = {},
  ): Promise<{ data: T; usage: ProviderUsage; model: string }> {
    const jsonSchema = z.toJSONSchema(schema) as unknown as Record<string, unknown>;
    const result = await this.complete(messages, {
      ...options,
      responseFormat: { name: schemaName, schema: jsonSchema, strict: false },
    });
    if (!result.content) {
      throw new AppError(502, "LLM_ERROR", "LLM returned an empty structured response");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      throw new AppError(502, "LLM_ERROR", "LLM returned invalid JSON for structured output");
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new AppError(502, "LLM_ERROR", "LLM structured output failed validation", {
        issues: validated.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    return { data: validated.data, usage: result.usage, model: result.model };
  }
}

export class OpenAIProvider extends BaseOpenAiChatProvider {
  readonly name = "openai";

  constructor(overrides?: Partial<OpenAIProviderOptions>) {
    const e = getEnv();
    super({
      apiKey: overrides?.apiKey ?? e.OPENAI_API_KEY,
      baseURL: overrides?.baseURL ?? e.OPENAI_BASE_URL,
      model: overrides?.model ?? e.LLM_MODEL,
      timeoutMs: overrides?.timeoutMs ?? e.LLM_TIMEOUT_MS,
      maxRetries: overrides?.maxRetries ?? e.LLM_MAX_RETRIES,
    });
    assertConfigured(Boolean(overrides?.apiKey ?? e.OPENAI_API_KEY), "OPENAI_API_KEY is required for LLM_PROVIDER=openai");
  }
}

export class CompatibleLLMProvider extends BaseOpenAiChatProvider {
  readonly name = "compatible";

  constructor(overrides?: Partial<OpenAIProviderOptions>) {
    const e = getEnv();
    super({
      apiKey: overrides?.apiKey ?? e.COMPATIBLE_LLM_API_KEY,
      baseURL: overrides?.baseURL ?? e.COMPATIBLE_LLM_BASE_URL,
      model: overrides?.model ?? e.COMPATIBLE_LLM_MODEL,
      timeoutMs: overrides?.timeoutMs ?? e.LLM_TIMEOUT_MS,
      maxRetries: overrides?.maxRetries ?? e.LLM_MAX_RETRIES,
    });
    assertConfigured(
      Boolean(overrides?.baseURL ?? e.COMPATIBLE_LLM_BASE_URL),
      "COMPATIBLE_LLM_BASE_URL is required for LLM_PROVIDER=compatible",
    );
    assertConfigured(
      Boolean(overrides?.model ?? e.COMPATIBLE_LLM_MODEL),
      "COMPATIBLE_LLM_MODEL is required for LLM_PROVIDER=compatible",
    );
  }
}

/**
 * Explicit development provider. It NEVER fabricates successful completions:
 * it throws a configuration error telling the operator what to set.
 */
export class DevLLMProvider implements LLMProvider {
  readonly name = "dev";
  async complete(): Promise<ChatCompletionResult> {
    throw new AppError(
      503,
      "PROVIDER_NOT_CONFIGURED",
      "LLM provider is not configured. Set LLM_PROVIDER=openai (with OPENAI_API_KEY) or LLM_PROVIDER=compatible.",
    );
  }
}

export function getLLMProvider(): LLMProvider {
  const provider = getEnv().LLM_PROVIDER;
  switch (provider) {
    case "openai":
      return new OpenAIProvider();
    case "compatible":
      return new CompatibleLLMProvider();
    case "dev":
      return new DevLLMProvider();
  }
}
