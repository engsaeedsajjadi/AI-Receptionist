import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromBase64, recordedToMulaw, recordedToSttWav } from "@/lib/voice/browser-telephony";
import { decodeMulawByte, mulawToPcm16, pcm16ToWav } from "@/lib/voice/audio";
import { validateLocalHighQualitySttWav } from "@/lib/voice/local-telephony";

/**
 * Browser-side codec of the telephone lab. Web Audio is not available in Node,
 * so the decode/resample step is replaced by a fake that hands back a known
 * signal; what is verified is this module's own work: duration limits, silence
 * rejection, G.711 μ-law encoding, the WAV header and context cleanup.
 */
type Signal = (index: number, sampleRate: number) => number;

let decodedSeconds = 1;
let signal: Signal = (i, rate) => 0.5 * Math.sin((2 * Math.PI * 300 * i) / rate);
let closed = 0;
let renderedAt: number[] = [];

class FakeAudioContext {
  async decodeAudioData() {
    return { duration: decodedSeconds };
  }
  async close() {
    closed += 1;
  }
}

class FakeOfflineAudioContext {
  readonly destination = {};
  constructor(private readonly channels: number, private readonly frames: number, private readonly rate: number) {
    renderedAt.push(rate);
  }
  createBufferSource() {
    return { buffer: null as unknown, connect() {}, start() {} };
  }
  async startRendering() {
    const data = new Float32Array(this.frames);
    for (let i = 0; i < data.length; i++) data[i] = signal(i, this.rate);
    return { getChannelData: () => data };
  }
}

const recording = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });

beforeEach(() => {
  decodedSeconds = 1;
  signal = (i, rate) => 0.5 * Math.sin((2 * Math.PI * 300 * i) / rate);
  closed = 0;
  renderedAt = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recordedToMulaw", () => {
  it("resamples to 8 kHz and encodes G.711 μ-law that the server decoder reads back", async () => {
    const result = await recordedToMulaw(recording());

    expect(renderedAt).toEqual([8_000]);
    expect(result.bytes).toHaveLength(8_000);
    expect(result.durationSeconds).toBe(1);
    // RMS of a 0.5-amplitude sine is 0.5 / sqrt(2).
    expect(result.rms).toBeCloseTo(0.3536, 3);

    // Round trip through the server-side decoder: μ-law is lossy but must stay
    // within the companding error of the original sample.
    for (const index of [1, 7, 100, 4_001, 7_999]) {
      const expected = Math.round(signal(index, 8_000) * 32_767);
      const decoded = decodeMulawByte(result.bytes[index]);
      expect(Math.abs(decoded - expected)).toBeLessThanOrEqual(Math.max(40, Math.abs(expected) * 0.04));
    }
    expect(closed).toBe(1);
  });

  it("encodes digital silence and full-scale peaks to the standard μ-law codes", async () => {
    signal = (i) => (i % 3 === 0 ? 0 : i % 3 === 1 ? 2 : -2); // 0, clipped +1, clipped -1
    const { bytes } = await recordedToMulaw(recording());
    expect(bytes[0]).toBe(0xff); // zero
    expect(bytes[1]).toBe(0x80); // positive full scale (input clipped to +1)
    expect(bytes[2]).toBe(0x00); // negative full scale (input clipped to -1)
  });

  it("rejects recordings shorter than 0.7 s or longer than 20 s and still closes the context", async () => {
    decodedSeconds = 0.69;
    await expect(recordedToMulaw(recording())).rejects.toThrow("۰٫۷ تا ۲۰");
    decodedSeconds = 20.01;
    await expect(recordedToMulaw(recording())).rejects.toThrow("۰٫۷ تا ۲۰");
    expect(closed).toBe(2);

    decodedSeconds = 0.7;
    await expect(recordedToMulaw(recording())).resolves.toMatchObject({ durationSeconds: 0.7 });
    decodedSeconds = 20;
    await expect(recordedToMulaw(recording())).resolves.toMatchObject({ durationSeconds: 20 });
  });

  it("refuses near-silent audio so nothing is sent to the assistant", async () => {
    signal = () => 0.0005;
    await expect(recordedToMulaw(recording())).rejects.toThrow("ساکت");
    expect(closed).toBe(1);
  });
});

describe("recordedToSttWav", () => {
  it("produces a 16-kHz mono PCM16 WAV that passes the server-side lab validation", async () => {
    const blob = await recordedToSttWav(recording());
    expect(blob.type).toBe("audio/wav");
    expect(renderedAt).toEqual([16_000]);

    const wav = Buffer.from(await blob.arrayBuffer());
    expect(wav.length).toBe(44 + 16_000 * 2);
    // The exact validator the lab route applies to this upload.
    expect(validateLocalHighQualitySttWav(wav, 1)).toBe(wav);

    expect(wav.readInt16LE(44)).toBe(0);
    expect(wav.readInt16LE(44 + 2 * 10)).toBe(Math.round(signal(10, 16_000) * 32_767));
    expect(closed).toBe(1);
  });

  it("clips out-of-range samples instead of wrapping around", async () => {
    signal = (i) => (i % 2 === 0 ? 3 : -3);
    const wav = Buffer.from(await (await recordedToSttWav(recording())).arrayBuffer());
    expect(wav.readInt16LE(44)).toBe(32_767);
    expect(wav.readInt16LE(46)).toBe(-32_768);
  });

  it("applies the same 0.7–20 s duration limits", async () => {
    decodedSeconds = 0.5;
    await expect(recordedToSttWav(recording())).rejects.toThrow("۰٫۷ تا ۲۰");
    decodedSeconds = 21;
    await expect(recordedToSttWav(recording())).rejects.toThrow("۰٫۷ تا ۲۰");
    expect(closed).toBe(2);
  });
});

describe("fromBase64", () => {
  it("turns the server's base64 playback into a WAV blob byte-for-byte", async () => {
    const wav = pcm16ToWav(mulawToPcm16(Buffer.from([0xff, 0x80, 0x00, 0x55])), 8_000);
    const blob = fromBase64(wav.toString("base64"));
    expect(blob.type).toBe("audio/wav");
    expect(Buffer.from(await blob.arrayBuffer()).equals(wav)).toBe(true);
  });
});
