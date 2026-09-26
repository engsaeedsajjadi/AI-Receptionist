import { AppError } from "@/lib/errors";

/**
 * Deterministic voice turn state machine (Phase 3 §16).
 *
 * Every media session moves through these states; arbitrary jumps are
 * rejected with 409 CONFLICT so an out-of-order event (late transcript,
 * double barge-in, transfer racing a hangup) can never corrupt a call:
 *
 *   IDLE -> LISTENING -> PROCESSING -> SPEAKING -> LISTENING ...
 *                                  SPEAKING -> INTERRUPTED -> LISTENING (barge-in)
 *                     PROCESSING -> INTERRUPTED (caller talks while the agent thinks)
 *   LISTENING|PROCESSING|SPEAKING -> TRANSFERRING -> TRANSFERRED | TRANSFER_FAILED
 *   TRANSFER_FAILED -> LISTENING (callback offer) | ENDING
 *   any -> ENDING -> ENDED
 *   any -> ERROR -> LISTENING (reprompt) | ENDING
 */

export type VoiceTurnState =
  | "IDLE"
  | "LISTENING"
  | "PROCESSING"
  | "SPEAKING"
  | "INTERRUPTED"
  | "TRANSFERRING"
  | "TRANSFERRED"
  | "TRANSFER_FAILED"
  | "ENDING"
  | "ENDED"
  | "ERROR";

const TRANSITIONS: Record<VoiceTurnState, readonly VoiceTurnState[]> = {
  IDLE: ["LISTENING", "ENDING", "ERROR"],
  LISTENING: ["PROCESSING", "TRANSFERRING", "ENDING", "ERROR"],
  // PROCESSING -> LISTENING: heard-nothing / duplicate (no audio to speak).
  // PROCESSING -> INTERRUPTED: caller talks while the agent thinks.
  PROCESSING: ["SPEAKING", "LISTENING", "INTERRUPTED", "TRANSFERRING", "ENDING", "ERROR"],
  SPEAKING: ["LISTENING", "INTERRUPTED", "TRANSFERRING", "ENDING", "ERROR"],
  INTERRUPTED: ["LISTENING", "PROCESSING", "ENDING", "ERROR"],
  TRANSFERRING: ["TRANSFERRED", "TRANSFER_FAILED", "ENDING", "ERROR"],
  TRANSFERRED: ["ENDING"],
  // Failed transfer returns to the agent so it can offer a callback.
  TRANSFER_FAILED: ["LISTENING", "ENDING", "ERROR"],
  ENDING: ["ENDED", "ERROR"],
  ENDED: [],
  ERROR: ["LISTENING", "ENDING"],
};

export function canTransition(from: VoiceTurnState, to: VoiceTurnState): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export type TurnTransition = { from: VoiceTurnState; to: VoiceTurnState };

export class TurnStateMachine {
  private current: VoiceTurnState;

  constructor(initial: VoiceTurnState = "IDLE") {
    this.current = initial;
  }

  get state(): VoiceTurnState {
    return this.current;
  }

  /**
   * Move to `to`. Self-transitions are no-ops; illegal jumps throw
   * 409 CONFLICT (fail closed — the caller decides how to recover).
   */
  transition(to: VoiceTurnState): TurnTransition {
    const from = this.current;
    if (!canTransition(from, to)) {
      throw new AppError(409, "CONFLICT", `Invalid voice state transition ${from} -> ${to}`);
    }
    this.current = to;
    return { from, to };
  }
}
