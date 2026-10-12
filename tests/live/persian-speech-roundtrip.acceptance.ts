
import { describe, expect, it } from "vitest";
import { requireLiveEnv } from "./live-config";

describe("Live: Persian speech round trip", () => {
  it("synthesizes Persian and recognizes its spoken words", async () => {
    requireLiveEnv(
      ["COMPATIBLE_LLM_API_KEY", "STT_MODEL", "TTS_MODEL"],
      "Gemini Persian speech"
    );

    const { getTTSProvider } =
      await import("@/lib/providers/tts");

    const { getSTTProvider } =
      await import("@/lib/providers/stt");

    const tts = getTTSProvider();
    const stt = getSTTProvider();

    expect(tts.name).toBe("gemini");
    expect(stt.name).toBe("gemini");

    const original =
      "\u0633\u0644\u0627\u0645\u060c \u0648\u0642\u062a \u0628\u062e\u06cc\u0631. \u0645\u0646 \u0645\u0646\u0634\u06cc \u0647\u0648\u0634\u0645\u0646\u062f \u0647\u0633\u062a\u0645 \u0648 \u0645\u06cc\u200c\u062a\u0648\u0627\u0646\u0645 \u0628\u0631\u0627\u06cc \u0631\u0632\u0631\u0648 \u0648\u0642\u062a \u0628\u0647 \u0634\u0645\u0627 \u06a9\u0645\u06a9 \u06a9\u0646\u0645.";

    const speech = await tts.synthesize(
      original,
      { format: "mp3" }
    );

    const audio = Buffer.from(speech.audio);

    expect(audio.length).toBeGreaterThan(2000);

    const result = await stt.transcribe(
      audio,
      { language: "fa" }
    );

    const transcript = (result.text ?? "").trim();

    console.log("ORIGINAL_TEXT=" + original);
    console.log("STT_TRANSCRIPT=" + transcript);
    console.log("AUDIO_BYTES=" + audio.length);

    function normalize(text: string): string {
      return text
        .replace(/[\u064a\u0649]/g, "\u06cc")
        .replace(/\u0643/g, "\u06a9")
        .replace(/\u200c/g, "")
        .replace(/[^\u0600-\u06ff]+/g, " ")
        .trim();
    }

    const recognized = normalize(transcript);

    const keywords = [
      "\u0633\u0644\u0627\u0645",
      "\u0645\u0646\u0634\u06cc",
      "\u0647\u0648\u0634\u0645\u0646\u062f",
      "\u0631\u0632\u0631\u0648",
      "\u0648\u0642\u062a"
    ];

    const hits = keywords.filter(
      word => recognized.includes(normalize(word))
    );

    console.log("MATCHED_KEYWORDS=" + hits.join(","));
    console.log("KEYWORD_MATCH_COUNT=" + hits.length);

    expect(recognized.length).toBeGreaterThan(15);
    expect(recognized).toMatch(/[\u0600-\u06ff]/);
    expect(hits.length).toBeGreaterThanOrEqual(3);
  }, 120000);
});
