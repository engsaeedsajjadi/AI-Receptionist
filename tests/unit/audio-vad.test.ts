import { describe, expect, it } from "vitest";
import { EnergyVad, defaultVadConfig, type VadConfig } from "@/lib/audio/vad";
import { AppError } from "@/lib/errors";
import { pcmNoise, pcmSilence, pcmSine, pcmUtterance } from "../helpers/audio";

const CONFIG: VadConfig = {
  silenceMs: 200,
  minSpeechMs: 100,
  maxUtteranceMs: 2000,
  silenceRms: 400,
  sampleRate: 16000,
};

function pushAll(vad: EnergyVad, chunks: Buffer[]): string[] {
  const events: string[] = [];
  for (const c of chunks) events.push(...vad.push(c));
  return events;
}

describe("energy VAD", () => {
  it("reads defaults from VOICE_VAD_* env", () => {
    const cfg = defaultVadConfig({
      VOICE_VAD_SILENCE_MS: 900,
      VOICE_VAD_MIN_SPEECH_MS: 250,
      VOICE_VAD_MAX_UTTERANCE_MS: 30000,
      VOICE_VAD_SILENCE_RMS: 400,
    });
    expect(cfg).toMatchObject({ silenceMs: 900, minSpeechMs: 250, maxUtteranceMs: 30000, silenceRms: 400 });
  });

  it("stays silent on silence", () => {
    const vad = new EnergyVad(CONFIG);
    expect(pushAll(vad, [pcmSilence(1000)])).toEqual([]);
    expect(vad.currentState).toBe("silence");
  });

  it("emits speech-start then speech-end around an utterance", () => {
    const vad = new EnergyVad(CONFIG);
    const events = pushAll(vad, [pcmUtterance(400), pcmSilence(400)]);
    expect(events).toEqual(["speech-start", "speech-end"]);
    expect(vad.currentState).toBe("silence");
  });

  it("ignores sub-threshold bursts as noise (no events, no state leak)", () => {
    const vad = new EnergyVad(CONFIG);
    // 60 ms blip < minSpeechMs 100 ms.
    expect(pushAll(vad, [pcmSine(60, 220, 12000), pcmSilence(500)])).toEqual([]);
    expect(vad.currentState).toBe("silence");
    // A real utterance right after still works (counters were clean).
    expect(pushAll(vad, [pcmUtterance(300), pcmSilence(400)])).toEqual(["speech-start", "speech-end"]);
  });

  it("tolerates low background noise below the RMS threshold", () => {
    const vad = new EnergyVad(CONFIG);
    expect(pushAll(vad, [pcmNoise(800, 150, 99)])).toEqual([]);
  });

  it("force-ends runaway speech at max-utterance (no infinite waiting)", () => {
    const vad = new EnergyVad(CONFIG);
    // 2500 ms of continuous voice: start, force-end at 2000 ms, new utterance begins.
    const events = pushAll(vad, [pcmSine(2500, 180, 10000)]);
    expect(events).toEqual(["speech-start", "max-utterance", "speech-start"]);
    expect(vad.currentState).toBe("speech");
    // Trailing silence still closes the follow-up utterance.
    expect(pushAll(vad, [pcmSilence(400)])).toEqual(["speech-end"]);
  });

  it("handles frame fragments across pushes (carry-over)", () => {
    const vad = new EnergyVad(CONFIG);
    const blob = Buffer.concat([pcmUtterance(300), pcmSilence(400)]);
    // Push in odd 1000-byte slices (not frame-aligned).
    const events: string[] = [];
    for (let i = 0; i < blob.length; i += 1000) {
      events.push(...vad.push(blob.subarray(i, i + 1000)));
    }
    expect(events).toEqual(["speech-start", "speech-end"]);
  });

  it("reset clears partial state", () => {
    const vad = new EnergyVad(CONFIG);
    vad.push(pcmSine(80, 220, 12000)); // partial min-speech accumulation
    vad.reset();
    expect(vad.currentState).toBe("silence");
    expect(pushAll(vad, [pcmSilence(300)])).toEqual([]);
  });

  it("rejects non-PCM16 input and invalid config", () => {
    const vad = new EnergyVad(CONFIG);
    expect(() => vad.push(Buffer.alloc(3))).toThrow(AppError);
    expect(() => new EnergyVad({ ...CONFIG, silenceMs: 0 })).toThrow(AppError);
  });
});
