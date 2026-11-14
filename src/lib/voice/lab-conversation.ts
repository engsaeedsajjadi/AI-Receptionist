import { AppError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/providers/llm";
import { redisDel, redisGet, redisSet } from "@/lib/redis";

/**
 * Short-lived memory for the DEVELOPER telephone lab only.
 *
 * A real call keeps its transcript on the call row; the lab deliberately
 * creates no call, so without this every lab utterance was a brand-new
 * conversation and a multi-turn exchange (ask for a slot, give a name, confirm)
 * could not be exercised. The memory is server-side, tenant/user/agent scoped,
 * bounded and expires on its own — the browser only holds an opaque session id.
 */
export const LAB_MEMORY_TTL_SECONDS = 15 * 60;
export const LAB_MEMORY_MAX_MESSAGES = 16;
const MAX_MESSAGE_CHARS = 1_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LabConversationScope = { businessId: string; userId: string; agentId: string; sessionId: string };

/** Absent → no memory. Present → must be a UUID (it becomes part of a storage key). */
export function parseLabSessionId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !SESSION_ID.test(value)) {
    throw new AppError(400, "INVALID_PAYLOAD", "conversationId must be a UUID");
  }
  return value.toLowerCase();
}

function key(scope: LabConversationScope): string {
  return `lab:conversation:${scope.businessId}:${scope.userId}:${scope.agentId}:${scope.sessionId}`;
}

export async function loadLabHistory(scope: LabConversationScope): Promise<ChatMessage[]> {
  const raw = await redisGet(key(scope));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m): m is { role: "user" | "assistant"; content: string } =>
        typeof m === "object" && m !== null &&
        ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "assistant") &&
        typeof (m as { content?: unknown }).content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }))
      .slice(-LAB_MEMORY_MAX_MESSAGES);
  } catch {
    return [];
  }
}

/** Append one completed exchange and refresh the expiry. Returns the stored turn count. */
export async function appendLabTurn(scope: LabConversationScope, user: string, assistant: string): Promise<number> {
  const history = await loadLabHistory(scope);
  history.push(
    { role: "user", content: user.trim().slice(0, MAX_MESSAGE_CHARS) },
    { role: "assistant", content: assistant.trim().slice(0, MAX_MESSAGE_CHARS) },
  );
  const bounded = history.slice(-LAB_MEMORY_MAX_MESSAGES);
  await redisSet(key(scope), JSON.stringify(bounded), LAB_MEMORY_TTL_SECONDS);
  return bounded.length / 2;
}

export async function clearLabHistory(scope: LabConversationScope): Promise<void> {
  await redisDel(key(scope));
}
