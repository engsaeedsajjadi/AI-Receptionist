import { describe, expect, it } from "vitest";
import { EnergyVAD, type VADConfig } from "@/lib/voice/audio";

const voiceFrame = Buffer.alloc(160, 0);
const silenceFrame = Buffer.alloc(160, 0xff);

function newVad(overrides: Partial<VADConfig> = {}): EnergyVAD {
  return new EnergyVAD({
    enabled: true,
    codec: "mulaw",
    sampleRate: 8_000,
    speechThreshold: 0.015,
    minSpeechMs: 180,
    silenceMs: 700,
    maxUtteranceMs: 12_000,
    ...overrides,
  });
}

describe("VAD safety boundaries", () => {
  it("does not accumulate isolated loud noise into a valid speech segment", () => {
    const vad = newVad();
    // 9 x 20 ms of isolated loud frames must not add up to 180 ms.
    for (let index = 0; index < 9; index++) {
      const loud = vad.process(voiceFrame);
      const quiet = vad.process(silenceFrame);
      expect(loud.speech).toBe(true);
      expect(loud.utteranceEnd).toBe(false);
      expect(quiet.utteranceEnd).toBe(false);
      expect(vad.isActive).toBe(false);
    }
    for (let index = 0; index < 8; index++) {
      expect(vad.process(voiceFrame).utteranceEnd).toBe(false);
      expect(vad.isActive).toBe(false);
    }
    vad.process(voiceFrame);
    expect(vad.isActive).toBe(true);
  });

  it("limits an active utterance by elapsed audio including short pauses", () => {
    const vad = newVad({ minSpeechMs: 20, silenceMs: 200, maxUtteranceMs: 200 });
    expect(vad.process(voiceFrame).utteranceEnd).toBe(false); // 20ms
    for (let index = 0; index < 5; index++) {
      expect(vad.process(silenceFrame).utteranceEnd).toBe(false); // 120ms elapsed
    }
    expect(vad.process(voiceFrame).utteranceEnd).toBe(false); // 140ms
    for (let index = 0; index < 2; index++) {
      expect(vad.process(silenceFrame).utteranceEnd).toBe(false); // 180ms
    }
    // Silence has lasted only 60ms since the last speech, but the
    // absolute 200ms safety cap expires now.
    expect(vad.process(silenceFrame).utteranceEnd).toBe(true);
    expect(vad.isActive).toBe(false);
    expect(vad.process(silenceFrame).utteranceEnd).toBe(false);
  });

  it("resets the silence countdown on resumed speech after activation", () => {
    const vad = newVad({ minSpeechMs: 20, silenceMs: 100 });
    vad.process(voiceFrame);
    for (let index = 0; index < 4; index++) {
      expect(vad.process(silenceFrame).utteranceEnd).toBe(false);
    }
    expect(vad.process(voiceFrame).utteranceEnd).toBe(false);
    for (let index = 0; index < 4; index++) {
      expect(vad.process(silenceFrame).utteranceEnd).toBe(false);
    }
    expect(vad.process(silenceFrame).utteranceEnd).toBe(true);
    expect(vad.isActive).toBe(false);
  });
});
