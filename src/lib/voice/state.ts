export type VoiceSessionState =
  | "IDLE"
  | "LISTENING"
  | "PROCESSING"
  | "SPEAKING"
  | "INTERRUPTED"
  | "TRANSFERRING"
  | "ENDING"
  | "ENDED"
  | "ERROR";

const transitions: Record<VoiceSessionState, readonly VoiceSessionState[]> = {
  IDLE: ["LISTENING", "ENDING", "ERROR"],
  LISTENING: ["PROCESSING", "TRANSFERRING", "ENDING", "ERROR"],
  PROCESSING: ["SPEAKING", "INTERRUPTED", "LISTENING", "TRANSFERRING", "ENDING", "ERROR"],
  SPEAKING: ["LISTENING", "INTERRUPTED", "TRANSFERRING", "ENDING", "ERROR"],
  INTERRUPTED: ["LISTENING", "PROCESSING", "ENDING", "ERROR"],
  TRANSFERRING: ["ENDING", "ERROR"],
  ENDING: ["ENDED", "ERROR"],
  ENDED: [],
  // A failed turn must not end a live phone call: the session returns to
  // LISTENING so the caller can speak again (the failure itself is reported to
  // the client, logged and metered). ENDING/ENDED remain available for hangup.
  ERROR: ["LISTENING", "ENDING", "ENDED"],
};

export class VoiceStateMachine {
  private current: VoiceSessionState = "IDLE";

  get state(): VoiceSessionState {
    return this.current;
  }

  canTransition(next: VoiceSessionState): boolean {
    return transitions[this.current].includes(next);
  }

  transition(next: VoiceSessionState): void {
    if (!this.canTransition(next)) {
      throw new Error(`Invalid voice state transition: ${this.current} -> ${next}`);
    }
    this.current = next;
  }
}
