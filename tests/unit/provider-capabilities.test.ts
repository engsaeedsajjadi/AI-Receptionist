import { describe, expect, it } from "vitest";
import {
  NO_STT_CAPABILITIES,
  NO_TTS_CAPABILITIES,
  NO_VOICE_CAPABILITIES,
} from "@/lib/providers/capabilities";
import { CompatibleSTTProvider, DevSTTProvider, OpenAISTTProvider } from "@/lib/providers/stt";
import { CompatibleTTSProvider, DevTTSProvider, OpenAITTSProvider } from "@/lib/providers/tts";
import { DevVoiceProvider, GenericVoiceProvider } from "@/lib/providers/voice";

/**
 * Capability contracts (§4/§12/§18): every provider explicitly declares
 * what it supports. These tests PIN the honest values — changing a `false`
 * to `true` here without a real implementation behind it is a lie the
 * review must catch.
 */
describe("voice capabilities", () => {
  it("generic gateway: turn-based playback + WS input + transfer, nothing else", () => {
    const caps = new GenericVoiceProvider({ baseURL: "https://gw.test", apiKey: "k" }).capabilities;
    expect(caps).toEqual({
      supportsTransfer: true,
      supportsStreamingInput: true,
      supportsSendAudio: false,
      supportsBidirectionalAudio: false,
      supportsDTMF: false,
      supportsRecording: false,
      playbackModes: ["audio-url", "gateway-tts"],
      streamingProtocol: "websocket",
    });
  });

  it("dev voice: nothing", () => {
    expect(new DevVoiceProvider().capabilities).toEqual(NO_VOICE_CAPABILITIES);
    expect(NO_VOICE_CAPABILITIES.playbackModes).toEqual([]);
  });
});

describe("STT capabilities", () => {
  it("openai: file-based, turn-only, Persian accepted", () => {
    const caps = new OpenAISTTProvider({ apiKey: "k" }).capabilities;
    expect(caps.supportsStreaming).toBe(false);
    expect(caps.supportsPartialTranscripts).toBe(false);
    expect(caps.supportsPersian).toBe(true);
    expect(caps.mode).toBe("file");
    expect(caps.maxAudioBytes).toBe(25 * 1024 * 1024);
  });

  it("compatible: file-based, turn-only", () => {
    const caps = new CompatibleSTTProvider({ baseURL: "https://stt.test/v1", apiKey: "k" }).capabilities;
    expect(caps.mode).toBe("file");
    expect(caps.supportsStreaming).toBe(false);
  });

  it("dev: nothing (and construction never needs credentials)", () => {
    expect(new DevSTTProvider().capabilities).toEqual(NO_STT_CAPABILITIES);
  });
});

describe("TTS capabilities", () => {
  it("openai: whole-utterance, turn-only, Persian accepted", () => {
    const caps = new OpenAITTSProvider({ apiKey: "k" }).capabilities;
    expect(caps.supportsStreaming).toBe(false);
    expect(caps.supportsPersian).toBe(true);
    expect(caps.mode).toBe("utterance");
    expect(caps.maxCharacters).toBe(4096);
    expect(caps.formats).toContain("mp3");
  });

  it("compatible: whole-utterance, turn-only", () => {
    const caps = new CompatibleTTSProvider({ baseURL: "https://tts.test/v1", apiKey: "k" }).capabilities;
    expect(caps.mode).toBe("utterance");
    expect(caps.supportsStreaming).toBe(false);
  });

  it("dev: nothing", () => {
    const caps = new DevTTSProvider().capabilities;
    expect(caps).toEqual(NO_TTS_CAPABILITIES);
    expect(caps.maxCharacters).toBe(0);
  });
});
