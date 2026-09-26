import { buildSystemPrompt } from "@/lib/guardrails";

type BuildPromptInput = {
  businessName: string;
  businessContext: string;
  agentName?: string;
  greeting?: string;
  tone?: string;
  language?: string;
};

/**
 * Backwards-compatible prompt builder. New code should call
 * `buildSystemPrompt` from guardrails directly with separated layers.
 */
export function buildAgentPrompt({
  businessName,
  businessContext,
  agentName,
  greeting,
  tone,
  language = "fa",
}: BuildPromptInput) {
  return buildSystemPrompt({
    language,
    businessName,
    agentName,
    greeting,
    tone,
    businessContext,
  });
}
