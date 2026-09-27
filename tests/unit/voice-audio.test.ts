import { describe, expect, it } from "vitest";
import { EnergyVAD, decodeMulawByte, frameRms, mulawToPcm16, normalizeTelephonyAudio } from "@/lib/voice/audio";

function mulawSilence(length: number): Buffer {
  return Buffer.alloc(length, 0xff);
}

function mulawLoud(length: number): Buffer {
  return Buffer.alloc(length, 0x00);
}

describe("telephony audio/VAD", () => {
  it("decodes μ-law bytes without producing NaN", () => {
    expect(Number.isFinite(decodeMulawByte(0))).toBe(true);
    expect(Number.isFinite(decodeMulawByte(255))).toBe(true);
  });

  it("converts μ-law telephony audio to STT-safe WAV", () => {
    const result = normalizeTelephonyAudio(mulawSilence(160), "mulaw", 8000);
    expect(result.mimeType).toBe("audio/wav");
    expect(result.filename).toBe("call-audio.wav");
    expect(result.audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(mulawToPcm16(mulawSilence(2)).length).toBe(4);
  });

  it("detects energy in μ-law frames", () => {
    expect(frameRms(mulawLoud(160), "mulaw")).toBeGreaterThan(frameRms(mulawSilence(160), "mulaw"));
  });

  it("ends an utterance after configured silence", () => {
    const vad = new EnergyVAD({
      enabled: true,
      codec: "mulaw",
      sampleRate: 8000,
      speechThreshold: 0.01,
      silenceMs: 40,
      minSpeechMs: 20,
      maxUtteranceMs: 1000,
    });
    const speech = vad.process(mulawLoud(160));
    expect(speech.speech).toBe(true);
    expect(speech.utteranceEnd).toBe(false);
    const silence1 = vad.process(mulawSilence(160));
    expect(silence1.utteranceEnd).toBe(false);
    const silence2 = vad.process(mulawSilence(160));
    expect(silence2.utteranceEnd).toBe(true);
    expect(vad.isActive).toBe(false);
  });
});
