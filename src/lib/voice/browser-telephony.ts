"use client";

/** Shared browser codec used by manual and hands-free telephony labs. */
const TARGET_RATE = 8_000;
const MAX_SECONDS = 20;

function mulawEncode(value: number): number {
  let sign = 0;
  let pcm = value;
  if (pcm < 0) { pcm = -pcm; sign = 0x80; }
  pcm = Math.min(pcm, 32635) + 132;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (pcm & mask) === 0; mask >>= 1) exponent--;
  return ~(sign | (exponent << 4) | ((pcm >> (exponent + 3)) & 15)) & 255;
}

export async function recordedToMulaw(blob: Blob) {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.round(decoded.duration * TARGET_RATE);
    if (frames < 5600 || frames > TARGET_RATE * MAX_SECONDS) {
      throw new Error("مدت ضبط باید بین ۰٫۷ تا ۲۰ ثانیه باشد.");
    }
    const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    const bytes = new Uint8Array(samples.length);
    let energy = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      energy += sample * sample;
      bytes[i] = mulawEncode(Math.round(sample < 0 ? sample * 32768 : sample * 32767));
    }
    const rms = Math.sqrt(energy / samples.length);
    if (rms < 0.001) throw new Error("صدا تقریباً ساکت است؛ چیزی به منشی ارسال نشد.");
    return { bytes, rms, durationSeconds: samples.length / TARGET_RATE };
  } finally {
    await ctx.close();
  }
}

export function fromBase64(base64: string): Blob {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes.buffer], { type: "audio/wav" });
}
