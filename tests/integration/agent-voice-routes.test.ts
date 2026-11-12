import { afterAll, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { agents, usageRecords } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { createAgent, createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import type { SpeechResult, TTSProvider } from "@/lib/providers/tts";
import type { VoiceTurnInput, VoiceTurnResult } from "@/lib/voice/turn";

// Switchable seams: by default the real modules run (the unconfigured `dev`
// providers must refuse); individual tests install deterministic fakes.
const seams = vi.hoisted(() => ({
  tts: null as TTSProvider | null,
  turn: null as ((input: VoiceTurnInput) => Promise<VoiceTurnResult>) | null,
}));

vi.mock("@/lib/providers/tts", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/providers/tts")>();
  return { ...actual, getTTSProvider: () => seams.tts ?? actual.getTTSProvider() };
});

vi.mock("@/lib/voice/turn", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/voice/turn")>();
  return {
    ...actual,
    runVoiceTurn: (input: VoiceTurnInput) => (seams.turn ? seams.turn(input) : actual.runVoiceTurn(input)),
  };
});

class FakeTTS implements TTSProvider {
  readonly name = "fake";
  calls: Array<{ text: string; voice?: string; format?: string }> = [];
  async synthesize(text: string, options?: { voice?: string; format?: string }): Promise<SpeechResult> {
    this.calls.push({ text, voice: options?.voice, format: options?.format });
    return {
      audio: Buffer.from(`AUDIO:${text}`),
      mimeType: "audio/mpeg",
      provider: "fake",
      model: "fake-tts",
      voice: options?.voice ?? "fa-default",
      usage: { characters: text.length },
    } as SpeechResult;
  }
}

/**
 * Dashboard voice tools:
 *  - `POST /api/v1/agents/:id/voice-preview` synthesizes a short sample and
 *    meters the characters;
 *  - `POST /api/v1/agents/:id/voice-test` accepts a browser recording and runs
 *    one voice turn.
 * Both spend provider quota, so authentication, tenant scoping, the active-agent
 * rule and the upload limits are the contract. Provider behaviour comes from
 * the deterministic `dev` providers (no network).
 */
async function identity() {
  const business = await createBusiness();
  const { user } = await createUser(business.id, "ADMIN");
  const { accessToken } = await issueAuthTokens({ userId: user.id, businessId: business.id, role: "ADMIN" });
  return { business, user, token: accessToken };
}

function auth(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function preview(agentId: string, token: string | undefined, body: unknown = {}) {
  const { POST } = await import("@/app/api/v1/agents/[id]/voice-preview/route");
  const req = new NextRequest(`http://localhost/api/v1/agents/${agentId}/voice-preview`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id: agentId }) });
}

async function voiceTest(agentId: string, token: string | undefined, form: FormData) {
  const { POST } = await import("@/app/api/v1/agents/[id]/voice-test/route");
  const req = new NextRequest(`http://localhost/api/v1/agents/${agentId}/voice-test`, {
    method: "POST",
    headers: auth(token),
    body: form,
  });
  return POST(req, { params: Promise.resolve({ id: agentId }) });
}

function audioForm(bytes: Uint8Array, type: string) {
  const form = new FormData();
  form.set("audio", new File([bytes as BlobPart], "sample.bin", { type }));
  return form;
}

describe.skipIf(!hasTestDatabase())("agent voice preview and voice test routes", () => {
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
    seams.tts = null;
    seams.turn = null;
  });

  describe("voice-preview", () => {
    itDb("requires authentication and validates the request body", async () => {
      const a = await identity();
      const agent = await createAgent(a.business.id);

      expect((await preview(agent.id, undefined)).status).toBe(401);
      expect((await preview(agent.id, a.token, { text: "" })).status).toBe(400);
      expect((await preview(agent.id, a.token, { text: "x".repeat(701) })).status).toBe(400);
      expect((await preview(agent.id, a.token, { text: "سلام", voice: "someone-else" })).status).toBe(400);
      expect(await db.select().from(usageRecords)).toHaveLength(0);
    });

    itDb("fails closed with 503 and meters nothing when no TTS provider is configured", async () => {
      const a = await identity();
      const agent = await createAgent(a.business.id);

      const res = await preview(agent.id, a.token, { text: "سلام" });
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("PROVIDER_NOT_CONFIGURED");
      const recorded = await db.select().from(usageRecords)
        .where(and(eq(usageRecords.businessId, a.business.id), eq(usageRecords.type, "tts_characters")));
      expect(recorded).toHaveLength(0);
    });

    itDb("returns the synthesized audio in the agent's voice and meters the characters", async () => {
      const a = await identity();
      const agent = await createAgent(a.business.id);
      const tts = new FakeTTS();
      seams.tts = tts;
      const text = "سلام، وقت بخیر. چطور می‌توانم کمکتان کنم؟";

      const res = await preview(agent.id, a.token, { text });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const audio = Buffer.from(await res.arrayBuffer());
      expect(audio.toString()).toBe(`AUDIO:${text}`);
      expect(res.headers.get("Content-Length")).toBe(String(audio.byteLength));
      expect(tts.calls).toEqual([{ text, voice: agent.voiceId, format: "mp3" }]);

      const usage = await db.select().from(usageRecords)
        .where(and(eq(usageRecords.businessId, a.business.id), eq(usageRecords.type, "tts_characters")));
      const previewRow = usage.find((u) => u.idempotencyKey?.startsWith("voice-preview:"));
      expect(previewRow).toBeDefined();
      expect(Number(previewRow!.quantity)).toBe(text.length);
      expect(previewRow!.provider).toBe("fake");
      expect(previewRow!.metadata).toMatchObject({ agentId: agent.id, model: "fake-tts" });
    });

    itDb("uses the default Persian sample when no text is sent", async () => {
      const a = await identity();
      const agent = await createAgent(a.business.id);
      const tts = new FakeTTS();
      seams.tts = tts;

      const res = await preview(agent.id, a.token, {});
      expect(res.status).toBe(200);
      expect(tts.calls[0].text).toBe("سلام، من منشی هوشمند شما هستم.");
    });

    itDb("refuses inactive agents, other tenants' agents and non-consented cloned voices", async () => {
      const a = await identity();
      const b = await identity();
      const inactive = await createAgent(a.business.id);
      await db.update(agents).set({ isActive: false }).where(eq(agents.id, inactive.id));
      const foreign = await createAgent(b.business.id);
      const tts = new FakeTTS();
      seams.tts = tts;
      const cloned = await createAgent(a.business.id);
      await db.update(agents).set({ voiceId: "cloned-voice-of-someone" }).where(eq(agents.id, cloned.id));

      expect((await preview(inactive.id, a.token)).status).toBe(404);
      expect((await preview(foreign.id, a.token)).status).toBe(404);

      const clonedRes = await preview(cloned.id, a.token);
      expect(clonedRes.status).toBeGreaterThanOrEqual(400);
      expect(clonedRes.status).toBeLessThan(500);
      expect(tts.calls).toHaveLength(0);
      expect(await db.select().from(usageRecords)).toHaveLength(0);
    });
  });

  describe("voice-test", () => {
    itDb("requires authentication and an active agent of the caller's tenant", async () => {
      const a = await identity();
      const b = await identity();
      const agent = await createAgent(a.business.id);
      const foreign = await createAgent(b.business.id);
      const form = () => audioForm(new Uint8Array(64).fill(1), "audio/webm");

      expect((await voiceTest(agent.id, undefined, form())).status).toBe(401);
      expect((await voiceTest(foreign.id, a.token, form())).status).toBe(404);

      await db.update(agents).set({ isActive: false }).where(eq(agents.id, agent.id));
      expect((await voiceTest(agent.id, a.token, form())).status).toBe(404);
    });

    itDb("rejects missing, empty, oversized and unsupported uploads before any provider work", async () => {
      const a = await identity();
      const agent = await createAgent(a.business.id);
      let turns = 0;
      seams.turn = async () => { turns += 1; throw new Error("must not be reached"); };

      const missing = await voiceTest(agent.id, a.token, new FormData());
      expect(missing.status).toBe(400);

      const notAFile = new FormData();
      notAFile.set("audio", "just-a-string");
      expect((await voiceTest(agent.id, a.token, notAFile)).status).toBe(400);

      const empty = await voiceTest(agent.id, a.token, audioForm(new Uint8Array(0), "audio/webm"));
      expect(empty.status).toBe(413);

      const tooLarge = await voiceTest(agent.id, a.token, audioForm(new Uint8Array(4 * 1024 * 1024 + 1), "audio/webm"));
      expect(tooLarge.status).toBe(413);

      const wrongType = await voiceTest(agent.id, a.token, audioForm(new Uint8Array(64).fill(1), "video/mp4"));
      expect(wrongType.status).toBe(415);

      const untyped = await voiceTest(agent.id, a.token, audioForm(new Uint8Array(64).fill(1), ""));
      expect(untyped.status).toBe(415);

      expect(turns).toBe(0);
      expect(await db.select().from(usageRecords)).toHaveLength(0);
    });

    itDb("fails closed with 503 when no speech provider is configured", async () => {
      const a = await identity();
      const agent = await createAgent(a.business.id);
      const res = await voiceTest(agent.id, a.token, audioForm(new Uint8Array(2_048).fill(7), "audio/webm"));
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("PROVIDER_NOT_CONFIGURED");
    });

    itDb("runs exactly one tenant-scoped voice turn and returns its result (codec parameters ignored)", async () => {
      const a = await identity();
      const agent = await createAgent(a.business.id);
      const inputs: VoiceTurnInput[] = [];
      seams.turn = async (input) => {
        inputs.push(input);
        return {
          duplicate: false, heard: true, transcript: "یک آپارتمان دو خوابه می‌خواهم", sttLanguage: "fa",
          sttDurationSeconds: 2, reply: "بودجه شما چقدر است؟", spokenText: "بودجه شما چقدر است؟",
          audio: Buffer.from("REPLY-AUDIO"), audioMimeType: "audio/mpeg", audioUrl: null, audioStored: false,
          agentId: agent.id, toolCalls: [{ tool: "search_properties", status: "SUCCESS" }],
          usage: { sttMinutes: 2 / 60, ttsCharacters: 19, llmInputTokens: 10, llmOutputTokens: 5 },
          latencyMs: { total: 12, stt: 3, agent: 5, tts: 4 },
        };
      };
      const recording = new Uint8Array(2_048).fill(7);

      const res = await voiceTest(agent.id, a.token, audioForm(recording, "audio/webm;codecs=opus"));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({
        businessId: a.business.id, agentId: agent.id, audioMimeType: "audio/webm", actor: a.user.id, ttsFormat: "mp3",
      });
      expect(Buffer.from(inputs[0].audio as Buffer).equals(Buffer.from(recording))).toBe(true);
      // A dashboard test must never be attributed to a real call.
      expect(inputs[0].callId).toBeUndefined();

      expect(body).toMatchObject({
        heard: true, transcript: "یک آپارتمان دو خوابه می‌خواهم", reply: "بودجه شما چقدر است؟",
        audioMimeType: "audio/mpeg", toolCalls: [{ tool: "search_properties", status: "SUCCESS" }],
      });
      expect(Buffer.from(body.audioBase64, "base64").toString()).toBe("REPLY-AUDIO");
      expect(body.latencyMs.total).toBe(12);
      // Storage URLs and internal ids are not part of the dashboard response.
      expect(body).not.toHaveProperty("audioUrl");
    });

    itDb("returns a null audio payload when the assistant heard nothing", async () => {
      const a = await identity();
      const agent = await createAgent(a.business.id);
      seams.turn = async () => ({
        duplicate: false, heard: false, transcript: "", sttLanguage: null, sttDurationSeconds: null,
        reply: "", spokenText: "", audio: null, audioMimeType: null, audioUrl: null, audioStored: false,
        agentId: agent.id, toolCalls: [],
        usage: { sttMinutes: 0, ttsCharacters: 0, llmInputTokens: 0, llmOutputTokens: 0 },
        latencyMs: { total: 1 },
      });
      const res = await voiceTest(agent.id, a.token, audioForm(new Uint8Array(512).fill(1), "audio/wav"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ heard: false, audioBase64: null, audioMimeType: null });
    });
  });
});
