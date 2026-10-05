import { afterAll, beforeAll, describe, expect } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { businesses, users } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { dialedNumberCandidates } from "@/lib/normalization";
import { PUT as businessPut } from "@/app/api/v1/business/route";
import { changePlatformTenantState } from "@/lib/services/platform";
import { cancelTenantDeletion, requestTenantDeletion } from "@/lib/services/data-governance";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * Phone-based tenant routing is the one place where a mistake sends a real
 * customer's call to the wrong business, and the lifecycle switch is the one
 * place where a mistake wakes up a tenant that is being deleted. Both are
 * covered here: canonical storage of the number, a 409 on a claimed number, the
 * national/E.164 candidates used for lookup, and a suspend switch that stays
 * inside the offboarding state machine.
 */

let ipSeq = 0;
function put(body: unknown, token: string) {
  return new NextRequest("http://localhost/api/v1/business", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-real-ip": `10.13.${(ipSeq >> 8) % 250}.${(ipSeq++ % 250) + 1}`,
    },
    body: JSON.stringify(body),
  });
}

async function tenantAdmin(businessId: string) {
  const { user } = await createUser(businessId, "ADMIN");
  const token = (await issueAuthTokens({ userId: user.id, businessId, role: "ADMIN" })).accessToken;
  return { user, token };
}

async function platformAdmin() {
  const platform = await createBusiness(`Platform ${crypto.randomUUID().slice(0, 8)}`);
  const { user } = await createUser(platform.id, "ADMIN");
  await db.update(users).set({ role: "SUPER_ADMIN", mfaEnabled: true }).where(eq(users.id, user.id));
  return { platform, user };
}

describe.skipIf(!hasTestDatabase())("tenant phone routing and lifecycle switch", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  itDb("stores a dialled number in one canonical form and rejects unusable input", async () => {
    const tenant = await createBusiness(`Phone ${crypto.randomUUID().slice(0, 8)}`);
    const { token } = await tenantAdmin(tenant.id);

    // E.164 typed by an operator is stored nationally, so the inbound resolver
    // can match either spelling of the same number.
    const stored = await businessPut(put({ phone: "+982188776655" }, token));
    expect(stored.status).toBe(200);
    expect(((await stored.json()) as { phone: string }).phone).toBe("02188776655");

    const spaced = await businessPut(put({ phone: "۰۲۱ ۸۸۷۷ ۶۶۵۵" }, token));
    expect(spaced.status).toBe(200);
    expect(((await spaced.json()) as { phone: string }).phone).toBe("02188776655");

    const invalid = await businessPut(put({ phone: "not-a-phone" }, token));
    expect(invalid.status).toBe(400);
    // The stored value is untouched by the rejected update.
    const [row] = await db.select().from(businesses).where(eq(businesses.id, tenant.id));
    expect(row.phone).toBe("02188776655");
  });

  itDb("refuses a number another tenant already answers on", async () => {
    const first = await createBusiness(`Owner ${crypto.randomUUID().slice(0, 8)}`);
    const second = await createBusiness(`Claimer ${crypto.randomUUID().slice(0, 8)}`);
    const firstAdmin = await tenantAdmin(first.id);
    const secondAdmin = await tenantAdmin(second.id);
    expect((await businessPut(put({ phone: "02188776600" }, firstAdmin.token))).status).toBe(200);

    const clash = await businessPut(put({ phone: "+982188776600" }, secondAdmin.token));
    expect(clash.status).toBe(409);
    expect(JSON.stringify(await clash.json())).toContain("PHONE_TAKEN");

    // The original owner keeps the number, and nobody else is reachable on it.
    const owners = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.phone, "02188776600"));
    expect(owners.map((row) => row.id)).toEqual([first.id]);
  });

  itDb("looks up the plausible storage forms of one number and nothing else", () => {
    const e164 = dialedNumberCandidates("+982188776655");
    expect(e164).toContain("02188776655");
    expect(e164).toContain("+982188776655");
    const national = dialedNumberCandidates("02188776655");
    expect(national).toEqual(expect.arrayContaining(["02188776655", "+982188776655"]));
    // A different number never appears as a candidate for this one.
    expect(e164).not.toContain("02188776656");
    expect(dialedNumberCandidates("")).toEqual([]);
    expect(dialedNumberCandidates(null)).toEqual([]);
  });

  itDb("keeps the suspend switch inside the offboarding state machine", async () => {
    const { user: platformUser } = await platformAdmin();
    const tenant = await createBusiness(`Lifecycle ${crypto.randomUUID().slice(0, 8)}`);

    // Suspend: the operational flag and the lifecycle status move together.
    await changePlatformTenantState(platformUser.id, { id: tenant.id, isActive: false, reason: "Customer requested suspension" });
    let [row] = await db.select().from(businesses).where(eq(businesses.id, tenant.id));
    expect(row.isActive).toBe(false);
    expect(row.status).toBe("SUSPENDED");

    // Reactivate: back to ACTIVE, not to a half-state.
    await changePlatformTenantState(platformUser.id, { id: tenant.id, isActive: true, reason: "Customer resumed the account" });
    [row] = await db.select().from(businesses).where(eq(businesses.id, tenant.id));
    expect(row.isActive).toBe(true);
    expect(row.status).toBe("ACTIVE");

    // Pending deletion is not a state the suspend switch may undo: the grace
    // window would be meaningless if it could.
    await requestTenantDeletion(platformUser.id, { businessId: tenant.id, reason: "Customer requested offboarding", confirm: true });
    [row] = await db.select().from(businesses).where(eq(businesses.id, tenant.id));
    expect(row.status).toBe("PENDING_DELETION");
    expect(row.isActive).toBe(false);
    await expect(
      changePlatformTenantState(platformUser.id, { id: tenant.id, isActive: true, reason: "Operator tried to switch it back on" }),
    ).rejects.toMatchObject({ status: 409 });

    // The documented path cancels the deletion and leaves the tenant off.
    await cancelTenantDeletion(platformUser.id, tenant.id);
    [row] = await db.select().from(businesses).where(eq(businesses.id, tenant.id));
    expect(row.status).toBe("SUSPENDED");
    expect(row.isActive).toBe(false);

    // And a suspended tenant can be resumed again through the switch.
    await changePlatformTenantState(platformUser.id, { id: tenant.id, isActive: true, reason: "Resumed after cancellation" });
    [row] = await db.select().from(businesses).where(eq(businesses.id, tenant.id));
    expect(row.status).toBe("ACTIVE");
    expect(row.isActive).toBe(true);

    // A deleted tenant can never be woken up.
    await db.update(businesses).set({ status: "DELETED", isActive: false }).where(eq(businesses.id, tenant.id));
    await expect(
      changePlatformTenantState(platformUser.id, { id: tenant.id, isActive: true, reason: "Operator tried to resurrect it" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
