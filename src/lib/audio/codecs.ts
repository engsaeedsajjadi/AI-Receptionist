/**
 * ITU-T G.711 codec utilities (mu-law / A-law <-> linear PCM16).
 *
 * Telephony gateways typically stream 8 kHz mono audio companded as mu-law
 * (North America / Japan / most VoIP gateways) or A-law (E1 / Europe). The
 * rest of the app works on linear PCM16, so every conversion lives HERE —
 * no ad-hoc companding anywhere else (§8: dedicated codec layer).
 *
 * Design notes:
 * - Decode is the textbook G.711 formula; encode is nearest-decode search
 *   over a lazily built lookup table (uniform for both laws, consistent by
 *   construction, fast for bulk frames after the one-time build).
 * - mu-law has two zero codes: 0xFF (canonical, emitted by encoders) and
 *   0x7F (alias). Both decode to 0; encode(0) is canonically 0xFF.
 * - A-law has no true zero: 0xD5 decodes to +8 (smallest positive step).
 *   Round-trip error is bounded by the segment quantisation step.
 * - Out-of-range samples clip to the extreme codes (mu-law +/-32124,
 *   A-law +/-32256).
 */

const MULAW_BIAS = 0x84;
const MULAW_ZERO_CANONICAL = 0xff;
const ALAW_TOGGLE = 0x55;
const ALAW_ZERO_CODE = 0xd5;

export function mulawDecodeByte(code: number): number {
  const u = ~code & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  return sign ? -sample : sample;
}

export function alawDecodeByte(code: number): number {
  const a = (code ^ ALAW_TOGGLE) & 0xff;
  const sign = a & 0x80;
  const exponent = (a >> 4) & 0x07;
  const data = a & 0x0f;
  let sample = (data << 4) + 8;
  if (exponent !== 0) sample += 0x100;
  if (exponent > 1) sample <<= exponent - 1;
  return sign ? sample : -sample;
}

type DecodeFn = (code: number) => number;

/**
 * Lazily built sample->code tables. Index = sample + 32768, value = code
 * whose decode is nearest (ties prefer the code with bit 7 set, which
 * canonicalises mu-law +0 to 0xFF). Built once per law on first encode.
 */
const encodeTables = new Map<string, Uint8Array>();

function encodeTable(law: string, decode: DecodeFn): Uint8Array {
  const cached = encodeTables.get(law);
  if (cached) return cached;
  const decoded = new Int32Array(256);
  for (let c = 0; c < 256; c++) decoded[c] = decode(c);
  const table = new Uint8Array(65536);
  for (let s = -32768; s <= 32767; s++) {
    let best = 0;
    let bestDist = Infinity;
    for (let c = 0; c < 256; c++) {
      const dist = Math.abs(decoded[c] - s);
      if (dist < bestDist || (dist === bestDist && (c & 0x80) !== 0 && (best & 0x80) === 0)) {
        bestDist = dist;
        best = c;
      }
    }
    table[s + 32768] = best;
  }
  encodeTables.set(law, table);
  return table;
}

function clampSample(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  if (sample > 32767) return 32767;
  if (sample < -32768) return -32768;
  return Math.round(sample);
}

export function mulawEncodeSample(sample: number): number {
  return encodeTable("mulaw", mulawDecodeByte)[clampSample(sample) + 32768];
}

export function alawEncodeSample(sample: number): number {
  return encodeTable("alaw", alawDecodeByte)[clampSample(sample) + 32768];
}

function decodeBuffer(input: Buffer, decode: DecodeFn): Buffer {
  const out = Buffer.allocUnsafe(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    out.writeInt16LE(decode(input[i]), i * 2);
  }
  return out;
}

function encodeBuffer(pcm16: Buffer, table: Uint8Array): Buffer {
  if (pcm16.length % 2 !== 0) {
    throw new RangeError(`PCM16 buffer length must be even, got ${pcm16.length}`);
  }
  const out = Buffer.allocUnsafe(pcm16.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = table[pcm16.readInt16LE(i * 2) + 32768];
  }
  return out;
}

/** mu-law bytes -> PCM16 mono (little-endian). */
export function mulawToPcm16(input: Buffer): Buffer {
  return decodeBuffer(input, mulawDecodeByte);
}

/** PCM16 mono (little-endian) -> mu-law bytes. */
export function pcm16ToMulaw(pcm16: Buffer): Buffer {
  return encodeBuffer(pcm16, encodeTable("mulaw", mulawDecodeByte));
}

/** A-law bytes -> PCM16 mono (little-endian). */
export function alawToPcm16(input: Buffer): Buffer {
  return decodeBuffer(input, alawDecodeByte);
}

/** PCM16 mono (little-endian) -> A-law bytes. */
export function pcm16ToAlaw(pcm16: Buffer): Buffer {
  return encodeBuffer(pcm16, encodeTable("alaw", alawDecodeByte));
}

export const G711 = {
  MULAW_ZERO_CANONICAL,
  ALAW_ZERO_CODE,
  /** Largest magnitudes representable (clipping points). */
  MULAW_MAX_MAGNITUDE: 32124,
  ALAW_MAX_MAGNITUDE: 32256,
} as const;
