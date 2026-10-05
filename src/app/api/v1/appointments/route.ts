import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { appointments } from "@/db/schema";
import { ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { checkAvailability, createAppointment } from "@/lib/services/appointments";
import { notifyAppointment } from "@/lib/services/notifications";
import { emitAutomationEvent } from "@/lib/services/n8n";
import { cursorPage, keysetCondition, parseListWindow } from "@/lib/pagination";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);

    // Availability query mode: ?date=YYYY-MM-DD[&durationMinutes=..][&assignedUserId=..]
    const date = req.nextUrl.searchParams.get("date");
    if (date) {
      const durationMinutes = req.nextUrl.searchParams.get("durationMinutes");
      const assignedUserId = req.nextUrl.searchParams.get("assignedUserId") ?? undefined;
      return ok(
        await checkAvailability({
          businessId: auth.businessId,
          date,
          durationMinutes: durationMinutes ? Number(durationMinutes) : undefined,
          assignedUserId: assignedUserId ?? undefined,
        }),
      );
    }

    const listWindow = parseListWindow(req);
    const conditions = [eq(appointments.businessId, auth.businessId)];
    const status = req.nextUrl.searchParams.get("status");
    if (status) conditions.push(eq(appointments.status, status as never));

    if (listWindow.cursor) {
      conditions.push(keysetCondition({ createdAt: appointments.createdAt, id: appointments.id }, listWindow.cursor));
    }

    const [rows, total] = await Promise.all([
      db
        .select()
        .from(appointments)
        .where(and(...conditions))
        // (created_at, id) is the total order the cursor is derived from; the
        // scheduled_at ordering stays the primary presentation order when no
        // cursor is supplied.
        .orderBy(desc(appointments.createdAt), desc(appointments.id))
        .limit(listWindow.cursor ? listWindow.limit + 1 : listWindow.limit)
        .offset(listWindow.cursor ? 0 : listWindow.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(appointments)
        .where(and(...conditions))
        .then((r) => r[0]?.count ?? 0),
    ]);

    return ok(cursorPage({ rows, limit: listWindow.limit, page: listWindow.page, extra: Boolean(listWindow.cursor), total }));
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const body = await parseJson<Record<string, unknown>>(req);

    const created = await createAppointment(auth.businessId, body, { requestId: rid });

    await notifyAppointment({
      businessId: auth.businessId,
      appointmentId: created.id,
      scheduledAt: created.scheduledAt?.toISOString() ?? "",
      action: "created",
      requestId: rid,
    });
    await emitAutomationEvent(
      "appointment",
      {
        id: created.id,
        businessId: auth.businessId,
        appointmentId: created.id,
        action: "created",
        scheduledAt: created.scheduledAt?.toISOString(),
        leadId: created.leadId,
      },
      { idempotencyKey: `appointment:${created.id}:created` },
    );

    return ok(created, 201);
  });
}
