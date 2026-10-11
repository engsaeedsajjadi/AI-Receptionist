/**
 * Tenant serving state.
 *
 * `businesses` carries two independent signals and both must be honoured:
 *   - `isActive` — the operational switch (platform suspend/reactivate, offboarding).
 *   - `status`   — the lifecycle state machine ACTIVE → SUSPENDED →
 *                  PENDING_DELETION → DELETED (`services/data-governance.ts`).
 *
 * A runtime gate that reads only one of them can keep answering calls for a
 * tenant that is on its way out, so every request-serving path (inbound voice
 * webhook, call admission, …) uses this predicate instead of a bare `isActive`
 * check. It fails closed: a tenant pending deletion or already deleted is never
 * "serving", whatever `isActive` happens to hold.
 */

export const NON_SERVING_STATES = ["PENDING_DELETION", "DELETED"] as const;

export type TenantServingInput = {
  isActive: boolean;
  status?: string | null;
};

export function tenantServingState(tenant: TenantServingInput): { serving: boolean; reason: string | null } {
  if (!tenant.isActive) return { serving: false, reason: "suspended" };
  const status = (tenant.status ?? "ACTIVE").toUpperCase();
  if ((NON_SERVING_STATES as readonly string[]).includes(status)) {
    return { serving: false, reason: status === "DELETED" ? "deleted" : "pending_deletion" };
  }
  return { serving: true, reason: null };
}

export function isTenantServing(tenant: TenantServingInput): boolean {
  return tenantServingState(tenant).serving;
}
