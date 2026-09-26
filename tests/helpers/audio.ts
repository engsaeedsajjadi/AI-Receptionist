/**
 * Deterministic synthetic audio fixtures (§38).
 *
 * No real recordings in the repo: every fixture is generated mathematically
 * at test time. Noise uses a seeded LCG so runs are reproducible.
 * All helpers produce PCM16 mono @ 16 kHz unless stated otherwise.
 */

/** Seeded PRNG (LCG): deterministic across runs. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Silence: all-zero PCM16. */
export function pcmSilence(durationMs: number, sampleRate = 16000): Buffer {
  return Buffer.alloc(Math.floor((durationMs * sampleRate) / 1000) * 2);
}

/** Pure sine tone (acts as "speech-like" voiced energy for VAD/codec tests). */
export function pcmSine(durationMs: number, freqHz = 220, amplitude = 12000, sampleRate = 16000): Buffer {
  const samples = Math.floor((durationMs * sampleRate) / 1000);
  const out = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate));
    out.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return out;
}

/** White noise at a fixed amplitude (deterministic via seed). */
export function pcmNoise(durationMs: number, amplitude = 4000, seed = 42, sampleRate = 16000): Buffer {
  const rand = seededRandom(seed);
  const samples = Math.floor((durationMs * sampleRate) / 1000);
  const out = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i++) {
    out.writeInt16LE(Math.round((rand() * 2 - 1) * amplitude), i * 2);
  }
  return out;
}

/** Speech-like burst: sine with amplitude envelope + onset/offset ramps. */
export function pcmUtterance(durationMs: number, seed = 7, sampleRate = 16000): Buffer {
  const rand = seededRandom(seed);
  const samples = Math.floor((durationMs * sampleRate) / 1000);
  const out = Buffer.allocUnsafe(samples * 2);
  const ramp = Math.floor(sampleRate * 0.02); // 20 ms ramps
  for (let i = 0; i < samples; i++) {
    const env = Math.min(1, i / ramp, (samples - i) / ramp);
    const harmonic =
      Math.sin((2 * Math.PI * 180 * i) / sampleRate) * 0.7 +
      Math.sin((2 * Math.PI * 360 * i) / sampleRate) * 0.2 +
      (rand() * 2 - 1) * 0.1;
    out.writeInt16LE(Math.round(9000 * env * harmonic), i * 2);
  }
  return out;
}

/** RMS energy of a PCM16 buffer (for VAD threshold tests). */
export function pcmRms(pcm16: Buffer): number {
  if (pcm16.length < 2) return 0;
  let sum = 0;
  const n = pcm16.length / 2;
  for (let i = 0; i < n; i++) {
    const s = pcm16.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}
