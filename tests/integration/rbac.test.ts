import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { closeDb } from "@/db";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createBusiness, createCall, createCustomer, createLead, createUser } from "../helpers/fixtures";
import { GET as listUsers, POST as createUserRoute } from "@/app/api/v1/users/route";
import { DELETE as deleteUser, PUT as updateUser } from "@/app/api/v1/users/[id]/route";
import { PUT as updateBusiness } from "@/app/api/v1/business/route";
import { POST as createAgent } from "@/app/api/v1/agents/route";
import { POST as createProperty } from "@/app/api/v1/properties/route";
import { POST as createLeadRoute } from "@/app/api/v1/leads/route";
import { DELETE as deleteLead, GET as getLead, PUT as updateLead } from "@/app/api/v1/leads/[id]/route";
import { POST as assignLead } from "@/app/api/v1/leads/[id]/assign/route";
import { GET as getCustomer } from "@/app/api/v1/customers/[id]/route";
import { GET as getCall } from "@/app/api/v1/calls/[id]/route";
import { POST as agentChat } from "@/app/api/v1/agent/chat/route";

const runIntegration = hasTestDatabase();
let ipOctet = 10;

function req(
  url: string,
  token: string,
  init?: { method?: string; body?: unknown; id?: string },
): { request: NextRequest; ctx: { params: Promise<{ id: string }> } } {
  const request = new NextRequest(
    new Request(url, {
      method: init?.method ?? "GET",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-real-ip": `198.51.100.${ipOctet++}`,
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
  );
  return { request, ctx: { params: Promise.resolve({ id: init?.id ?? "" }) } };
}

async function errCode(res: Response): Promise<{ status: number; code: string }> {
  const payload = await res.json();
  return { status: res.status, code: payload?.error?.code };
}

describe.skipIf(!runIntegration)("RBAC + tenant enforcement at the HTTP layer (real database)", () => {
  let bizA = "";
  let bizB = "";
  let adminA1 = "";
  let adminA2 = "";
  let managerA = "";
  let agentA = "";
  let adminB = "";
  let agentB = "";
  let leadA = "";
  let customerA = "";
  let callA = "";
  let tokens: Record<string, string> = {};

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    const { issueAuthTokens } = await import("@/lib/auth");
    bizA = (await createBusiness("RBAC A")).id;
    bizB = (await createBusiness("RBAC B")).id;
    adminA1 = (await createUser(bizA, "ADMIN")).user.id;
    adminA2 = (await createUser(bizA, "ADMIN")).user.id;
    managerA = (await createUser(bizA, "MANAGER")).user.id;
    agentA = (await createUser(bizA, "AGENT")).user.id;
    adminB = (await createUser(bizB, "ADMIN")).user.id;
    agentB = (await createUser(bizB, "AGENT")).user.id;
    for (const [key, userId, businessId, role] of [
      ["adminA1", adminA1, bizA, "ADMIN"],
      ["adminA2", adminA2, bizA, "ADMIN"],
      ["managerA", managerA, bizA, "MANAGER"],
      ["agentA", agentA, bizA, "AGENT"],
      ["adminB", adminB, bizB, "ADMIN"],
      ["agentB", agentB, bizB, "AGENT"],
    ] as const) {
      tokens[key] = (await issueAuthTokens({ userId, businessId, role })).accessToken;
    }
    const customer = await createCustomer(bizA, "09510000001");
    customerA = customer.id;
    leadA = (await createLead(bizA, customer.id)).id;
    callA = (await createCall(bizA, "09510000001")).id;
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  // -- AGENT is denied manager/admin operations -------------------------------
  itDb("AGENT cannot list or create users", async () => {
    const list = req("http://localhost/api/v1/users", tokens.agentA);
    expect(await errCode(await listUsers(list.request))).toEqual({ status: 403, code: "FORBIDDEN" });
    const create = req("http://localhost/api/v1/users", tokens.agentA, {
      method: "POST",
      body: { name: "X", email: "x@example.com", password: "Test1234!" },
    });
    expect(await errCode(await createUserRoute(create.request))).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  itDb("AGENT cannot update the business, agents, properties, or delete leads", async () => {
    const biz = req("http://localhost/api/v1/business", tokens.agentA, { method: "PUT", body: {} });
    expect(await errCode(await updateBusiness(biz.request))).toEqual({ status: 403, code: "FORBIDDEN" });
    const ag = req("http://localhost/api/v1/agents", tokens.agentA, { method: "POST", body: {} });
    expect(await errCode(await createAgent(ag.request))).toEqual({ status: 403, code: "FORBIDDEN" });
    const prop = req("http://localhost/api/v1/properties", tokens.agentA, { method: "POST", body: {} });
    expect(await errCode(await createProperty(prop.request))).toEqual({ status: 403, code: "FORBIDDEN" });
    const del = req(`http://localhost/api/v1/leads/${leadA}`, tokens.agentA, { method: "DELETE", id: leadA });
    expect(await errCode(await deleteLead(del.request, del.ctx))).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  itDb("AGENT cannot set assignedUserId via lead create/update (H4)", async () => {
    const create = req("http://localhost/api/v1/leads", tokens.agentA, {
      method: "POST",
      body: { phone: "09510000002", assignedUserId: agentA },
    });
    expect(await errCode(await createLeadRoute(create.request))).toEqual({ status: 403, code: "FORBIDDEN" });
    const update = req(`http://localhost/api/v1/leads/${leadA}`, tokens.agentA, {
      method: "PUT",
      id: leadA,
      body: { assignedUserId: agentA },
    });
    expect(await errCode(await updateLead(update.request, update.ctx))).toEqual({
      status: 403,
      code: "FORBIDDEN",
    });
  });

  itDb("AGENT can create unassigned leads and edit lead fields (control)", async () => {
    const create = req("http://localhost/api/v1/leads", tokens.agentA, {
      method: "POST",
      body: { phone: "09510000003", customerName: "مشتری" },
    });
    const created = await createLeadRoute(create.request);
    expect(created.status).toBe(201);
    expect((await created.json()).assignedUserId).toBeNull();
    const update = req(`http://localhost/api/v1/leads/${leadA}`, tokens.agentA, {
      method: "PUT",
      id: leadA,
      body: { notes: "یادداشت مامور" },
    });
    expect((await updateLead(update.request, update.ctx)).status).toBe(200);
  });

  // -- MANAGER boundaries ------------------------------------------------------
  itDb("MANAGER can create AGENTs but not MANAGERs; cannot touch business/agents", async () => {
    const okCreate = req("http://localhost/api/v1/users", tokens.managerA, {
      method: "POST",
      body: { name: "New Agent", email: "newagent@example.com", password: "Test1234!", role: "AGENT" },
    });
    expect((await createUserRoute(okCreate.request)).status).toBe(201);
    const badCreate = req("http://localhost/api/v1/users", tokens.managerA, {
      method: "POST",
      body: { name: "New Mgr", email: "newmgr@example.com", password: "Test1234!", role: "MANAGER" },
    });
    expect(await errCode(await createUserRoute(badCreate.request))).toEqual({
      status: 403,
      code: "FORBIDDEN",
    });
    const biz = req("http://localhost/api/v1/business", tokens.managerA, { method: "PUT", body: {} });
    expect(await errCode(await updateBusiness(biz.request))).toEqual({ status: 403, code: "FORBIDDEN" });
    const ag = req("http://localhost/api/v1/agents", tokens.managerA, { method: "POST", body: {} });
    expect(await errCode(await createAgent(ag.request))).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  itDb("assign validates the assignee: same-tenant 200, foreign 404, garbage 400 (H3)", async () => {
    const okAssign = req(`http://localhost/api/v1/leads/${leadA}/assign`, tokens.managerA, {
      method: "POST",
      id: leadA,
      body: { userId: agentA },
    });
    const okRes = await assignLead(okAssign.request, okAssign.ctx);
    expect(okRes.status).toBe(200);
    expect((await okRes.json()).assignedUserId).toBe(agentA);

    const foreign = req(`http://localhost/api/v1/leads/${leadA}/assign`, tokens.managerA, {
      method: "POST",
      id: leadA,
      body: { userId: agentB },
    });
    expect(await errCode(await assignLead(foreign.request, foreign.ctx))).toEqual({
      status: 404,
      code: "USER_NOT_FOUND",
    });

    const garbage = req(`http://localhost/api/v1/leads/${leadA}/assign`, tokens.managerA, {
      method: "POST",
      id: leadA,
      body: { userId: "not-a-uuid" },
    });
    expect((await assignLead(garbage.request, garbage.ctx)).status).toBe(400);

    const ghost = req(`http://localhost/api/v1/leads/${leadA}/assign`, tokens.managerA, {
      method: "POST",
      id: leadA,
      body: { userId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(await errCode(await assignLead(ghost.request, ghost.ctx))).toEqual({
      status: 404,
      code: "USER_NOT_FOUND",
    });
  });

  itDb("lead update validates assignee tenancy for MANAGER too (H3)", async () => {
    const update = req(`http://localhost/api/v1/leads/${leadA}`, tokens.managerA, {
      method: "PUT",
      id: leadA,
      body: { assignedUserId: agentB },
    });
    expect(await errCode(await updateLead(update.request, update.ctx))).toEqual({
      status: 404,
      code: "USER_NOT_FOUND",
    });
  });

  // -- Cross-tenant reads 404 --------------------------------------------------
  itDb("tenant B cannot read tenant A records over HTTP", async () => {
    const lead = req(`http://localhost/api/v1/leads/${leadA}`, tokens.agentB, { id: leadA });
    expect(await errCode(await getLead(lead.request, lead.ctx))).toEqual({ status: 404, code: "LEAD_NOT_FOUND" });
    const customer = req(`http://localhost/api/v1/customers/${customerA}`, tokens.agentB, { id: customerA });
    expect(await errCode(await getCustomer(customer.request, customer.ctx))).toEqual({
      status: 404,
      code: "CUSTOMER_NOT_FOUND",
    });
    const call = req(`http://localhost/api/v1/calls/${callA}`, tokens.agentB, { id: callA });
    const callErr = await errCode(await getCall(call.request, call.ctx));
    expect(callErr.status).toBe(404);
  });

  itDb("agent/chat with a foreign callId 404s before any LLM work (H1)", async () => {
    const chat = req("http://localhost/api/v1/agent/chat", tokens.agentB, {
      method: "POST",
      body: { message: "سلام", callId: callA },
    });
    expect(await errCode(await agentChat(chat.request))).toEqual({ status: 404, code: "CALL_NOT_FOUND" });
  });

  // -- Last-admin protection (state-changing: runs last) -----------------------
  itDb("sole ADMIN cannot demote themselves; second admin can be demoted (H5)", async () => {
    const selfDemote = req(`http://localhost/api/v1/users/${adminB}`, tokens.adminB, {
      method: "PUT",
      id: adminB,
      body: { role: "AGENT" },
    });
    expect((await updateUser(selfDemote.request, selfDemote.ctx)).status).toBe(400);

    const demoteOther = req(`http://localhost/api/v1/users/${adminA2}`, tokens.adminA1, {
      method: "PUT",
      id: adminA2,
      body: { role: "AGENT" },
    });
    const demoted = await updateUser(demoteOther.request, demoteOther.ctx);
    expect(demoted.status).toBe(200);
    expect((await demoted.json()).role).toBe("AGENT");
  });

  itDb("ADMIN cannot delete their own account (control)", async () => {
    const del = req(`http://localhost/api/v1/users/${adminA1}`, tokens.adminA1, {
      method: "DELETE",
      id: adminA1,
    });
    expect((await deleteUser(del.request, del.ctx)).status).toBe(400);
  });
});
