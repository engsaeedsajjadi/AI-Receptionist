import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { agentVersions, agents, auditLogs, users } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { createAgent, createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * Agent version restore (`POST /api/v1/agents/:id/versions/:versionId/restore`).
 * Restoring replaces the live assistant configuration, so the route must be
 * permission-gated, tenant-scoped, reject incompatible snapshots, keep the
 * replaced configuration as a new version and leave an audit record.
 */
type Role = "ADMIN" | "VIEWER";

async function identity(role: Role = "ADMIN") {
  const business = await createBusiness();
  const { user } = await createUser(business.id, "ADMIN");
  if (role !== "ADMIN") await db.update(users).set({ role }).where(eq(users.id, user.id));
  const { accessToken } = await issueAuthTokens({ userId: user.id, businessId: business.id, role });
  return { business, user, token: accessToken };
}

async function restore(agentId: string, versionId: string, token?: string) {
  const { POST } = await import("@/app/api/v1/agents/[id]/versions/[versionId]/restore/route");
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const req = new NextRequest(
    `http://localhost/api/v1/agents/${agentId}/versions/${versionId}/restore`,
    { method: "POST", headers },
  );
  return POST(req, { params: Promise.resolve({ id: agentId, versionId }) });
}

async function addVersion(businessId: string, agentId: string, snapshot: Record<string, unknown>) {
  const [row] = await db.insert(agentVersions).values({ businessId, agentId, snapshot }).returning();
  return row;
}

const GOOD_SNAPSHOT = {
  name: "منشی قدیمی",
  systemPrompt: "شما منشی آژانس املاک هستید.",
  voiceProvider: "generic",
  voiceId: "fa-default",
  language: "fa-IR",
  isActive: true,
  configuration: { greeting: "سلام، بفرمایید." },
};

describe.skipIf(!hasTestDatabase())("agent version restore route", () => {
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
  });

  itDb("requires authentication and the agents:write permission", async () => {
    const admin = await identity();
    const agent = await createAgent(admin.business.id);
    const version = await addVersion(admin.business.id, agent.id, GOOD_SNAPSHOT);

    expect((await restore(agent.id, version.id)).status).toBe(401);

    const viewer = await identity("VIEWER");
    const viewerAgent = await createAgent(viewer.business.id);
    const viewerVersion = await addVersion(viewer.business.id, viewerAgent.id, GOOD_SNAPSHOT);
    const denied = await restore(viewerAgent.id, viewerVersion.id, viewer.token);
    expect(denied.status).toBe(403);

    const [untouched] = await db.select().from(agents).where(eq(agents.id, viewerAgent.id));
    expect(untouched.name).toBe("Test Agent");
  });

  itDb("restores the snapshot, keeps the replaced configuration and writes an audit record", async () => {
    const a = await identity();
    const agent = await createAgent(a.business.id);
    const version = await addVersion(a.business.id, agent.id, GOOD_SNAPSHOT);

    const res = await restore(agent.id, version.id, a.token);
    expect(res.status).toBe(200);
    const body = (await res.json());
    expect(body).toMatchObject({
      id: agent.id, name: "منشی قدیمی", systemPrompt: GOOD_SNAPSHOT.systemPrompt,
      voiceId: "fa-default", language: "fa-IR", isActive: true,
    });
    expect(body.configuration).toMatchObject({ agentName: "منشی قدیمی", greeting: "سلام، بفرمایید." });

    // The configuration that was live before the restore is preserved as a new version.
    const versions = await db.select().from(agentVersions).where(eq(agentVersions.agentId, agent.id));
    expect(versions).toHaveLength(2);
    const preserved = versions.find((v) => v.id !== version.id)!;
    expect(preserved.createdBy).toBe(a.user.id);
    expect(preserved.snapshot).toMatchObject({ name: "Test Agent", systemPrompt: "test" });

    const audits = await db.select().from(auditLogs)
      .where(and(eq(auditLogs.businessId, a.business.id), eq(auditLogs.action, "agent.version_restored")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: "agent", entityId: agent.id, actorId: a.user.id });
    expect(audits[0].metadata).toMatchObject({ restoredVersionId: version.id });
  });

  itDb("rejects snapshots that no longer satisfy the current schema without changing the agent", async () => {
    const a = await identity();
    const agent = await createAgent(a.business.id);

    const broken = await addVersion(a.business.id, agent.id, { systemPrompt: "no name here" });
    const brokenRes = await restore(agent.id, broken.id, a.token);
    expect(brokenRes.status).toBe(409);

    const badConfig = await addVersion(a.business.id, agent.id, {
      ...GOOD_SNAPSHOT, configuration: { greeting: "x".repeat(1001) },
    });
    const badConfigRes = await restore(agent.id, badConfig.id, a.token);
    expect(badConfigRes.status).toBe(409);

    const [current] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(current.name).toBe("Test Agent");
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "agent.version_restored"))).toHaveLength(0);
  });

  itDb("refuses a cloned voice id that the tenant has no consent for", async () => {
    const a = await identity();
    const agent = await createAgent(a.business.id);
    const version = await addVersion(a.business.id, agent.id, { ...GOOD_SNAPSHOT, voiceId: "cloned-voice-of-someone" });

    const res = await restore(agent.id, version.id, a.token);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const [current] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(current.voiceId).not.toBe("cloned-voice-of-someone");
  });

  itDb("returns 404 for unknown versions, versions of another agent and other tenants", async () => {
    const a = await identity();
    const b = await identity();
    const agentA = await createAgent(a.business.id);
    const secondAgentA = await createAgent(a.business.id);
    const agentB = await createAgent(b.business.id);
    const versionB = await addVersion(b.business.id, agentB.id, GOOD_SNAPSHOT);
    const versionOfSecond = await addVersion(a.business.id, secondAgentA.id, GOOD_SNAPSHOT);

    const unknown = await restore(agentA.id, "00000000-0000-4000-8000-000000000000", a.token);
    expect(unknown.status).toBe(404);

    const wrongAgent = await restore(agentA.id, versionOfSecond.id, a.token);
    expect(wrongAgent.status).toBe(404);

    const crossTenant = await restore(agentB.id, versionB.id, a.token);
    expect(crossTenant.status).toBe(404);
    const [bAgent] = await db.select().from(agents).where(eq(agents.id, agentB.id));
    expect(bAgent.name).toBe("Test Agent");
  });
});
