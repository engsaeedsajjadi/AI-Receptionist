import type { TtsAudioFormat } from "@/lib/providers/tts";

/**
 * Explicit provider capability declarations (Phase 3 §4 / §12 / §18).
 *
 * Every voice/STT/TTS provider MUST declare what it can and cannot do, so
 * the application layers (media server, turn pipeline, health reporting)
 * detect features instead of assuming them — and so an honest `false`
 * can never be mistaken for an unimplemented code path.
 *
 * Honesty rules:
 * - `supportsStreaming: false` means turn-based ONLY. Do not label the
 *   pipeline "real-time streaming" while these are false.
 * - `supportsPersian: true` means the provider accepts Persian input and
 *   returns usable output; voice quality/nativeness is model-dependent and
 *   must be verified on staging with real ears, never assumed here.
 */

export type VoicePlaybackMode = "audio-url" | "gateway-tts";

export type VoiceCapabilities = {
  /** PSTN/SIP transfer via transferCall(). */
  supportsTransfer: boolean;
  /** Gateway can stream caller audio to our media WebSocket (startStream). */
  supportsStreamingInput: boolean;
  /** Sample/chunk-level outbound audio streaming (vs whole-file playback). */
  supportsSendAudio: boolean;
  /** Full-duplex sample streaming (true barge-in at the media layer). */
  supportsBidirectionalAudio: boolean;
  /** DTMF digit events from the caller. */
  supportsDTMF: boolean;
  /** Provider-side call recording with retrievable artifacts. */
  supportsRecording: boolean;
  /** How agent replies reach the caller. Empty = no playback path. */
  playbackModes: VoicePlaybackMode[];
  /** Media transport the provider speaks, if any. */
  streamingProtocol: "websocket" | "none";
};

export type STTCapabilities = {
  /** Incremental audio in / partial transcripts out (WebSocket-style). */
  supportsStreaming: boolean;
  /** Emits partial (non-final) transcripts. False => every result is final. */
  supportsPartialTranscripts: boolean;
  /** Accepts Persian speech input. */
  supportsPersian: boolean;
  /** Honest processing mode label. */
  mode: "file" | "streaming";
  /** Max single-request audio payload, null when unknown/none. */
  maxAudioBytes: number | null;
};

export type TTSCapabilities = {
  /** Incremental text in / audio chunks out. */
  supportsStreaming: boolean;
  /** Accepts Persian text input. */
  supportsPersian: boolean;
  /** Honest processing mode label. */
  mode: "utterance" | "streaming";
  formats: TtsAudioFormat[];
  /** Max input characters per request (0 = cannot synthesise). */
  maxCharacters: number;
};

/** Shared "nothing available" declarations for dev/test providers. */
export const NO_VOICE_CAPABILITIES: VoiceCapabilities = {
  supportsTransfer: false,
  supportsStreamingInput: false,
  supportsSendAudio: false,
  supportsBidirectionalAudio: false,
  supportsDTMF: false,
  supportsRecording: false,
  playbackModes: [],
  streamingProtocol: "none",
};

export const NO_STT_CAPABILITIES: STTCapabilities = {
  supportsStreaming: false,
  supportsPartialTranscripts: false,
  supportsPersian: false,
  mode: "file",
  maxAudioBytes: null,
};

export const NO_TTS_CAPABILITIES: TTSCapabilities = {
  supportsStreaming: false,
  supportsPersian: false,
  mode: "utterance",
  formats: [],
  maxCharacters: 0,
};
