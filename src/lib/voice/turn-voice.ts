import { AppError } from "@/lib/errors";
import { assertVoiceAllowed } from "@/lib/voice/voice-safety";

/**
 * The agent voice ID belongs to its configured cloud TTS voice catalog.
 * For the explicit local-Piper path, the provider instance has already
 * selected an allowlisted publisher model independently (via parsePiperVoice).
 * Its synthesize() ignores options.voice, so checking the unused cloud ID
 * can incorrectly produce VOICE_CONSENT_REQUIRED (403) after a valid LLM turn.
 *
 * Never weaken the consent gate for actual cloud / cloned-voice synthesis.
 */
export async function resolveTurnTtsVoice(input: {
  businessId: string;
  providerName: string;
  requestedVoice?: string;
  agentVoiceId?: string | null;
}): Promise<string | undefined> {
  if (input.providerName === "piper") {
    if (input.requestedVoice) {
      throw new AppError(400, "INVALID_PAYLOAD", "Piper voice must be selected from the approved publisher catalog");
    }
    return undefined;
  }
  // Explicit overrides are subject to the same consent check as the agent
  // configuration; neither path can bypass the voice-cloning guard.
  const voice = input.requestedVoice ?? input.agentVoiceId ?? undefined;
  if (voice) {
    await assertVoiceAllowed({ businessId: input.businessId, voiceId: voice });
  }
  return voice;
}
