import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { agents } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { encodeMulawSample } from "@/lib/voice/audio";
import type { VoiceTurnInput, VoiceTurnResult } from "@/lib/voice/turn";
import { createAgent, createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * Developer-only local telephone lab
 * (`/api/v1/agents/:id/telephony-local-test`).
 *
 * The route can spend real provider quota and writes transcripts, so its
 * safety contract is what matters: it must not exist outside development, must
 * refuse any database that is not the disposable local test database, and must
 * validate every lab option before a voice turn starts. Provider work is
 * replaced by deterministic seams — no Piper, Whisper, Gemini or network.
 */
const seams = vi.hoisted(() => ({
  turn: null as ((input: VoiceTurnInput) => Promise<VoiceTurnResult>) | null,
  piper: [] as Array<{ voice?: string; style?: string }>,
}));

vi.mock("@/lib/voice/turn", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/voice/turn")>();
  return {
    ...actual,
    runVoiceTurn: (input: VoiceTurnInput) => (seams.turn ? seams.turn(input) : actual.runVoiceTurn(input)),
  };
});

vi.mock("@/lib/providers/piper-tts", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/providers/piper-tts")>();
  class FakePiper {
    readonly name = "piper";
    constructor(options: { voice?: string; style?: string } = {}) {
      seams.piper.push({ voice: options.voice, style: options.style });
    }
    async synthesize(text: string) {
      // 0.5 s of 24-kHz PCM16 mono.
      return {
        audio: Buffer.alloc(24_000), mimeType: "audio/pcm", provider: "piper", model: "fake-piper",
        voice: "fa_IR-amir-medium", usage: { characters: text.length },
      };
    }
  }
  return { ...actual, PiperTTSProvider: FakePiper };
});

const LAB_DB = "postgresql://ai_test:test-only-ci@127.0.0.1:5432/ai_receptionist_test";

/** Environment in which the lab is allowed to run. */
function enableLab(overrides: Record<string, string> = {}) {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DATABASE_URL", LAB_DB);
  vi.stubEnv("TEST_DATABASE_URL", LAB_DB);
  vi.stubEnv("LLM_PROVIDER", "openai");
  vi.stubEnv("STT_PROVIDER", "openai");
  vi.stubEnv("TTS_PROVIDER", "openai");
  vi.stubEnv("OPENAI_API_KEY", "test-key-not-used");
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

async function identity() {
  const business = await createBusiness();
  const { user } = await createUser(business.id, "ADMIN");
  const { accessToken } = await issueAuthTokens({ userId: user.id, businessId: business.id, role: "ADMIN" });
  return { business, user, token: accessToken };
}

async function call(method: "GET" | "POST", agentId: string, token?: string, form?: FormData) {
  const route = await import("@/app/api/v1/agents/[id]/telephony-local-test/route");
  const req = new NextRequest(`http://localhost/api/v1/agents/${agentId}/telephony-local-test`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: method === "POST" ? (form ?? new FormData()) : undefined,
  });
  return route[method](req, { params: Promise.resolve({ id: agentId }) });
}

/** One second of an audible 8-kHz G.711 μ-law tone. */
function mulawSpeech(seconds = 1): Uint8Array {
  const out = new Uint8Array(8_000 * seconds);
  for (let i = 0; i < out.length; i++) {
    out[i] = encodeMulawSample(Math.round(8_000 * Math.sin((2 * Math.PI * 300 * i) / 8_000)));
  }
  return out;
}

function labForm(fields: Record<string, string> = {}, audio: Uint8Array = mulawSpeech(), type = "audio/basic") {
  const form = new FormData();
  form.set("audio", new File([audio as BlobPart], "turn.ulaw", { type }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

/** Matching 16-kHz mono PCM16 WAV for the optional Faster-Whisper A/B path. */
function sttWav(seconds = 1): Uint8Array {
  const data = 16_000 * 2 * seconds;
  const wav = Buffer.alloc(44 + data);
  wav.write("RIFF", 0, "ascii"); wav.writeUInt32LE(36 + data, 4); wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii"); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii"); wav.writeUInt32LE(data, 40);
  return new Uint8Array(wav);
}

function turnResult(agentId: string, overrides: Partial<VoiceTurnResult> = {}): VoiceTurnResult {
  return {
    duplicate: false, heard: true, transcript: "سلام", sttLanguage: "fa", sttDurationSeconds: 1,
    reply: "سلام، بفرمایید.", spokenText: "سلام، بفرمایید.",
    audio: Buffer.alloc(24_000), audioMimeType: "audio/pcm", audioUrl: null, audioStored: false,
    agentId, toolCalls: [],
    usage: { sttMinutes: 1 / 60, ttsCharacters: 15, llmInputTokens: 8, llmOutputTokens: 4 },
    latencyMs: { total: 10, stt: 3, agent: 4, tts: 3 },
    ...overrides,
  };
}

describe.skipIf(!hasTestDatabase())("local telephone lab route", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
    seams.turn = null;
    seams.piper.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("isolation guard", () => {
    itDb("does not exist outside development, even for an authenticated admin", async () => {
      const a = await identity();
      const agent = await createAgent(a.business.id);
      let turns = 0;
      seams.turn = async () => { turns += 1; return turnResult(agent.id); };

      for (const mode of ["test", "production"]) {
        vi.stubEnv("NODE_ENV", mode);
        vi.stubEnv("DATABASE_URL", LAB_DB);
        expect((await call("GET", agent.id, a.token)).status).toBe(404);
        expect((await call("POST", agent.id, a.token, labForm())).status).toBe(404);
      }
      expect(turns).toBe(0);
    });

    itDb("refuses any database that is not the disposable local test database", async () => {
      const a = await identity();
      const agent = await createAgent(a.business.id);
      let turns = 0;
      seams.turn = async () => { turns += 1; return turnResult(agent.id); };

      enableLab({ DATABASE_URL: "postgresql://app:secret@db.internal.example:5432/ai_receptionist_test" });
      expect((await call("POST", agent.id, a.token, labForm())).status).toBe(403);

      enableLab({ DATABASE_URL: "postgresql://app:secret@127.0.0.1:5432/app_db" });
      expect((await call("POST", agent.id, a.token, labForm())).status).toBe(403);

      enableLab({ TEST_DATABASE_URL: "postgresql://ai_test:test-only-ci@127.0.0.1:5432/another_db" });
      expect((await call("GET", agent.id, a.token)).status).toBe(403);

      enableLab({ DATABASE_URL: "not a url" });
      expect((await call("GET", agent.id, a.token)).status).toBe(503);

      expect(turns).toBe(0);
    });
  });

  describe("readiness (GET)", () => {
    itDb("requires authentication and an active agent of the caller's tenant", async () => {
      enableLab();
      const a = await identity();
      const b = await identity();
      const agent = await createAgent(a.business.id);
      const foreign = await createAgent(b.business.id);

      expect((await call("GET", agent.id)).status).toBe(401);
      expect((await call("GET", foreign.id, a.token)).status).toBe(404);
      await db.update(agents).set({ isActive: false }).where(eq(agents.id, agent.id));
      expect((await call("GET", agent.id, a.token)).status).toBe(404);
    });

    itDb("reports provider wiring without returning any secret", async () => {
      const a = await identity();
      const agent = await createAgent(a.business.id);

      enableLab();
      const ready = await call("GET", agent.id, a.token);
      expect(ready.status).toBe(200);
      const readyText = await ready.text();
      expect(JSON.parse(readyText)).toMatchObject({
        ready: true, reasons: [], providers: { llm: "openai", stt: "openai", tts: "openai" },
      });
      expect(readyText).not.toContain("test-key-not-used");

      enableLab({ LLM_PROVIDER: "dev", STT_PROVIDER: "dev", TTS_PROVIDER: "dev" });
      const notReady = await (await call("GET", agent.id, a.token)).json();
      expect(notReady.ready).toBe(false);
      expect(notReady.reasons).toHaveLength(3);
    });
  });

  describe("voice turn (POST)", () => {
    itDb("validates the upload and every lab option before starting a turn", async () => {
      enableLab();
      const a = await identity();
      const agent = await createAgent(a.business.id);
      let turns = 0;
      seams.turn = async () => { turns += 1; return turnResult(agent.id); };
      const post = (form: FormData) => call("POST", agent.id, a.token, form);

      expect((await post(new FormData())).status).toBe(415);
      expect((await post(labForm({}, mulawSpeech(), "audio/wav"))).status).toBe(415);
      expect((await post(labForm({}, new Uint8Array(8_000 * 20 + 1).fill(0x55)))).status).toBe(413);
      expect((await post(labForm({ ttsEngine: "elevenlabs" }))).status).toBe(400);
      expect((await post(labForm({ sttEngine: "google" }))).status).toBe(400);
      expect((await post(labForm({ responseStyle: "verbose" }))).status).toBe(400);
      expect((await post(labForm({ ttsEngine: "piper", piperVoice: "../../etc/passwd" }))).status).toBe(400);
      expect((await post(labForm({ ttsEngine: "piper", piperStyle: "shouting" }))).status).toBe(400);
      // Too short (< 0.7 s) and silent audio never reach speech recognition.
      expect((await post(labForm({}, mulawSpeech().slice(0, 4_000)))).status).toBe(400);
      expect((await post(labForm({}, new Uint8Array(8_000).fill(0xff)))).status).toBe(400);

      // 16-kHz microphone WAV is only accepted together with the Faster-Whisper lab engine.
      const wavWithoutEngine = labForm();
      wavWithoutEngine.set("sttWav", new File([sttWav() as BlobPart], "mic.wav", { type: "audio/wav" }));
      expect((await post(wavWithoutEngine)).status).toBe(400);

      const mismatchedWav = labForm({ sttEngine: "faster-whisper" });
      mismatchedWav.set("sttWav", new File([sttWav(2) as BlobPart], "mic.wav", { type: "audio/wav" }));
      expect((await post(mismatchedWav)).status).toBe(400);

      expect(turns).toBe(0);
    });

    itDb("returns 503 with the reasons when providers are not configured", async () => {
      enableLab({ LLM_PROVIDER: "dev", STT_PROVIDER: "dev", TTS_PROVIDER: "dev" });
      const a = await identity();
      const agent = await createAgent(a.business.id);
      let turns = 0;
      seams.turn = async () => { turns += 1; return turnResult(agent.id); };

      const res = await call("POST", agent.id, a.token, labForm());
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("PROVIDER_NOT_CONFIGURED");
      expect(turns).toBe(0);
    });

    itDb("runs one telephone-codec turn and returns 8-kHz playback, never a real call", async () => {
      enableLab();
      const a = await identity();
      const agent = await createAgent(a.business.id);
      const inputs: VoiceTurnInput[] = [];
      seams.turn = async (input) => { inputs.push(input); return turnResult(agent.id); };
      const audio = mulawSpeech();

      const res = await call("POST", agent.id, a.token, labForm({ responseStyle: "brief" }, audio));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({
        businessId: a.business.id, agentId: agent.id, audioCodec: "mulaw", audioSampleRate: 8_000,
        ttsFormat: "pcm", actor: a.user.id, briefVoiceReply: true,
      });
      expect(inputs[0].audioMimeType).toBeUndefined();
      expect(inputs[0].callId).toBeUndefined();
      expect(inputs[0].tts).toBeUndefined();
      expect(inputs[0].stt).toBeUndefined();
      expect(Buffer.from(inputs[0].audio as Buffer).equals(Buffer.from(audio))).toBe(true);

      expect(body).toMatchObject({
        mode: "local-telephony-codec", realPhoneCall: false, heard: true, transcript: "سلام",
        sttInputMode: "telephone-8k", input: { durationSeconds: 1, frames20ms: 50 },
      });
      // 0.5 s of 24-kHz PCM becomes 4000 μ-law bytes = 25 frames of 20 ms.
      expect(body.output).toEqual({ mulawBytes: 4_000, frames20ms: 25 });
      const wav = Buffer.from(body.playbackWavBase64, "base64");
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.readUInt32LE(24)).toBe(8_000);
    });

    itDb("passes the opt-in Piper voice and the 16-kHz Faster-Whisper source only when requested", async () => {
      enableLab();
      const a = await identity();
      const agent = await createAgent(a.business.id);
      const inputs: VoiceTurnInput[] = [];
      seams.turn = async (input) => { inputs.push(input); return turnResult(agent.id); };

      const form = labForm({ ttsEngine: "piper", sttEngine: "faster-whisper" });
      const wav = sttWav();
      form.set("sttWav", new File([wav as BlobPart], "mic.wav", { type: "audio/wav" }));
      const res = await call("POST", agent.id, a.token, form);
      expect(res.status).toBe(200);
      expect((await res.json()).sttInputMode).toBe("microphone-16k");

      expect(seams.piper).toEqual([{ voice: "fa_IR-amir-medium", style: "natural" }]);
      expect(inputs[0].tts?.name).toBe("piper");
      expect(inputs[0].stt).toBeDefined();
      expect(inputs[0]).toMatchObject({ audioMimeType: "audio/wav", briefVoiceReply: false });
      expect(inputs[0].audioCodec).toBeUndefined();
      expect(inputs[0].audioSampleRate).toBeUndefined();
      expect(Buffer.from(inputs[0].audio as Buffer).equals(Buffer.from(wav))).toBe(true);
    });

    itDb("returns no playback when the assistant produced no audio, and rejects non-PCM replies", async () => {
      enableLab();
      const a = await identity();
      const agent = await createAgent(a.business.id);

      seams.turn = async () => turnResult(agent.id, { heard: false, audio: null, audioMimeType: null });
      const silent = await call("POST", agent.id, a.token, labForm());
      expect(silent.status).toBe(200);
      expect(await silent.json()).toMatchObject({ heard: false, output: null, playbackWavBase64: null });

      seams.turn = async () => turnResult(agent.id, { audio: Buffer.from("ID3-not-pcm!"), audioMimeType: "audio/mpeg" });
      const mp3 = await call("POST", agent.id, a.token, labForm());
      expect(mp3.status).toBe(415);
    });

    itDb("previews a Piper voice offline at 24 kHz without starting a voice turn", async () => {
      enableLab({ LLM_PROVIDER: "dev", STT_PROVIDER: "dev", TTS_PROVIDER: "dev" });
      const a = await identity();
      const agent = await createAgent(a.business.id);
      let turns = 0;
      seams.turn = async () => { turns += 1; return turnResult(agent.id); };

      const form = new FormData();
      form.set("voicePreview", "piper");
      const res = await call("POST", agent.id, a.token, form);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        mode: "piper-voice-preview", realPhoneCall: false, voice: "fa_IR-amir-medium", style: "natural",
        playbackSampleRate: 24_000, playbackSeconds: 0.5,
      });
      const wav = Buffer.from(body.playbackWavBase64, "base64");
      expect(wav.readUInt32LE(24)).toBe(24_000);
      expect(turns).toBe(0);

      const bad = new FormData();
      bad.set("voicePreview", "piper");
      bad.set("piperVoice", "en_US-anything");
      expect((await call("POST", agent.id, a.token, bad)).status).toBe(400);
    });
  });
});
