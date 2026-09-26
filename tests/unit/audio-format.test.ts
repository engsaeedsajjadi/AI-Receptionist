import { describe, expect, it } from "vitest";
import {
  PIPELINE_FORMAT,
  encodeTelephonyAudio,
  normalizeTelephonyAudio,
  pcm16DurationMs,
  resamplePcm16Mono,
  telephonyToWav,
} from "@/lib/audio/format";
import { buildWav, parseWav, pcm8ToPcm16, stereoToMonoPcm16 } from "@/lib/audio/wav";
import { pcm16ToAlaw, pcm16ToMulaw } from "@/lib/audio/codecs";
import { AppError } from "@/lib/errors";
import { pcmNoise, pcmRms, pcmSilence, pcmSine, pcmUtterance } from "../helpers/audio";

describe("WAV container", () => {
  it("build -> parse round-trips PCM16 mono", () => {
    const pcm = pcmUtterance(300);
    const wav = buildWav(pcm, 16000);
    expect(wav.length).toBe(pcm.length + 44);
    const parsed = parseWav(wav);
    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.channels).toBe(1);
    expect(parsed.bitsPerSample).toBe(16);
    expect(Buffer.from(parsed.pcm)).toEqual(pcm);
  });

  it("rejects non-WAV, truncated and unsupported files", () => {
    expect(() => parseWav(Buffer.from("not audio at all......................"))).toThrow(AppError);
    expect(() => parseWav(Buffer.alloc(10))).toThrow(AppError);
    const wav = buildWav(pcmSilence(50), 8000);
    wav.writeUInt16LE(3, 20); // float tag, not PCM
    expect(() => parseWav(wav)).toThrow(AppError);
  });

  it("converts 8-bit PCM and downmixes stereo", () => {
    const pcm16 = pcm8ToPcm16(Buffer.from([0, 128, 255]));
    expect([pcm16.readInt16LE(0), pcm16.readInt16LE(2), pcm16.readInt16LE(4)]).toEqual([
      -32768, 0, 32512,
    ]);
    const stereo = Buffer.alloc(8);
    stereo.writeInt16LE(1000, 0);
    stereo.writeInt16LE(3000, 2);
    stereo.writeInt16LE(-1000, 4);
    stereo.writeInt16LE(-3000, 6);
    const mono = stereoToMonoPcm16(stereo);
    expect(mono.length).toBe(4);
    expect(mono.readInt16LE(0)).toBe(2000);
    expect(mono.readInt16LE(2)).toBe(-2000);
    expect(() => stereoToMonoPcm16(Buffer.alloc(6))).toThrow(AppError);
  });
});

describe("resampler", () => {
  it("is a no-op for identical rates (copy, not alias)", () => {
    const pcm = pcmSine(100);
    const out = resamplePcm16Mono(pcm, 16000, 16000);
    expect(out).toEqual(pcm);
    expect(out).not.toBe(pcm);
  });

  it("upsamples 8k -> 16k preserving duration and energy", () => {
    const src = pcmSine(250, 220, 10000, 8000);
    const out = resamplePcm16Mono(src, 8000, 16000);
    expect(out.length).toBe(src.length * 2);
    expect(Math.abs(pcmRms(out) - pcmRms(src)) / pcmRms(src)).toBeLessThan(0.05);
  });

  it("downsamples 16k -> 8k preserving duration", () => {
    const src = pcmUtterance(400);
    const out = resamplePcm16Mono(src, 16000, 8000);
    expect(out.length).toBe(Math.round(src.length / 2));
    expect(pcmRms(out)).toBeGreaterThan(0);
  });

  it("preserves constant (DC) signals exactly", () => {
    const src = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) src.writeInt16LE(5000, i * 2);
    const out = resamplePcm16Mono(src, 8000, 16000);
    for (let i = 0; i < out.length; i += 2) {
      expect(out.readInt16LE(i)).toBe(5000);
    }
  });

  it("rejects odd lengths and invalid rates", () => {
    expect(() => resamplePcm16Mono(Buffer.alloc(3), 8000, 16000)).toThrow(AppError);
    expect(() => resamplePcm16Mono(Buffer.alloc(4), 0, 16000)).toThrow(AppError);
  });
});

describe("telephony ingress/egress", () => {
  it("normalises 8k mu-law (the common telephony format) to pipeline PCM16", () => {
    // Simulate the wire: 16k utterance -> 8k -> mu-law bytes on the wire.
    const source = pcmUtterance(500);
    const at8k = resamplePcm16Mono(source, 16000, 8000);
    const wire = pcm16ToMulaw(at8k);
    const canonical = normalizeTelephonyAudio(wire, { encoding: "mulaw", sampleRate: 8000, channels: 1 });
    expect(canonical.length).toBe(source.length);
    // Speech energy survives the round trip (companding + resampling loss < 15%).
    expect(Math.abs(pcmRms(canonical) - pcmRms(source)) / pcmRms(source)).toBeLessThan(0.15);
  });

  it("produces STT-ready WAV bytes from telephony audio", () => {
    const wire = pcm16ToAlaw(resamplePcm16Mono(pcmSine(200), 16000, 8000));
    const wav = telephonyToWav(wire, { encoding: "alaw", sampleRate: 8000, channels: 1 });
    const parsed = parseWav(wav);
    expect(parsed.sampleRate).toBe(PIPELINE_FORMAT.sampleRate);
    expect(parsed.channels).toBe(1);
  });

  it("encodes pipeline audio back to telephony formats", () => {
    const pcm = pcmNoise(120, 6000);
    const mulaw = encodeTelephonyAudio(pcm, { encoding: "mulaw", sampleRate: 8000, channels: 1 });
    expect(mulaw.length).toBe(pcm.length / 4); // 16k->8k (x1/2) times 16-bit->8-bit (x1/2)
    const back = normalizeTelephonyAudio(mulaw, { encoding: "mulaw", sampleRate: 8000, channels: 1 });
    expect(back.length).toBe(pcm.length);
  });

  it("rejects stereo and unsupported rates loudly", () => {
    expect(() =>
      normalizeTelephonyAudio(Buffer.alloc(160), { encoding: "mulaw", sampleRate: 8000, channels: 2 as 1 }),
    ).toThrow(AppError);
    expect(() =>
      normalizeTelephonyAudio(Buffer.alloc(160), { encoding: "mulaw", sampleRate: 44100, channels: 1 }),
    ).toThrow(AppError);
  });

  it("computes PCM16 durations", () => {
    expect(pcm16DurationMs(pcmSilence(1000))).toBe(1000);
  });
});
