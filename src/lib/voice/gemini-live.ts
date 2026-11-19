import { Behavior, GoogleGenAI, Modality, type FunctionDeclaration, type LiveConnectConfig } from "@google/genai";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { logInfo } from "@/lib/logger";
import { redisGet, redisIncr, redisSet } from "@/lib/redis";
import { buildAgentLiveInstructions, type AgentLiveInstructions } from "@/lib/services/agent";
import { executeToolCall } from "@/lib/tools/registry";

/**
 * Gemini Live (speech-to-speech) mode of the DEVELOPER telephone lab.
 *
 * The browser talks to Gemini Live directly with a short-lived, single-use
 * ephemeral token minted here, so the project API key never leaves the server.
 * The token locks the model and the session configuration (the tenant's own
 * guardrailed prompt and allow-listed tools). The model cannot touch the
 * database: every function call it makes comes back through
 * `executeLiveToolCall`, which checks the lab session belongs to this tenant,
 * user and agent, and runs the audited tool registry with server-side context.
 */
export const LIVE_SESSION_TTL_SECONDS = 35 * 60;
/** A lab conversation is short; a runaway model must not loop on side effects. */
export const LIVE_MAX_TOOL_CALLS = 40;
const TOKEN_LIFETIME_MS = 30 * 60 * 1000;
const NEW_SESSION_WINDOW_MS = 60 * 1000;
const MAX_TOOL_RESULT_CHARS = 8_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;

export type LiveScope = { businessId: string; userId: string; agentId: string };

export type LiveSessionGrant = {
  sessionId: string;
  model: string;
  /** Ephemeral token (`auth_tokens/...`): one session, expires in 30 minutes. */
  token: string;
  expiresAt: string;
  config: LiveConnectConfig;
  tools: string[];
};

type StoredSession = { tools: string[] };

function sessionKey(scope: LiveScope, sessionId: string): string {
  return `lab:live:${scope.businessId}:${scope.userId}:${scope.agentId}:${sessionId}`;
}

/** Gemini accepts JSON Schema directly; the draft marker is noise to it. */
function toFunctionDeclaration(tool: AgentLiveInstructions["tools"][number]): FunctionDeclaration {
  const { $schema: _ignored, ...schema } = tool.parameters as Record<string, unknown> & { $schema?: unknown };
  return {
    name: tool.name,
    description: tool.description,
    // Booking, lead and transfer results must exist before the model talks
    // about them, so the conversation waits for each tool result.
    behavior: Behavior.BLOCKING,
    parametersJsonSchema: schema,
  };
}

export function buildLiveConnectConfig(instructions: AgentLiveInstructions, voiceName: string): LiveConnectConfig {
  const config: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: instructions.systemPrompt }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  if (instructions.tools.length) {
    config.tools = [{ functionDeclarations: instructions.tools.map(toFunctionDeclaration) }];
  }
  if (voiceName) {
    config.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName } } };
  }
  return config;
}

type TokenMinter = (params: {
  apiKey: string;
  model: string;
  config: LiveConnectConfig;
  expireTime: string;
  newSessionExpireTime: string;
}) => Promise<string>;

const mintWithGoogle: TokenMinter = async ({ apiKey, model, config, expireTime, newSessionExpireTime }) => {
  // Ephemeral tokens exist only on v1beta.
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta" } });
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime,
      newSessionExpireTime,
      liveConnectConstraints: { model, config },
    },
  });
  if (!token.name) throw new AppError(502, "PROVIDER_ERROR", "Gemini did not return a Live session token");
  return token.name;
};

let minter: TokenMinter = mintWithGoogle;

/** Test seam: replace the network call that mints the ephemeral token. */
export function setLiveTokenMinterForTests(next: TokenMinter | null): void {
  minter = next ?? mintWithGoogle;
}

export function liveReadiness(apiKey = getEnv().COMPATIBLE_LLM_API_KEY): { ready: boolean; reasons: string[] } {
  return apiKey
    ? { ready: true, reasons: [] }
    : { ready: false, reasons: ["COMPATIBLE_LLM_API_KEY (Gemini API key) is required for Gemini Live"] };
}

export async function createLiveSession(scope: LiveScope, requestId: string): Promise<LiveSessionGrant> {
  const env = getEnv();
  if (!env.COMPATIBLE_LLM_API_KEY) {
    throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "COMPATIBLE_LLM_API_KEY (Gemini API key) is required for Gemini Live");
  }
  const instructions = await buildAgentLiveInstructions(scope.businessId, scope.agentId);
  const config = buildLiveConnectConfig(instructions, env.GEMINI_LIVE_VOICE);
  const now = Date.now();
  const expiresAt = new Date(now + TOKEN_LIFETIME_MS).toISOString();
  let token: string;
  try {
    token = await minter({
      apiKey: env.COMPATIBLE_LLM_API_KEY,
      model: env.GEMINI_LIVE_MODEL,
      config,
      expireTime: expiresAt,
      newSessionExpireTime: new Date(now + NEW_SESSION_WINDOW_MS).toISOString(),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, "PROVIDER_ERROR",
      `Gemini Live token could not be created: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`);
  }
  const sessionId = crypto.randomUUID();
  const tools = instructions.tools.map((t) => t.name);
  await redisSet(sessionKey(scope, sessionId), JSON.stringify({ tools } satisfies StoredSession), LIVE_SESSION_TTL_SECONDS);
  logInfo("Gemini Live lab session created", {
    requestId,
    businessId: scope.businessId,
    operation: "lab.live.session",
    status: "ok",
    model: env.GEMINI_LIVE_MODEL,
    tools: tools.length,
  });
  return { sessionId, model: env.GEMINI_LIVE_MODEL, token, expiresAt, config, tools };
}

export type LiveToolCallInput = { sessionId: unknown; name: unknown; args: unknown };

export type LiveToolResponse = { status: string; data?: unknown; error?: string };

function parseToolCall(input: LiveToolCallInput): { sessionId: string; name: string; args: Record<string, unknown> } {
  if (typeof input.sessionId !== "string" || !SESSION_ID.test(input.sessionId)) {
    throw new AppError(400, "INVALID_PAYLOAD", "sessionId must be a UUID");
  }
  if (typeof input.name !== "string" || !TOOL_NAME.test(input.name)) {
    throw new AppError(400, "INVALID_PAYLOAD", "name must be a tool name");
  }
  const args = input.args ?? {};
  if (typeof args !== "object" || Array.isArray(args) || args === null) {
    throw new AppError(400, "INVALID_PAYLOAD", "args must be an object");
  }
  if (JSON.stringify(args).length > 4_000) throw new AppError(413, "PAYLOAD_TOO_LARGE", "args are too large");
  return { sessionId: input.sessionId.toLowerCase(), name: input.name, args: args as Record<string, unknown> };
}

/** Bounded JSON for the model: a huge search result must not blow the context. */
function boundedResponse(result: LiveToolResponse): LiveToolResponse {
  const text = JSON.stringify(result);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return result;
  return { status: result.status, data: text.slice(0, MAX_TOOL_RESULT_CHARS), error: result.error };
}

export async function executeLiveToolCall(scope: LiveScope, input: LiveToolCallInput, requestId: string): Promise<LiveToolResponse> {
  const call = parseToolCall(input);
  const raw = await redisGet(sessionKey(scope, call.sessionId));
  if (!raw) throw new AppError(404, "NOT_FOUND", "Live lab session not found or expired");
  let stored: StoredSession;
  try {
    stored = JSON.parse(raw) as StoredSession;
  } catch {
    throw new AppError(404, "NOT_FOUND", "Live lab session not found or expired");
  }
  if (!Array.isArray(stored.tools) || !stored.tools.includes(call.name)) {
    return { status: "FAILED", error: "Tool is not allowed for this agent" };
  }
  const used = await redisIncr(`${sessionKey(scope, call.sessionId)}:tools`, LIVE_SESSION_TTL_SECONDS);
  if (used > LIVE_MAX_TOOL_CALLS) {
    return { status: "FAILED", error: "Tool call limit for this lab session reached" };
  }
  const result = await executeToolCall({
    businessId: scope.businessId,
    agentId: scope.agentId,
    tool: call.name,
    args: call.args,
    requestId,
    actor: scope.userId,
  });
  return boundedResponse(result.status === "SUCCESS"
    ? { status: result.status, data: result.data }
    : { status: result.status, error: result.error });
}
