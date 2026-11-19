import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { Behavior, type FunctionDeclaration, type LiveConnectConfig } from "@google/genai";
import { closeDb, db } from "@/db";
import { agents, auditLogs } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { resetEnvCache } from "@/lib/env";
import { LIVE_MAX_TOOL_CALLS, setLiveTokenMinterForTests } from "@/lib/voice/gemini-live";
import { createAgent, createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * Gemini Live mode of the developer telephone lab
 * (`/api/v1/agents/:id/live-session` and `/live-session/tool`).
 *
 * The browser receives a single-use ephemeral token and calls tools back through
 * the server, so the contract under test is: the lab guard holds, the token is
 * locked to this agent's own prompt and allow-listed tools, and a tool call only
 * runs for the session's own tenant, user and agent. The Google token call is
 * replaced by a seam — no network.
 */
const LAB_DB = "postgresql://ai_test:test-only-ci@127.0.0.1:5432/ai_receptionist_test";

type Minted = { apiKey: string; model: string; config: LiveConnectConfig; expireTime: string; newSessionExpireTime: string };
const minted: Minted[] = [];

function enableLab(overrides: Record<string, string> = {}) {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DATABASE_URL", LAB_DB);
  vi.stubEnv("TEST_DATABASE_URL", LAB_DB);
  vi.stubEnv("COMPATIBLE_LLM_API_KEY", "server-side-gemini-key");
  vi.stubEnv("GEMINI_LIVE_VOICE", "");
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
  resetEnvCache();
}

async function identity() {
  const business = await createBusiness();
  const { user } = await createUser(business.id, "ADMIN");
  const { accessToken } = await issueAuthTokens({ userId: user.id, businessId: business.id, role: "ADMIN" });
  return { business, user, token: accessToken };
}

async function session(method: "GET" | "POST", agentId: string, token?: string) {
  const route = await import("@/app/api/v1/agents/[id]/live-session/route");
  const req = new NextRequest(`http://localhost/api/v1/agents/${agentId}/live-session`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return route[method](req, { params: Promise.resolve({ id: agentId }) });
}

async function tool(agentId: string, token: string | undefined, body: unknown) {
  const route = await import("@/app/api/v1/agents/[id]/live-session/tool/route");
  const req = new NextRequest(`http://localhost/api/v1/agents/${agentId}/live-session/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return route.POST(req, { params: Promise.resolve({ id: agentId }) });
}

function declarations(config: LiveConnectConfig): FunctionDeclaration[] {
  return (config.tools ?? []).flatMap((t) => (t as { functionDeclarations?: FunctionDeclaration[] }).functionDeclarations ?? []);
}

function promptOf(config: LiveConnectConfig): string {
  const instruction = config.systemInstruction as { parts?: Array<{ text?: string }> };
  return (instruction.parts ?? []).map((p) => p.text ?? "").join("");
}

describe.skipIf(!hasTestDatabase())("Gemini Live lab routes", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    setLiveTokenMinterForTests(null);
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
    minted.length = 0;
    setLiveTokenMinterForTests(async (params) => {
      minted.push(params);
      return `auth_tokens/test-${minted.length}`;
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  itDb("does not exist outside development and refuses a non-disposable database", async () => {
    const a = await identity();
    const agent = await createAgent(a.business.id);
    for (const mode of ["test", "production"]) {
      vi.stubEnv("NODE_ENV", mode);
      vi.stubEnv("DATABASE_URL", LAB_DB);
      expect((await session("POST", agent.id, a.token)).status).toBe(404);
      expect((await tool(agent.id, a.token, {})).status).toBe(404);
    }
    enableLab({ DATABASE_URL: "postgresql://app:secret@db.internal.example:5432/ai_receptionist_test" });
    expect((await session("POST", agent.id, a.token)).status).toBe(403);
    expect(minted).toHaveLength(0);
  });

  itDb("requires authentication and an active agent of the caller's own tenant", async () => {
    const a = await identity();
    const b = await identity();
    const foreign = await createAgent(b.business.id);
    enableLab();
    expect((await session("POST", foreign.id)).status).toBe(401);
    expect((await session("POST", foreign.id, a.token)).status).toBe(404);
    const inactive = await createAgent(a.business.id);
    await db.update(agents).set({ isActive: false }).where(eq(agents.id, inactive.id));
    expect((await session("POST", inactive.id, a.token)).status).toBe(404);
    expect(minted).toHaveLength(0);
  });

  itDb("reports readiness and refuses to mint without a Gemini key", async () => {
    const a = await identity();
    const agent = await createAgent(a.business.id);
    enableLab();
    expect(await (await session("GET", agent.id, a.token)).json()).toEqual({ ready: true, reasons: [] });
    enableLab({ COMPATIBLE_LLM_API_KEY: "" });
    const body = await (await session("GET", agent.id, a.token)).json();
    expect(body.ready).toBe(false);
    expect((await session("POST", agent.id, a.token)).status).toBe(503);
    expect(minted).toHaveLength(0);
  });

  itDb("mints a single-use token locked to the agent's prompt and blocking tools, never exposing the API key", async () => {
    const a = await identity();
    const agent = await createAgent(a.business.id);
    enableLab({ GEMINI_LIVE_VOICE: "Kore" });
    const res = await session("POST", agent.id, a.token);
    expect(res.status).toBe(200);
    const grant = await res.json();
    expect(grant.token).toBe("auth_tokens/test-1");
    expect(grant.model).toBe("gemini-3.8-live");
    expect(grant.realPhoneCall).toBe(false);
    expect(grant.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(grant)).not.toContain("server-side-gemini-key");

    expect(minted).toHaveLength(1);
    const [params] = minted;
    expect(params.apiKey).toBe("server-side-gemini-key");
    expect(params.model).toBe("gemini-3.8-live");
    const lifetime = Date.parse(params.expireTime) - Date.now();
    expect(lifetime).toBeGreaterThan(25 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(30 * 60_000);
    expect(Date.parse(params.newSessionExpireTime) - Date.now()).toBeLessThanOrEqual(60_000);

    // The locked config is the tenant's guardrailed prompt plus the live phone style.
    expect(promptOf(params.config)).toContain(a.business.name);
    expect(promptOf(params.config)).toContain("مکالمهٔ زندهٔ تلفنی");
    expect(params.config.inputAudioTranscription).toEqual({});
    expect(params.config.outputAudioTranscription).toEqual({});
    expect(params.config.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe("Kore");
    const fns = declarations(params.config);
    expect(fns.map((f) => f.name)).toEqual(expect.arrayContaining(["create_appointment", "create_lead", "check_availability"]));
    for (const fn of fns) {
      expect(fn.behavior).toBe(Behavior.BLOCKING);
      expect(fn.parametersJsonSchema).toBeTypeOf("object");
      expect(fn.parametersJsonSchema).not.toHaveProperty("$schema");
    }
    expect(grant.tools).toEqual(fns.map((f) => f.name));
  });

  itDb("only declares the agent's allow-listed tools", async () => {
    const a = await identity();
    const agent = await createAgent(a.business.id);
    await db.update(agents).set({ configuration: { allowedTools: ["get_business_info"] } }).where(eq(agents.id, agent.id));
    enableLab();
    const grant = await (await session("POST", agent.id, a.token)).json();
    expect(declarations(minted[0].config).map((f) => f.name)).toEqual(["get_business_info"]);
    expect(grant.tools).toEqual(["get_business_info"]);
  });

  itDb("a provider failure is a 502 without the key in the message", async () => {
    const a = await identity();
    const agent = await createAgent(a.business.id);
    enableLab();
    setLiveTokenMinterForTests(async () => { throw new Error("quota exceeded"); });
    const res = await session("POST", agent.id, a.token);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("server-side-gemini-key");
  });

  itDb("runs an allowed tool through the audited registry with server-side tenant context", async () => {
    const a = await identity();
    const agent = await createAgent(a.business.id);
    enableLab();
    const grant = await (await session("POST", agent.id, a.token)).json();
    const res = await tool(agent.id, a.token, {
      sessionId: grant.sessionId,
      name: "get_business_info",
      // A model echoing tenant ids must not move the call to another tenant.
      args: { businessId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("SUCCESS");
    expect(body.data.name).toBe(a.business.name);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.businessId, a.business.id));
    expect(audits.some((row) => row.action === "tool.get_business_info" && row.actorId === a.user.id)).toBe(true);
  });

  itDb("refuses sessions of another user, agent or tenant, and tools outside the allow-list", async () => {
    const a = await identity();
    const agent = await createAgent(a.business.id);
    const otherAgent = await createAgent(a.business.id);
    enableLab();
    await db.update(agents).set({ configuration: { allowedTools: ["get_business_info"] } }).where(eq(agents.id, agent.id));
    const grant = await (await session("POST", agent.id, a.token)).json();

    const { user: colleague } = await createUser(a.business.id, "ADMIN");
    const { accessToken: colleagueToken } = await issueAuthTokens({ userId: colleague.id, businessId: a.business.id, role: "ADMIN" });
    expect((await tool(agent.id, colleagueToken, { sessionId: grant.sessionId, name: "get_business_info", args: {} })).status).toBe(404);
    expect((await tool(otherAgent.id, a.token, { sessionId: grant.sessionId, name: "get_business_info", args: {} })).status).toBe(404);
    const b = await identity();
    const foreignAgent = await createAgent(b.business.id);
    expect((await tool(foreignAgent.id, b.token, { sessionId: grant.sessionId, name: "get_business_info", args: {} })).status).toBe(404);
    expect((await tool(agent.id, undefined, { sessionId: grant.sessionId, name: "get_business_info", args: {} })).status).toBe(401);

    const denied = await (await tool(agent.id, a.token, { sessionId: grant.sessionId, name: "create_appointment", args: {} })).json();
    expect(denied).toEqual({ status: "FAILED", error: "Tool is not allowed for this agent" });
    expect((await tool(agent.id, a.token, { sessionId: crypto.randomUUID(), name: "get_business_info", args: {} })).status).toBe(404);
  });

  itDb("validates the tool payload", async () => {
    const a = await identity();
    const agent = await createAgent(a.business.id);
    enableLab();
    const grant = await (await session("POST", agent.id, a.token)).json();
    expect((await tool(agent.id, a.token, "not json")).status).toBe(400);
    expect((await tool(agent.id, a.token, { sessionId: "../x", name: "get_business_info", args: {} })).status).toBe(400);
    expect((await tool(agent.id, a.token, { sessionId: grant.sessionId, name: "DROP TABLE", args: {} })).status).toBe(400);
    expect((await tool(agent.id, a.token, { sessionId: grant.sessionId, name: "get_business_info", args: [1] })).status).toBe(400);
    expect((await tool(agent.id, a.token, { sessionId: grant.sessionId, name: "get_business_info", args: { x: "a".repeat(5000) } })).status).toBe(413);
  });

  itDb("caps tool calls per lab session", async () => {
    const a = await identity();
    const agent = await createAgent(a.business.id);
    enableLab();
    const grant = await (await session("POST", agent.id, a.token)).json();
    let last: { status: string; error?: string } = { status: "" };
    for (let i = 0; i <= LIVE_MAX_TOOL_CALLS; i++) {
      last = await (await tool(agent.id, a.token, { sessionId: grant.sessionId, name: "get_business_info", args: {} })).json();
    }
    expect(last).toEqual({ status: "FAILED", error: "Tool call limit for this lab session reached" });
  });
});
