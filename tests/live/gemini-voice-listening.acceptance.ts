
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireLiveEnv } from "./live-config";
import {
  pcm16ToWav,
  pcmToTelephonyMulaw,
  mulawToPcm16,
  mulawFrames
} from "@/lib/voice/audio";

describe("Live: Gemini telephone listening sample", () => {
  it("exports original and telephony-quality WAV samples", async () => {
    requireLiveEnv(
      ["COMPATIBLE_LLM_API_KEY", "TTS_MODEL"],
      "Gemini telephone listening QA"
    );

    const { getTTSProvider } =
      await import("@/lib/providers/tts");

    const tts = getTTSProvider();

    expect(tts.name).toBe("gemini");

    const sentence =
      "\u0633\u0644\u0627\u0645\u060c \u0648\u0642\u062a \u0628\u062e\u06cc\u0631. \u0634\u0645\u0627 \u0628\u0627 \u0645\u0646\u0634\u06cc \u0647\u0648\u0634\u0645\u0646\u062f \u0635\u062d\u0628\u062a \u0645\u06cc\u200c\u06a9\u0646\u06cc\u062f.";

    const result = await tts.synthesize(
      sentence,
      { format: "pcm" }
    );

    const pcm = Buffer.from(result.audio);

    expect(result.mimeType.split(";")[0]).toBe("audio/l16");
    expect(pcm.length).toBeGreaterThan(2000);
    expect(pcm.length % 2).toBe(0);
    expect(pcm.subarray(0, 4).toString("ascii")).not.toBe("RIFF");

    const encoded = pcmToTelephonyMulaw(
      pcm,
      24000,
      8000
    );

    const frames = mulawFrames(encoded);
    const decoded = mulawToPcm16(encoded);

    expect(frames.length).toBeGreaterThan(10);
    expect(decoded.length).toBe(encoded.length * 2);

    const expectedDuration = pcm.length / 2 / 24000;
    const actualDuration = encoded.length / 8000;

    expect(
      Math.abs(expectedDuration - actualDuration)
    ).toBeLessThan(0.03);

    const outputDir = path.join(
      os.tmpdir(),
      "AI-Receptionist-Voice-QA"
    );

    fs.mkdirSync(outputDir, { recursive: true });

    const originalFile = path.join(
      outputDir,
      "gemini-original-24khz.wav"
    );

    const telephoneFile = path.join(
      outputDir,
      "gemini-telephone-8khz.wav"
    );

    fs.writeFileSync(
      originalFile,
      pcm16ToWav(pcm, 24000)
    );

    fs.writeFileSync(
      telephoneFile,
      pcm16ToWav(decoded, 8000)
    );

    console.log("ORIGINAL_WAV=" + originalFile);
    console.log("TELEPHONE_WAV=" + telephoneFile);
    console.log("DURATION_SECONDS=" + actualDuration.toFixed(2));
    console.log("TWILIO_FRAMES=" + frames.length);
    console.log("LISTENING_SAMPLES_CREATED=YES");
  }, 120000);
});
