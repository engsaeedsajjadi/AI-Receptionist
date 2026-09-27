import { describe, expect, it } from "vitest";
import { VoiceStateMachine } from "@/lib/voice/state";

describe("voice session state machine", () => {
  it("allows the normal listen/process/speak/listen cycle", () => {
    const machine = new VoiceStateMachine();
    machine.transition("LISTENING");
    machine.transition("PROCESSING");
    machine.transition("SPEAKING");
    machine.transition("LISTENING");
    expect(machine.state).toBe("LISTENING");
  });

  it("rejects invalid terminal transitions", () => {
    const machine = new VoiceStateMachine();
    machine.transition("LISTENING");
    expect(() => machine.transition("ENDED")).toThrow(/Invalid voice state transition/);
  });

  it("supports barge-in recovery", () => {
    const machine = new VoiceStateMachine();
    machine.transition("LISTENING");
    machine.transition("PROCESSING");
    machine.transition("SPEAKING");
    machine.transition("INTERRUPTED");
    machine.transition("LISTENING");
    expect(machine.state).toBe("LISTENING");
  });
});
