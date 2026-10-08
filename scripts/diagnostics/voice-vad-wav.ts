/**
 * Offline VAD endpoint diagnostics for a fixed PCM16 mono WAV recording.
 * No Gemini/OpenAI requests, database writes, or secrets are involved.
 *
 * Usage (from repository root):
 *   npx tsx scripts/diagnostics/voice-vad-wav.ts ./fixtures/caller-8k.wav
 *   npx tsx scripts/diagnostics/voice-vad-wav.ts ./fixtures/caller-8k.wav 700,1200,1800
 *
 * Keep real caller recordings out of Git; obtain recording consent and redact PII.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { EnergyVAD } from "../../src/lib/voice/audio";

type PcmWav = { pcm: Buffer; sampleRate: number };

function parsePcmWav(bytes: Buffer): PcmWav {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Expected RIFF/WAVE file");
  }
  let offset = 12;
  let sampleRate = 0;
  let validFormat = false;
  let pcm: Buffer | undefined;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length) throw new Error("Truncated WAV chunk");
    if (type === "fmt ") {
      if (size < 16) throw new Error("Invalid WAV fmt chunk");
      const codec = bytes.readUInt16LE(start);
      const channels = bytes.readUInt16LE(start + 2);
      sampleRate = bytes.readUInt32LE(start + 4);
      const bits = bytes.readUInt16LE(start + 14);
      validFormat = codec === 1 && channels === 1 && bits === 16;
    }
    if (type === "data") pcm = bytes.subarray(start, end);
    offset = end + (size % 2);
  }
  if (!validFormat || sampleRate < 8_000 || sampleRate > 48_000 || !pcm ||
    pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new Error("WAV must be mono PCM16 (8–48 kHz) with a nonempty data chunk");
  }
  return { pcm, sampleRate };
}

function endpoints(wav: PcmWav, silenceMs: number): number[] {
  const vad = new EnergyVAD({
    enabled: true,
    codec: "pcm_s16le",
    sampleRate: wav.sampleRate,
    speechThreshold: Number(process.env.VOICE_VAD_SPEECH_THRESHOLD ?? "0.015"),
    silenceMs,
    minSpeechMs: Number(process.env.VOICE_VAD_MIN_SPEECH_MS ?? "180"),
    maxUtteranceMs: Number(process.env.VOICE_VAD_MAX_UTTERANCE_MS ?? "12000"),
  });
  const frameBytes = Math.floor(wav.sampleRate * 0.02) * 2;
  const result: number[] = [];
  for (let i = 0; i < wav.pcm.length; i += frameBytes) {
    const frame = wav.pcm.subarray(i, Math.min(i + frameBytes, wav.pcm.length));
    if (vad.process(frame).utteranceEnd) {
      result.push(Math.round((Math.min(i + frame.length, wav.pcm.length) / (wav.sampleRate * 2)) * 1000));
    }
  }
  return result;
}

function main(): void {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: npx tsx scripts/diagnostics/voice-vad-wav.ts <file.wav> [700,1200,1800]");
  const silenceThresholds = (process.argv[3] ?? "700,1200,1800")
    .split(",").map((value) => Number(value.trim()));
  if (silenceThresholds.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Thresholds must be positive integers in milliseconds");
  }
  const audio = parsePcmWav(readFileSync(path));
  console.log(JSON.stringify({
    filename: basename(path),
    codec: "pcm_s16le",
    sampleRate: audio.sampleRate,
    durationMs: Math.round((audio.pcm.length / (audio.sampleRate * 2)) * 1000),
    thresholds: silenceThresholds.map((silenceMs) => ({
      silenceMs,
      endpointsMs: endpoints(audio, silenceMs),
    })),
    note: "VAD energy endpoint times only; does not measure STT recognition accuracy.",
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
