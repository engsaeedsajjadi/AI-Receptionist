import { describe, expect, it } from "vitest";
import { voiceLatencyStages } from "@/components/dashboard/voice-latency-breakdown";

describe("voice latency UI metrics", () => {
  it("identifies TTS as the slowest step in real lab-shaped timing", () => {
    const output = voiceLatencyStages({ total: 13340, stt: 3942, agent: 1451, tts: 7724, store: 10 });
    expect(output.total).toBe(13340);
    expect(output.longest?.key).toBe("tts");
    expect(output.stages).toHaveLength(4);
  });

  it("accepts historic responses with only total, without inventing timings", () => {
    const output = voiceLatencyStages({ total: 50 });
    expect(output.stages).toEqual([]);
    expect(output.longest).toBeNull();
  });
});
