
import { describe, expect, it } from "vitest";
import { requireLiveEnv } from "./live-config";
import {
  pcmToTelephonyMulaw,
  mulawFrames,
  mulawToPcm16
} from "@/lib/voice/audio";

describe("Live: Gemini PCM telephony compatibility", () => {
  it("produces raw PCM suitable for Twilio encoding", async () => {
    requireLiveEnv(
      ["COMPATIBLE_LLM_API_KEY", "TTS_MODEL"],
      "Gemini TTS"
    );

    const { getTTSProvider } =
      await import("@/lib/providers/tts");

    const provider = getTTSProvider();

    expect(provider.name).toBe("gemini");

    const sentence =
      "\u0633\u0644\u0627\u0645. \u0628\u0647 \u0645\u0646\u0634\u06cc \u0647\u0648\u0634\u0645\u0646\u062f \u062e\u0648\u0634 \u0622\u0645\u062f\u06cc\u062f.";

    const speech = await provider.synthesize(
      sentence,
      { format: "pcm" }
    );

    const audio = Buffer.from(speech.audio);
    const mimeType = speech.mimeType.split(";")[0].trim().toLowerCase();

    const isWav =
      audio.length >= 12 &&
      audio.subarray(0, 4).toString("ascii") === "RIFF" &&
      audio.subarray(8, 12).toString("ascii") === "WAVE";

    console.log("TTS_REQUESTED_FORMAT=pcm");
    console.log("TTS_DECLARED_MIME=" + mimeType);
    console.log("TTS_AUDIO_BYTES=" + audio.length);
    console.log("TTS_CONTAINS_WAV_HEADER=" + isWav);

    if (isWav && audio.length >= 44) {
      console.log("WAV_CHANNELS=" + audio.readUInt16LE(22));
      console.log("WAV_SAMPLE_RATE=" + audio.readUInt32LE(24));
      console.log("WAV_BITS_PER_SAMPLE=" + audio.readUInt16LE(34));
    }

    expect(audio.length).toBeGreaterThan(2000);
    expect(mimeType).toBe("audio/l16");

    expect(
      isWav,
      "Gemini returned a WAV container while declaring raw PCM"
    ).toBe(false);

    expect(audio.length % 2).toBe(0);

    const mulaw = pcmToTelephonyMulaw(
      audio,
      24000,
      8000
    );

    const frames = mulawFrames(mulaw);

    expect(mulaw.length).toBeGreaterThan(500);
    expect(frames.length).toBeGreaterThan(3);
    expect(frames.every(
      (frame, index) =>
        frame.length > 0 &&
        frame.length <= 160 &&
        (index === frames.length - 1 || frame.length === 160)
    )).toBe(true);

    const decoded = mulawToPcm16(mulaw);

    let sumSquares = 0;
    const samples = decoded.length / 2;

    for (let i = 0; i < samples; i++) {
      const sample = decoded.readInt16LE(i * 2);
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(
      sumSquares / Math.max(samples, 1)
    );

    console.log("TWILIO_CODEC=G711_MULAW");
    console.log("TWILIO_SAMPLE_RATE=8000");
    console.log("TWILIO_AUDIO_BYTES=" + mulaw.length);
    console.log("TWILIO_FRAME_COUNT=" + frames.length);
    console.log("TWILIO_DECODED_RMS=" + rms.toFixed(2));

    expect(rms).toBeGreaterThan(10);

    console.log("GEMINI_TO_TWILIO_PCM=PASS");
  }, 120000);
});
