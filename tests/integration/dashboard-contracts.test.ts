import { afterAll, beforeAll, describe, expect } from "vitest";
import { NextRequest } from "next/server";
import { db, closeDb } from "@/db";
import { calls, automationJobs, usageRecords, notifications } from "@/db/schema";
import { eq } from "drizzle-orm";
import { issueAuthTokens } from "@/lib/auth";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createBusiness, createUser, createAgent, createCall, createCustomer, createLead, createProperty, createKnowledgeDoc } from "../helpers/fixtures";
import * as agentApi from "@/app/api/v1/agents/[id]/route";
import { GET as versions } from "@/app/api/v1/agents/[id]/versions/route";
import { POST as activate } from "@/app/api/v1/agents/[id]/activate/route";
import { POST as deactivate } from "@/app/api/v1/agents/[id]/deactivate/route";
import * as customerApi from "@/app/api/v1/customers/[id]/route";
import * as notes from "@/app/api/v1/leads/[id]/notes/route";
import * as settings from "@/app/api/v1/business/settings/route";
import * as sessions from "@/app/api/v1/auth/sessions/route";
import * as jobs from "@/app/api/v1/automation/jobs/route";
import * as documentApi from "@/app/api/v1/knowledge/[id]/route";
import { POST as reindex } from "@/app/api/v1/knowledge/reindex/route";
const listRoutes = {
  agents: () => import("@/app/api/v1/agents/route"),
  calls: () => import("@/app/api/v1/calls/route"),
  customers: () => import("@/app/api/v1/customers/route"),
  leads: () => import("@/app/api/v1/leads/route"),
  properties: () => import("@/app/api/v1/properties/route"),
  knowledge: () => import("@/app/api/v1/knowledge/route"),
  usage: () => import("@/app/api/v1/usage/route"),
  notifications: () => import("@/app/api/v1/notifications/route"),
  users: () => import("@/app/api/v1/users/route")
};
let sequence = 0;
function req(path: string, token: string, method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost/api/v1/${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-real-ip": `dashboard-test-${++sequence}` }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function seed() {
  const business = await createBusiness(), { user } = await createUser(business.id);
  const token = (await issueAuthTokens({ userId: user.id, businessId: business.id, role: "ADMIN" })).accessToken;
  const agent = await createAgent(business.id), customer = await createCustomer(business.id), call = await createCall(business.id), lead = await createLead(business.id, customer.id), property = await createProperty(business.id), document = await createKnowledgeDoc(business.id);
  await db.update(calls).set({ customerId: customer.id, summary: "customer summary", transcript: "customer transcript" }).where(eq(calls.id, call.id));
  await db.insert(usageRecords).values({ businessId: business.id, type: "calls", quantity: "1", unit: "call" });
  await db.insert(notifications).values({ businessId: business.id, channel: "internal", recipient: "operator", type: "test", title: "Notice", message: "Details" });
  const [job] = await db.insert(automationJobs).values({ businessId: business.id, event: "new-lead", payload: {}, idempotencyKey: crypto.randomUUID(), status: "dead", attempts: 8 }).returning();
  return { business, user, token, agent, customer, call, lead, property, document, job };
}
describe.skipIf(!hasTestDatabase())("dashboard API tenant contracts", () => {
  let a: Awaited<ReturnType<typeof seed>>, b: Awaited<ReturnType<typeof seed>>;
  beforeAll(async () => { await ensureDbReady(); await truncateAll(); a = await seed(); b = await seed(); });
  afterAll(async () => { await truncateAll(); await closeDb(); });
  for (const route of ["agents", "calls", "customers", "leads", "properties", "knowledge", "usage", "notifications", "users"] as const) {
    itDb(`${route} list is authenticated and excludes the other tenant`, async () => {
      const api = await listRoutes[route]();
      const rejected = await api.GET(req(route, "invalid")); expect(rejected.status).toBe(401);
      const response = await api.GET(req(route, a.token)); expect(response.status).toBe(200);
      const body = JSON.stringify(await response.json()); expect(body).toContain(a.business.id); expect(body).not.toContain(b.business.id);
      expect(body).not.toContain("passwordHash"); expect(body).not.toContain("mfaSecret");
    });
  }
  itDb("agent edits snapshot prior configuration and reject cross-tenant modifications", async () => {
    const path = `agents/${a.agent.id}`;
    expect((await agentApi.GET(req(path, b.token), ctx(a.agent.id))).status).toBe(404);
    expect((await agentApi.PUT(req(path, b.token, "PUT", { name: "stolen" }), ctx(a.agent.id))).status).toBe(404);
    expect((await agentApi.PUT(req(path, a.token, "PUT", { configuration: { temperature: 99 } }), ctx(a.agent.id))).status).toBe(400);
    expect((await agentApi.PUT(req(path, a.token, "PUT", { name: "Updated Agent", configuration: { allowedTools: [], model: "configured-model", memoryEnabled: true } }), ctx(a.agent.id))).status).toBe(200);
    const history = await versions(req(`${path}/versions`, a.token), ctx(a.agent.id)); expect(history.status).toBe(200); expect(JSON.stringify(await history.json())).toContain("Test Agent");
    expect((await deactivate(req(`${path}/deactivate`, a.token, "POST", {}), ctx(a.agent.id))).status).toBe(200);
    expect((await activate(req(`${path}/activate`, a.token, "POST", {}), ctx(a.agent.id))).status).toBe(200);
    expect((await agentApi.DELETE(req(path, b.token, "DELETE"), ctx(a.agent.id))).status).toBe(404);
  });
  itDb("customer notes and history remain attached to the correct customer", async () => {
    expect((await customerApi.PUT(req(`customers/${a.customer.id}`, a.token, "PUT", { name: "Updated Customer", email: "updated@example.com" }), ctx(a.customer.id))).status).toBe(200);
    expect((await notes.POST(req(`leads/${a.lead.id}/notes`, a.token, "POST", { note: "Follow up next week" }), ctx(a.lead.id))).status).toBe(201);
    expect((await notes.GET(req(`leads/${a.lead.id}/notes`, b.token), ctx(a.lead.id))).status).toBe(404);
    const result = await notes.GET(req(`leads/${a.lead.id}/notes`, a.token), ctx(a.lead.id)); expect(JSON.stringify(await result.json())).toContain("Follow up next week");
    const history = await import("@/app/api/v1/customers/[id]/history/route");
    const response = await history.GET(req(`customers/${a.customer.id}/history`, a.token), ctx(a.customer.id)); expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).not.toContain(b.business.id);
  });
  itDb("feature disable takes effect after settings update and can be restored", async () => {
    const changed = await settings.PUT(req("business/settings", a.token, "PUT", { settings: { features: { crm: false } } })); expect(changed.status).toBe(200);
    expect((await customerApi.GET(req(`customers/${a.customer.id}`, a.token), ctx(a.customer.id))).status).toBe(403);
    expect((await settings.PUT(req("business/settings", a.token, "PUT", { settings: { features: { crm: true } } }))).status).toBe(200);
    expect((await settings.GET(req("business/settings", a.token))).status).toBe(200);
  });
  itDb("dead-letter retry rejects foreign and already-pending jobs", async () => {
    expect((await jobs.GET(req("automation/jobs", a.token))).status).toBe(200);
    expect((await jobs.POST(req("automation/jobs", b.token, "POST", { id: a.job.id }))).status).toBe(404);
    expect((await jobs.POST(req("automation/jobs", a.token, "POST", { id: a.job.id }))).status).toBe(200);
    expect((await jobs.POST(req("automation/jobs", a.token, "POST", { id: a.job.id }))).status).toBe(404);
  });
  itDb("knowledge updates require tenant ownership; malformed reindex never reindexes everything", async () => {
    const path = `knowledge/${a.document.id}`;
    expect((await documentApi.GET(req(path, b.token), ctx(a.document.id))).status).toBe(404);
    expect((await documentApi.PUT(req(path, b.token, "PUT", { title: "stolen" }), ctx(a.document.id))).status).toBe(404);
    expect((await documentApi.PUT(req(path, a.token, "PUT", { title: "Updated knowledge" }), ctx(a.document.id))).status).toBe(200);
    expect((await documentApi.GET(req(path, a.token), ctx(a.document.id))).status).toBe(200);
    expect((await reindex(req("knowledge/reindex", a.token, "POST", { documentId: "garbage" }))).status).toBe(400);
    expect((await documentApi.DELETE(req(path, b.token, "DELETE"), ctx(a.document.id))).status).toBe(404);
  });
  itDb("device management hides secrets, rejects foreign sessions and revokes access", async () => {
    const response = await sessions.GET(req("auth/sessions", a.token)); const data = await response.json(); expect(data.sessions.length).toBeGreaterThan(0); expect(JSON.stringify(data)).not.toContain("tokenHash");
    const sessionId = data.sessions[0].id;
    expect((await sessions.DELETE(req("auth/sessions", b.token, "DELETE", { sessionId }))).status).toBe(404);
    expect((await sessions.DELETE(req("auth/sessions", a.token, "DELETE", { sessionId }))).status).toBe(200);
    expect((await sessions.GET(req("auth/sessions", a.token))).status).toBe(401);
  });
});
