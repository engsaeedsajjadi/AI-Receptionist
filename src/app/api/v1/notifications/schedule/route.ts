import { and, desc, eq, gt } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { outboxEvents } from "@/db/schema";
import { AppError, ok, parseJsonWith } from "@/lib/api";
import { assertUserInBusiness, getAuthContext } from "@/lib/auth";
import { enqueueOutbox } from "@/lib/services/outbox";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

const channelSchema = z.enum(["internal", "email", "sms", "telegram", "whatsapp"]);

const scheduleSchema = z.object({
  scheduledAt: z.string().datetime(),
  type: z.string().trim().min(1).max(50).default("scheduled"),
  channel: channelSchema.default("internal"),
  recipient: z.string().trim().min(1).max(255).optional(),
  title: z.string().trim().min(1).max(255),
  message: z.string().trim().min(1).max(4000),
  userId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(8).max(180).optional(),
}).strict();

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const rows = await db
      .select({
        id: outboxEvents.id,
        status: outboxEvents.status,
        availableAt: outboxEvents.availableAt,
        payload: outboxEvents.payload,
        createdAt: outboxEvents.createdAt,
      })
      .from(outboxEvents)
      .where(and(
        eq(outboxEvents.businessId, auth.businessId),
        eq(outboxEvents.topic, "notification.requested"),
        gt(outboxEvents.availableAt, new Date()),
      ))
      .orderBy(desc(outboxEvents.availableAt))
      .limit(100);

    return ok({ scheduled: rows });
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const body = await parseJsonWith(req, scheduleSchema);
    const scheduledAt = new Date(body.scheduledAt);
    const now = Date.now();

    if (scheduledAt.getTime() < now + 5_000) {
      throw new AppError(400, "VALIDATION_ERROR", "scheduledAt must be at least 5 seconds in the future");
    }
    if (scheduledAt.getTime() > now + 365 * 24 * 60 * 60 * 1000) {
      throw new AppError(400, "VALIDATION_ERROR", "scheduledAt cannot be more than 365 days in the future");
    }
    if (body.channel !== "internal" && !body.recipient) {
      throw new AppError(400, "VALIDATION_ERROR", "recipient is required for external notification channels");
    }
    if (body.userId) await assertUserInBusiness(auth.businessId, body.userId);

    const logicalKey = body.idempotencyKey ?? crypto.randomUUID();
    const created = await db.transaction((tx) =>
      enqueueOutbox(tx, {
        businessId: auth.businessId,
        topic: "notification.requested",
        idempotencyKey: `scheduled-notification:${logicalKey}`,
        availableAt: scheduledAt,
        payload: {
          businessId: auth.businessId,
          userId: body.userId ?? null,
          type: body.type,
          channel: body.channel,
          recipient: body.recipient ?? null,
          title: body.title,
          message: body.message,
          scheduledAt: scheduledAt.toISOString(),
        },
      }),
    );

    return ok(
      {
        id: created?.id ?? null,
        duplicate: created === null,
        scheduledAt: scheduledAt.toISOString(),
      },
      created ? 201 : 200,
    );
  });
}
