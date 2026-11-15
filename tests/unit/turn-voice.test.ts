import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTurnTtsVoice } from "@/lib/voice/turn-voice";
import { assertVoiceAllowed } from "@/lib/voice/voice-safety";

vi.mock("@/lib/voice/voice-safety", () => ({
  assertVoiceAllowed: vi.fn(),
}));

const guard = vi.mocked(assertVoiceAllowed);
const businessId = "00000000-0000-4000-8000-000000000001";

describe("voice selection at TTS boundary", () => {
  afterEach(() => vi.resetAllMocks());

  it("does not gate an unused agent cloud voice when synthesizing with approved local Piper", async () => {
    const voice = await resolveTurnTtsVoice({
      businessId, providerName: "piper", agentVoiceId: "custom-cloud-voice",
    });
    expect(voice).toBeUndefined();
    expect(guard).not.toHaveBeenCalled();
  });

  it("rejects a direct voice override for local Piper (publisher voice is selected at construction)", async () => {
    await expect(resolveTurnTtsVoice({
      businessId, providerName: "piper", requestedVoice: "cloned-voice-id",
    })).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    expect(guard).not.toHaveBeenCalled();
  });

  it("enforces clone consent for cloud TTS before synthesis", async () => {
    guard.mockRejectedValueOnce(new Error("VOICE_CONSENT_REQUIRED"));
    await expect(resolveTurnTtsVoice({
      businessId, providerName: "gemini", agentVoiceId: "unapproved-voice",
    })).rejects.toThrow("VOICE_CONSENT_REQUIRED");
    expect(guard).toHaveBeenCalledWith({ businessId, voiceId: "unapproved-voice" });
  });

  it("also gates explicit cloud voice overrides instead of bypassing consent", async () => {
    expect(await resolveTurnTtsVoice({
      businessId, providerName: "gemini", requestedVoice: "selected-voice", agentVoiceId: "agent-voice",
    })).toBe("selected-voice");
    expect(guard).toHaveBeenCalledWith({ businessId, voiceId: "selected-voice" });
  });

  it("does not touch the clone guard if no voice is configured", async () => {
    expect(await resolveTurnTtsVoice({
      businessId, providerName: "gemini",
    })).toBeUndefined();
    expect(guard).not.toHaveBeenCalled();
  });
});
