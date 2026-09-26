import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { automationDispatches, notifications } from "@/db/schema";
import { resetEnvCache } from "@/lib/env";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createBusiness } from "../helpers/fixtures";
import { POST as dispatch } from "@/app/api/v1/automation/dispatch/route";

const runIntegration = hasTestDatabase();
let savedApiKey: string | undefined;

function dispatchRequest(body: unknown, apiKey?: string): NextRequest {
  return new NextRequest(
    new Request("http://localhost/api/v1/automation/dispatch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

describe.skipIf(!runIntegration)("automation dispatch (real database)", () => {
  let businessId: string;

  beforeAll(async () => {
    savedApiKey = process.env.N8N_API_KEY;
    process.env.N8N_API_KEY = "test-automation-key";
    resetEnvCache();
    if (!(await ensureDbReady())) return;
    await truncateAll();
    businessId = (await createBusiness("Dispatch Biz")).id;
  });

  afterAll(async () => {
    if (savedApiKey === undefined) delete process.env.N8N_API_KEY;
    else process.env.N8N_API_KEY = savedApiKey;
    resetEnvCache();
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  itDb("dispatches once and records the honest outcome", async () => {
    const { dispatchAutomationEvent } = await import("@/lib/services/notifications");
    const key = `emit-${Date.now()}`;
    const result = await dispatchAutomationEvent({
      businessId,
      event: "new-lead",
      channel: "email",
      recipient: "ops@example.com",
      title: "New lead",
      message: "Lead L1",
      idempotencyKey: key,
    });
    // No SMTP in tests: the attempt is real, the failure is recorded.
    expect(result).toMatchObject({ duplicate: false, delivered: false, status: "FAILED" });
    const [row] = await db
      .select()
      .from(automationDispatches)
      .where(eq(automationDispatches.id, result.id))
      .limit(1);
    expect(row.attempts).toBe(1);
    expect(row.errorMessage).toBe("delivery_failed");
    expect(row.notificationId).toBeTruthy();
    const [notif] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, row.notificationId!))
      .limit(1);
    expect(notif.status).toBe("FAILED");
    expect(notif.type).toBe("automation:new-lead");
  });

  itDb("concurrent same-key dispatches collapse to one notification", async () => {
    const { dispatchAutomationEvent } = await import("@/lib/services/notifications");
    const key = `race-${Date.now()}`;
    const input = {
      businessId,
      event: "new-lead",
      channel: "email" as const,
      recipient: "ops@example.com",
      title: "Race",
      message: "M",
      idempotencyKey: key,
    };
    const [a, b] = await Promise.all([dispatchAutomationEvent(input), dispatchAutomationEvent(input)]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(a.id).toBe(b.id);
    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.businessId, businessId),
          eq(notifications.idempotencyKey, `dispatch:${key}`),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  itDb("unknown business is 404", async () => {
    const { dispatchAutomationEvent } = await import("@/lib/services/notifications");
    await expect(
      dispatchAutomationEvent({
        businessId: "00000000-0000-0000-0000-000000000000",
        event: "new-lead",
        channel: "email",
        recipient: "ops@example.com",
        message: "M",
        idempotencyKey: `nope-${Date.now()}`,
      }),
    ).rejects.toMatchObject({ status: 404, code: "BUSINESS_NOT_FOUND" });
  });

  itDb("route rejects missing and wrong credentials", async () => {
    const body = {
      businessId,
      event: "new-lead",
      channel: "email",
      recipient: "ops@example.com",
      message: "M",
      idempotencyKey: `auth-${Date.now()}`,
    };
    const missing = await dispatch(dispatchRequest(body));
    expect(missing.status).toBe(401);
    const wrong = await dispatch(dispatchRequest(body, "wrong-key"));
    expect(wrong.status).toBe(401);
    const payload = await wrong.json();
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe("UNAUTHORIZED");
  });

  itDb("route dispatches with valid credentials", async () => {
    const res = await dispatch(
      dispatchRequest(
        {
          businessId,
          event: "new-lead",
          channel: "email",
          recipient: "ops@example.com",
          title: "Lead",
          message: "Lead L2",
          idempotencyKey: `route-${Date.now()}`,
        },
        "test-automation-key",
      ),
    );
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toMatchObject({ duplicate: false, delivered: false, status: "FAILED" });
  });

  itDb("route is 503 when N8N_API_KEY is unconfigured", async () => {
    process.env.N8N_API_KEY = "";
    resetEnvCache();
    try {
      const res = await dispatch(
        dispatchRequest(
          {
            businessId,
            event: "new-lead",
            channel: "email",
            recipient: "ops@example.com",
            message: "M",
            idempotencyKey: `unconf-${Date.now()}`,
          },
          "test-automation-key",
        ),
      );
      expect(res.status).toBe(503);
    } finally {
      process.env.N8N_API_KEY = "test-automation-key";
      resetEnvCache();
    }
  });
});
