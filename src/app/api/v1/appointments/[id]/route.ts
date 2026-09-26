import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { cancelAppointment, getAppointment, rescheduleAppointment } from "@/lib/services/appointments";
import { notifyAppointment } from "@/lib/services/notifications";
import { emitAutomationEvent } from "@/lib/services/n8n";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(400, "BAD_REQUEST", "Invalid appointment id");
    return ok(await getAppointment(auth.businessId, id));
  });
}

const rescheduleSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(10).max(480).optional(),
});

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async (rid) => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    const body = await parseJsonWith(req, rescheduleSchema);
    const created = await rescheduleAppointment(auth.businessId, id, body);
    await notifyAppointment({
      businessId: auth.businessId,
      appointmentId: created.id,
      scheduledAt: created.scheduledAt?.toISOString() ?? "",
      action: "changed",
      requestId: rid,
    });
    await emitAutomationEvent(
      "appointment",
      {
        id: created.id,
        businessId: auth.businessId,
        appointmentId: created.id,
        action: "rescheduled",
        scheduledAt: created.scheduledAt?.toISOString(),
      },
      { idempotencyKey: `appointment:${created.id}:rescheduled:${created.scheduledAt?.toISOString()}` },
    );
    return ok(created);
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async (rid) => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    const cancelled = await cancelAppointment(auth.businessId, id);
    await notifyAppointment({
      businessId: auth.businessId,
      appointmentId: cancelled.id,
      scheduledAt: cancelled.scheduledAt?.toISOString() ?? "",
      action: "cancelled",
      requestId: rid,
    });
    await emitAutomationEvent(
      "appointment",
      {
        id: cancelled.id,
        businessId: auth.businessId,
        appointmentId: cancelled.id,
        action: "cancelled",
      },
      { idempotencyKey: `appointment:${cancelled.id}:cancelled` },
    );
    return ok(cancelled);
  });
}
