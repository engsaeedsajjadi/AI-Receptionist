import { describe, expect, it } from "vitest";
import { requireAnyEnv } from "./live-config";

/**
 * Live text-to-speech acceptance: real Persian speech bytes come back from the
 * configured provider, above a minimum plausible size (an empty audio buffer
 * would silently produce silent phone calls).
 */
describe("Live: text-to-speech provider", () => {
  it("synthesizes audible Persian speech from the configured provider", async () => {
    requireAnyEnv(["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "COMPATIBLE_TTS_BASE_URL"], "text-to-speech provider");
    const { getTTSProvider } = await import("@/lib/providers/tts");
    const provider = getTTSProvider();
    const speech = await provider.synthesize("سلام، وقت بخیر. این یک آزمایش صدای منشی هوشمند است.", { format: "mp3" });
    const bytes = Buffer.from(speech.audio);
    expect(bytes.length).toBeGreaterThan(2_000);
    // MP3 frame sync (0xFFE…) or RIFF/WAVE header — proves real encoded audio.
    const sync = (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) || bytes.subarray(0, 4).toString("ascii") === "RIFF";
    expect(sync).toBe(true);
    console.log(`[live:tts] provider=${provider.name} bytes=${bytes.length}`);
  }, 120_000);
});
