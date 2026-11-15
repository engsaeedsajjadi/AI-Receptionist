import { afterAll, afterEach, beforeAll, describe, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { agents, auditLogs, users } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { resetEnvCache } from "@/lib/env";
import type { LLMProvider, ChatCompletionResult } from "@/lib/providers/llm";
import type { TTSProvider, SpeechResult } from "@/lib/providers/tts";
import { runVoiceTurn } from "@/lib/voice/turn";
import { assertVoiceAllowed } from "@/lib/voice/voice-safety";
import { POST as createAgentRoute } from "@/app/api/v1/agents/route";
import { PUT as updateAgentRoute } from "@/app/api/v1/agents/[id]/route";
import { GET as consentGet, POST as consentPost, DELETE as consentDelete } from "@/app/api/v1/business/voice-consent/route";
import { createAgent, createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * Voice-cloning safety.
 *
 * The gate must fail closed in both directions: a tenant-configured voice id that
 * is not an approved publisher voice is refused unless the platform opt-in is on
 * *and* the tenant has a recorded consent, and the check runs both when the voice
 * is configured and when speech is synthesized.
 */

let ipSeq = 0;
type Init = { token?: string; body?: unknown; method?: string };
function send(path: string, init: Init = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-real-ip": `10.9.${(ipSeq >> 8) % 250}.${(ipSeq++ % 250) + 1}`,
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const agentCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const agentName = () => `منشی ${crypto.randomUUID().slice(0, 6)}`;

async function tenant(role: "ADMIN" | "VIEWER" = "ADMIN") {
  const business = await createBusiness(`Voice ${crypto.randomUUID().slice(0, 8)}`);
  const { user } = await createUser(business.id, "ADMIN");
  if (role !== "ADMIN") await db.update(users).set({ role }).where(eq(users.id, user.id));
  const tokens = await issueAuthTokens({ userId: user.id, businessId: business.id, role });
  return { business, user, token: tokens.accessToken };
}

class RecordingTTS implements TTSProvider {
  readonly name = "recording";
  calls: Array<{ text: string; voice?: string }> = [];
  async synthesize(text: string, options?: { voice?: string }): Promise<SpeechResult> {
    this.calls.push({ text, voice: options?.voice });
    return { audio: Buffer.from(`AUDIO:${text}`), mimeType: "audio/mpeg", usage: { characters: text.length }, provider: "recording", model: "none", voice: options?.voice ?? "default" };
  }
}

class SilentLLM implements LLMProvider {
  readonly name = "silent";
  async complete(): Promise<ChatCompletionResult> {
    return { content: "سلام", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: "none", latencyMs: 1 };
  }
}

describe.skipIf(!hasTestDatabase())("voice-cloning safety", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    resetEnvCache();
    await truncateAll();
    await closeDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  itDb("allows publisher voices and refuses unknown voice ids at configuration time", async () => {
    const { business, token } = await tenant();
    const allowed = await createAgentRoute(send("/api/v1/agents", { token, body: { name: agentName(), voiceId: "fa-default" } }));
    expect(allowed.status).toBe(201);
    const inserted = await createAgentRoute(send("/api/v1/agents", { token, body: { name: agentName(), voiceId: "alloy" } }));
    expect(inserted.status).toBe(201);

    const refused = await createAgentRoute(send("/api/v1/agents", { token, body: { name: "کlon", voiceId: "cloned-voice-xyz" } }));
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VOICE_CONSENT_REQUIRED");
    const rows = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.businessId, business.id), eq(agents.voiceId, "cloned-voice-xyz")));
    expect(rows).toHaveLength(0);
  });

  itDb("requires the platform opt-in AND recorded consent, and audits the consent lifecycle", async () => {
    const { business, token } = await tenant();

    // Consent recorded while cloning is disabled: still refused (platform gate).
    const recorded = await consentPost(send("/api/v1/business/voice-consent", { token, body: { subject: "Sample Speaker", reference: "contract-2026-01", voiceIds: ["cloned-voice-xyz"] } }));
    expect(recorded.status).toBe(201);
    const stillDisabled = await createAgentRoute(send("/api/v1/agents", { token, body: { name: agentName(), voiceId: "cloned-voice-xyz" } }));
    expect(stillDisabled.status).toBe(403);

    // Platform opt-in + consent ⇒ allowed, and the decision is reversible.
    vi.stubEnv("VOICE_CLONING_ENABLED", "true");
    resetEnvCache();
    const accepted = await createAgentRoute(send("/api/v1/agents", { token, body: { name: agentName(), voiceId: "cloned-voice-xyz" } }));
    expect(accepted.status).toBe(201);
    const created = (await accepted.json()) as { id: string; voiceId: string };
    expect(created.voiceId).toBe("cloned-voice-xyz");

    // A *different* unapproved voice still needs its own decision — and gets refused.
    const otherVoice = await updateAgentRoute(
      send("/api/v1/agents/x", { token, method: "PUT", body: { voiceId: "another-clone" } }),
      agentCtx(created.id),
    );
    expect(otherVoice.status).toBe(403);

    const status = await consentGet(send("/api/v1/business/voice-consent", { token }));
    const statusBody = (await status.json()) as { cloningEnabled: boolean; consent: { subject: string } | null };
    expect(statusBody.cloningEnabled).toBe(true);
    expect(statusBody.consent?.subject).toBe("Sample Speaker");

    // Revocation takes effect immediately, even for an already-configured agent.
    expect((await consentDelete(send("/api/v1/business/voice-consent", { token, method: "DELETE" }))).status).toBe(200);
    await expect(assertVoiceAllowed({ businessId: business.id, voiceId: "cloned-voice-xyz" })).rejects.toMatchObject({ code: "VOICE_CONSENT_REQUIRED" });

    const audit = await db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.businessId, business.id));
    expect(audit.map((row) => row.action).sort()).toEqual(["voice.consent_recorded", "voice.consent_revoked"]);
  });

  itDb("operator allowlist and cross-tenant isolation both hold", async () => {
    const a = await tenant();
    const b = await tenant();

    vi.stubEnv("TTS_ALLOWED_VOICE_IDS", "studio-voice-1, studio-voice-2");
    resetEnvCache();
    const viaAllowlist = await createAgentRoute(send("/api/v1/agents", { token: a.token, body: { name: agentName(), voiceId: "studio-voice-2" } }));
    expect(viaAllowlist.status).toBe(201);
    // Tenant B still needs its own consent/allowlist decision — it has neither.
    expect((await createAgentRoute(send("/api/v1/agents", { token: b.token, body: { name: agentName(), voiceId: "cloned-voice-xyz" } }))).status).toBe(403);

    // A's consent record never applies to B.
    vi.stubEnv("VOICE_CLONING_ENABLED", "true");
    resetEnvCache();
    expect((await consentPost(send("/api/v1/business/voice-consent", { token: a.token, body: { subject: "Sample Speaker A", reference: "ref-A", voiceIds: ["shared-clone"] } }))).status).toBe(201);
    expect((await createAgentRoute(send("/api/v1/agents", { token: a.token, body: { name: agentName(), voiceId: "shared-clone" } }))).status).toBe(201);
    expect((await createAgentRoute(send("/api/v1/agents", { token: b.token, body: { name: agentName(), voiceId: "shared-clone" } }))).status).toBe(403);
    const bStatus = (await (await consentGet(send("/api/v1/business/voice-consent", { token: b.token }))).json()) as { consent: unknown };
    expect(bStatus.consent).toBeNull();

    // VIEWER cannot record or revoke consent.
    const viewer = await tenant("VIEWER");
    expect((await consentPost(send("/api/v1/business/voice-consent", { token: viewer.token, body: { subject: "x-tenant", reference: "ref-x", voiceIds: ["anything"] } }))).status).toBe(403);
    expect((await consentDelete(send("/api/v1/business/voice-consent", { token: viewer.token, method: "DELETE" }))).status).toBe(403);
  });

  itDb("synthesis honors the agent voice, and a non-publisher agent voice is refused at synthesis time", async () => {
    const { business, token } = await tenant();
    const agent = await createAgent(business.id);
    vi.stubEnv("VOICE_CLONING_ENABLED", "true");
    resetEnvCache();
    await db.update(agents).set({ voiceId: "cloned-voice-xyz" }).where(eq(agents.id, agent.id));

    const blockedTts = new RecordingTTS();
    await expect(
      runVoiceTurn({
        businessId: business.id,
        agentId: agent.id,
        transcript: "سلام",
        eventId: `evt-${crypto.randomUUID()}`,
        requestId: `req-${crypto.randomUUID()}`,
        actor: "test",
        tts: blockedTts,
        llm: new SilentLLM(),
      }),
    ).rejects.toMatchObject({ code: "VOICE_CONSENT_REQUIRED" });
    expect(blockedTts.calls).toHaveLength(0);

    // With consent the configured voice reaches the synthesizer.
    expect((await consentPost(send("/api/v1/business/voice-consent", { token, body: { subject: "Speaker", reference: "ref-1", voiceIds: ["cloned-voice-xyz"] } }))).status).toBe(201);
    const tts = new RecordingTTS();
    const result = await runVoiceTurn({
      businessId: business.id,
      agentId: agent.id,
      transcript: "سلام",
      eventId: `evt-${crypto.randomUUID()}`,
      requestId: `req-${crypto.randomUUID()}`,
      actor: "test",
      tts,
      llm: new SilentLLM(),
    });
    expect(result.heard).toBe(true);
    expect(tts.calls).toHaveLength(1);
    expect(tts.calls[0].voice).toBe("cloned-voice-xyz");
  });
});
