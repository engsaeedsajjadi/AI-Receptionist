import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { TurnStateMachine, canTransition, type VoiceTurnState } from "@/lib/voice/turn-machine";

describe("turn state machine", () => {
  it("walks the happy path LISTENING -> PROCESSING -> SPEAKING -> LISTENING", () => {
    const m = new TurnStateMachine();
    expect(m.state).toBe("IDLE");
    m.transition("LISTENING");
    m.transition("PROCESSING");
    m.transition("SPEAKING");
    expect(m.transition("LISTENING")).toEqual({ from: "SPEAKING", to: "LISTENING" });
  });

  it("walks barge-in SPEAKING -> INTERRUPTED -> LISTENING", () => {
    const m = new TurnStateMachine("SPEAKING");
    m.transition("INTERRUPTED");
    m.transition("LISTENING");
    expect(m.state).toBe("LISTENING");
  });

  it("allows barge-in while PROCESSING (caller talks over the agent's thinking)", () => {
    const m = new TurnStateMachine("PROCESSING");
    m.transition("INTERRUPTED");
    m.transition("PROCESSING");
    expect(m.state).toBe("PROCESSING");
  });

  it("walks transfer success and failure", () => {
    const ok = new TurnStateMachine("LISTENING");
    ok.transition("TRANSFERRING");
    ok.transition("TRANSFERRED");
    ok.transition("ENDING");
    ok.transition("ENDED");

    const failed = new TurnStateMachine("SPEAKING");
    failed.transition("TRANSFERRING");
    failed.transition("TRANSFER_FAILED");
    failed.transition("LISTENING"); // back to the agent for a callback offer
    expect(failed.state).toBe("LISTENING");
  });

  it("returns to LISTENING when a turn hears nothing", () => {
    const m = new TurnStateMachine("PROCESSING");
    m.transition("LISTENING");
    expect(m.state).toBe("LISTENING");
  });

  it("recovers from ERROR to LISTENING or ENDING", () => {
    const a = new TurnStateMachine("PROCESSING");
    a.transition("ERROR");
    a.transition("LISTENING");
    const b = new TurnStateMachine("ERROR");
    b.transition("ENDING");
    expect(b.state).toBe("ENDING");
  });

  it("rejects illegal jumps with 409 (fail closed)", () => {
    const cases: Array<[VoiceTurnState, VoiceTurnState]> = [
      ["IDLE", "SPEAKING"], // must listen first
      ["LISTENING", "SPEAKING"], // must process first
      ["INTERRUPTED", "SPEAKING"], // must re-process before speaking again
      ["ENDED", "LISTENING"], // terminal
      ["TRANSFERRED", "LISTENING"], // call left the agent
      ["SPEAKING", "TRANSFERRED"], // must pass through TRANSFERRING
    ];
    for (const [from, to] of cases) {
      expect(canTransition(from, to)).toBe(false);
      const m = new TurnStateMachine(from);
      let err: unknown = null;
      try {
        m.transition(to);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("CONFLICT");
      expect(m.state).toBe(from); // failed transition changes nothing
    }
  });

  it("treats self-transitions as no-ops", () => {
    const m = new TurnStateMachine("LISTENING");
    expect(m.transition("LISTENING")).toEqual({ from: "LISTENING", to: "LISTENING" });
  });

  it("ENDED is terminal and every non-terminal state can reach ENDING", () => {
    expect(canTransition("ENDED", "ENDED")).toBe(true);
    const states: VoiceTurnState[] = [
      "IDLE", "LISTENING", "PROCESSING", "SPEAKING", "INTERRUPTED",
      "TRANSFERRING", "TRANSFERRED", "TRANSFER_FAILED", "ENDING", "ERROR",
    ];
    for (const s of states) {
      expect(canTransition(s, "ENDING")).toBe(true);
    }
  });
});
