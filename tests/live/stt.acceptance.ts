import { describe, expect, it } from "vitest";
import { requireAnyEnv } from "./live-config";

/**
 * Live speech-to-text acceptance. A synthetic WAV tone is transcribed through
 * the real provider adapter; the provider must reach the API and return a
 * well-formed result instead of throwing or returning undefined.
 */
describe("Live: speech-to-text provider", () => {
  it("transcribes real audio bytes through the configured STT API", async () => {
    requireAnyEnv(["OPENAI_API_KEY", "DEEPGRAM_API_KEY", "COMPATIBLE_STT_BASE_URL"], "speech-to-text provider");
    const { getSTTProvider } = await import("@/lib/providers/stt");
    const provider = getSTTProvider();
    // 0.4s of 440Hz 16-bit PCM WAV, generated locally (no fixture download).
    const sampleRate = 8000, samples = Math.floor(sampleRate * 0.4);
    const data = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), i * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
    header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(data.length, 40);
    const result = await provider.transcribe(Buffer.concat([header, data]), { language: "fa" });
    expect(typeof result.text).toBe("string");
    console.log(`[live:stt] provider=${provider.name} transcriptChars=${result.text.length}`);
  }, 120_000);
});
