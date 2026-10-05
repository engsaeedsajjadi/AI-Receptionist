import { logWarn } from "@/lib/logger";
import { registerOutboxHandler, type OutboxDelivery } from "@/lib/services/outbox";
import { fanOutTenantEvent } from "@/lib/services/tenant-webhooks";

/**
 * Default outbox subscribers.
 *
 * The outbox itself owns delivery mechanics (lease, retry, dead-letter); these
 * handlers are the side effects that must happen once per delivered event:
 *  - tenant webhook fan-out for every topic in TENANT_WEBHOOK_TOPICS,
 *  - tenant notifications for lifecycle events that address a user,
 *  - export readiness notifications.
 *
 * Handlers are idempotent by construction: webhook deliveries are unique per
 * (endpoint, key) and notifications are unique per (tenant, idempotency key),
 * both enforced by unique indexes.
 */
let registered = false;

export function registerDefaultOutboxHandlers(): void {
  if (registered) return;
  registered = true;

  registerOutboxHandler("*", async (event: OutboxDelivery) => {
    const created = await fanOutTenantEvent({
      businessId: event.businessId,
      topic: event.topic,
      payload: event.payload,
      idempotencyKey: event.idempotencyKey,
    });
    if (created > 0) {
      logWarn("Outbox event fanned out to tenant webhooks", {
        businessId: event.businessId,
        operation: "outbox.webhook_fanout",
        status: "ok",
        eventCount: created,
      });
    }
  });

  registerOutboxHandler("notification.requested", async (event: OutboxDelivery) => {
    const { notify } = await import("@/lib/services/notifications");
    const payload = event.payload as {
      type?: string;
      title?: string;
      message?: string;
      userId?: string | null;
      channel?: "email" | "internal";
    };
    if (!payload.title || !payload.message) return;
    await notify({
      businessId: event.businessId,
      userId: payload.userId ?? null,
      type: payload.type ?? "system",
      title: payload.title,
      message: payload.message,
      channel: payload.channel,
      idempotencyKey: event.idempotencyKey,
    });
  });

  registerOutboxHandler("export.ready", async (event: OutboxDelivery) => {
    // The export worker already notifies the requester; the outbox event exists
    // so tenants can receive it over their own webhooks (fan-out above).
  });
}

/** Test helper: forget registrations so a suite can re-register cleanly. */
export function resetDefaultOutboxHandlers(): void {
  registered = false;
}
