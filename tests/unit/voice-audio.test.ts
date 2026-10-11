import { describe, expect, it } from "vitest";
import { EnergyVAD, decodeMulawByte, encodeMulawSample, frameRms, mulawToPcm16, normalizeTelephonyAudio } from "@/lib/voice/audio";

function mulawSilence(length: number): Buffer {
  return Buffer.alloc(length, 0xff);
}

function mulawLoud(length: number): Buffer {
  return Buffer.alloc(length, 0x00);
}

describe("telephony audio/VAD", () => {
  it("decodes μ-law bytes without producing NaN", () => {
    expect(Number.isFinite(decodeMulawByte(0))).toBe(true);
    expect(Number.isFinite(decodeMulawByte(255))).toBe(true);
  });

  it("converts μ-law telephony audio to STT-safe WAV", () => {
    const result = normalizeTelephonyAudio(mulawSilence(160), "mulaw", 8000);
    expect(result.mimeType).toBe("audio/wav");
    expect(result.filename).toBe("call-audio.wav");
    expect(result.audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(mulawToPcm16(mulawSilence(2)).length).toBe(4);
  });

  it("detects energy in μ-law frames", () => {
    expect(frameRms(mulawLoud(160), "mulaw")).toBeGreaterThan(frameRms(mulawSilence(160), "mulaw"));
  });

  it("ends an utterance after configured silence", () => {
    const vad = new EnergyVAD({
      enabled: true,
      codec: "mulaw",
      sampleRate: 8000,
      speechThreshold: 0.01,
      silenceMs: 40,
      minSpeechMs: 20,
      maxUtteranceMs: 1000,
    });
    const speech = vad.process(mulawLoud(160));
    expect(speech.speech).toBe(true);
    expect(speech.utteranceEnd).toBe(false);
    const silence1 = vad.process(mulawSilence(160));
    expect(silence1.utteranceEnd).toBe(false);
    const silence2 = vad.process(mulawSilence(160));
    expect(silence2.utteranceEnd).toBe(true);
    expect(vad.isActive).toBe(false);
  });
});

describe("adaptive VAD noise regressions", () => {
  function createNoiseGenerator() {
    let seed = 123456789;
    let sampleIndex = 0;

    return (withVoice = false): Buffer => {
      const frame = Buffer.alloc(160);

      for (let i = 0; i < frame.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;

        const random = seed / 4294967296 * 2 - 1;

        // Steady background noise, approximately -34 dBFS RMS.
        const noise = random * 0.02 * 32768 * Math.sqrt(3);

        // Deterministic voiced signal over the same background.
        const voice = withVoice
          ? Math.sin(2 * Math.PI * 220 * sampleIndex / 8000)
              * 0.08 * 32768
          : 0;

        sampleIndex++;

        const mixed = Math.max(
          -32768,
          Math.min(32767, Math.round(noise + voice))
        );

        frame[i] = encodeMulawSample(mixed);
      }

      return frame;
    };
  }

  function makeVad() {
    return new EnergyVAD({
      enabled: true,
      codec: "mulaw",
      sampleRate: 8000,
      speechThreshold: 0.015,
      silenceMs: 1800,
      minSpeechMs: 180,
      maxUtteranceMs: 12000,
    });
  }

  it("does not treat continuous telephone tones as caller speech", () => {
    const tones = [
      { name: "425Hz", frequencies: [425], amplitude: 1200 },
      { name: "440Hz", frequencies: [440], amplitude: 1200 },
      { name: "350+440Hz", frequencies: [350, 440], amplitude: 900 },
    ];

    for (const tone of tones) {
      const vad = new EnergyVAD({
        enabled: true,
        codec: "mulaw",
        sampleRate: 8000,
        speechThreshold: 0.015,
        silenceMs: 1800,
        minSpeechMs: 180,
        maxUtteranceMs: 12000,
      });

      let speechFrames = 0;
      let becameActive = false;
      let utteranceEnds = 0;

      // Four seconds of continuous telephone tone.
      for (let frameIndex = 0; frameIndex < 200; frameIndex++) {
        const frame = Buffer.alloc(160);

        for (let i = 0; i < 160; i++) {
          const sampleIndex = frameIndex * 160 + i;

          const sample = tone.frequencies.reduce(
            (sum, frequency) =>
              sum +
              tone.amplitude *
                Math.sin(2 * Math.PI * frequency * sampleIndex / 8000),
            0,
          );

          frame[i] = encodeMulawSample(
            Math.max(
              -32768,
              Math.min(32767, Math.round(sample)),
            ),
          );
        }

        const result = vad.process(frame);

        if (result.speech) speechFrames++;
        if (vad.isActive) becameActive = true;
        if (result.utteranceEnd) utteranceEnds++;
      }

      // Follow with 2200ms of silence.
      for (let i = 0; i < 110; i++) {
        if (vad.process(mulawSilence(160)).utteranceEnd) {
          utteranceEnds++;
        }
      }

      expect(speechFrames, tone.name).toBe(0);
      expect(becameActive, tone.name).toBe(false);
      expect(utteranceEnds, tone.name).toBe(0);
      expect(vad.isActive, tone.name).toBe(false);
    }
  });

  it("detects quiet speech immediately after session start", () => {
    const vad = new EnergyVAD({
      enabled: true,
      codec: "mulaw",
      sampleRate: 8000,
      speechThreshold: 0.015,
      silenceMs: 1800,
      minSpeechMs: 180,
      maxUtteranceMs: 12000,
    });

    let detectedFrames = 0;
    let becameActive = false;
    let utteranceEnds = 0;

    // Quiet voiced signal starts on the very first audio frame.
    // Amplitude 1200 produces RMS approximately 0.026.
    for (let frameIndex = 0; frameIndex < 25; frameIndex++) {
      const frame = Buffer.alloc(160);

      for (let i = 0; i < 160; i++) {
        const sampleIndex = frameIndex * 160 + i;
        const sample = Math.round(
          1200 * Math.sin(2 * Math.PI * 220 * sampleIndex / 8000)
        );

        frame[i] = encodeMulawSample(sample);
      }

      const result = vad.process(frame);

      if (result.speech) detectedFrames++;
      if (vad.isActive) becameActive = true;
    }

    // Final silence must close exactly one utterance.
    for (let i = 0; i < 100; i++) {
      if (vad.process(mulawSilence(160)).utteranceEnd) {
        utteranceEnds++;
      }
    }

    expect(detectedFrames).toBeGreaterThanOrEqual(9);
    expect(becameActive).toBe(true);
    expect(utteranceEnds).toBe(1);
  });

  it("does not create a false turn when background noise changes abruptly", () => {
    const vad = makeVad();

    // Each noise level lasts two seconds at 20ms per frame.
    const levels = [0.005, 0.010, 0.020, 0.006, 0.005];

    let seed = 123456789;
    let speechFrames = 0;
    let activeFrames = 0;
    let utteranceEnds = 0;

    for (let frameIndex = 0; frameIndex < 500; frameIndex++) {
      const levelIndex = Math.min(
        levels.length - 1,
        Math.floor(frameIndex / 100),
      );

      const rms = levels[levelIndex];
      const frame = Buffer.alloc(160);

      for (let i = 0; i < frame.length; i++) {
        seed = (
          Math.imul(seed, 1664525) + 1013904223
        ) >>> 0;

        const random = seed / 4294967296 * 2 - 1;
        const sample = random * rms * 32768 * Math.sqrt(3);

        frame[i] = encodeMulawSample(
          Math.round(
            Math.max(-32768, Math.min(32767, sample)),
          ),
        );
      }

      const result = vad.process(frame);

      if (result.speech) speechFrames++;
      if (vad.isActive) activeFrames++;
      if (result.utteranceEnd) utteranceEnds++;
    }

    // Additional silence reveals any falsely started conversation.
    for (let i = 0; i < 110; i++) {
      if (vad.process(mulawSilence(160)).utteranceEnd) {
        utteranceEnds++;
      }
    }

    expect(utteranceEnds).toBe(0);
    expect(activeFrames).toBe(0);
    expect(vad.isActive).toBe(false);
  });

  it("ignores continuous background noise without creating a turn", () => {
    const vad = makeVad();
    const noiseFrame = createNoiseGenerator();

    let utteranceEnds = 0;

    // 13 seconds: longer than maxUtteranceMs.
    for (let i = 0; i < 650; i++) {
      if (vad.process(noiseFrame()).utteranceEnd) {
        utteranceEnds++;
      }
    }

    expect(utteranceEnds).toBe(0);
    expect(vad.isActive).toBe(false);
  });

  it("preserves a 1700ms pause and ends after 1800ms of ambient noise", () => {
    const vad = makeVad();
    const nextFrame = createNoiseGenerator();
    const events: string[] = [];

    function feed(count: number, voice: boolean, phase: string) {
      for (let i = 0; i < count; i++) {
        const result = vad.process(nextFrame(voice));

        if (result.utteranceEnd) {
          events.push(phase);
        }
      }
    }

    // Establish background-noise conditions.
    feed(75, false, "AMBIENT_CALIBRATION");

    // First 500ms of speech.
    feed(25, true, "FIRST_SPEECH");

    // 1700ms pause with continuing background noise.
    feed(85, false, "MID_SENTENCE_PAUSE");

    expect(events).toEqual([]);

    // Speech resumes for 400ms.
    feed(20, true, "RESUMED_SPEECH");

    // 1780ms of background noise must not end the sentence.
    feed(89, false, "FINAL_BEFORE_1800");

    expect(events).toEqual([]);

    // The next 20ms completes the 1800ms endpoint.
    feed(1, false, "FINAL_AT_1800");

    expect(events).toEqual(["FINAL_AT_1800"]);
  });
});
