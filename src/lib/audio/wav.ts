import { AppError } from "@/lib/errors";

/**
 * Minimal WAV container support (RIFF/WAVE, fmt + data chunks).
 *
 * Used at the STT boundary: file-based transcription providers (Whisper API)
 * need a container, while telephony/VAD work on raw PCM16. Only the subset
 * the pipeline produces and consumes is supported — anything else is
 * rejected loudly, never silently misinterpreted.
 */

export type WavInfo = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Raw PCM payload (data chunk), header stripped. */
  pcm: Buffer;
};

function invalid(detail: string): AppError {
  return new AppError(400, "INVALID_PAYLOAD", `Invalid WAV file (${detail})`);
}

/** Parse a WAV buffer. Supports PCM 8/16-bit mono/stereo; rejects the rest. */
export function parseWav(input: Buffer): WavInfo {
  if (input.length < 44) throw invalid(`too short: ${input.length} bytes`);
  if (input.toString("ascii", 0, 4) !== "RIFF" || input.toString("ascii", 8, 12) !== "WAVE") {
    throw invalid("missing RIFF/WAVE header");
  }
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let pcm: Buffer | null = null;
  while (offset + 8 <= input.length) {
    const chunkId = input.toString("ascii", offset, offset + 4);
    const chunkSize = input.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > input.length) throw invalid("chunk overruns buffer");
    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw invalid("fmt chunk too small");
      audioFormat = input.readUInt16LE(chunkStart);
      channels = input.readUInt16LE(chunkStart + 2);
      sampleRate = input.readUInt32LE(chunkStart + 4);
      bitsPerSample = input.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      pcm = input.subarray(chunkStart, chunkEnd);
    }
    offset = chunkEnd + (chunkSize % 2); // chunks are word-aligned
  }
  if (audioFormat !== 1) throw invalid(`unsupported format tag ${audioFormat} (PCM only)`);
  if (channels !== 1 && channels !== 2) throw invalid(`unsupported channel count ${channels}`);
  if (bitsPerSample !== 8 && bitsPerSample !== 16) {
    throw invalid(`unsupported bit depth ${bitsPerSample}`);
  }
  if (!sampleRate || sampleRate > 192000) throw invalid(`implausible sample rate ${sampleRate}`);
  if (!pcm || pcm.length === 0) throw invalid("missing data chunk");
  return { sampleRate, channels, bitsPerSample, pcm: Buffer.from(pcm) };
}

/** Wrap raw PCM16 mono samples in a WAV header. */
export function buildWav(pcm16Mono: Buffer, sampleRate: number): Buffer {
  if (pcm16Mono.length % 2 !== 0) {
    throw new AppError(400, "INVALID_PAYLOAD", "PCM16 buffer length must be even");
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 192000) {
    throw new AppError(400, "INVALID_PAYLOAD", `Invalid sample rate ${sampleRate}`);
  }
  const header = Buffer.allocUnsafe(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm16Mono.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm16Mono.length, 40);
  return Buffer.concat([header, pcm16Mono]);
}

/** Convert parsed 8-bit PCM (unsigned) to PCM16 mono/stereo-interleaved. */
export function pcm8ToPcm16(pcm8: Buffer): Buffer {
  const out = Buffer.allocUnsafe(pcm8.length * 2);
  for (let i = 0; i < pcm8.length; i++) {
    out.writeInt16LE((pcm8[i] - 128) * 256, i * 2);
  }
  return out;
}

/** Downmix interleaved stereo PCM16 to mono (average). */
export function stereoToMonoPcm16(stereo: Buffer): Buffer {
  if (stereo.length % 4 !== 0) {
    throw new AppError(400, "INVALID_PAYLOAD", "Stereo PCM16 length must be a multiple of 4");
  }
  const out = Buffer.allocUnsafe(stereo.length / 2);
  for (let i = 0; i < stereo.length; i += 4) {
    const mixed = Math.round((stereo.readInt16LE(i) + stereo.readInt16LE(i + 2)) / 2);
    out.writeInt16LE(mixed, i / 2);
  }
  return out;
}
