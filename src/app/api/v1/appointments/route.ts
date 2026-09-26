import { desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { appointments } from "@/db/schema";
import { ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.businessId, auth.businessId))
      .orderBy(desc(appointments.createdAt));

    return ok(rows);
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);

    const body = await parseJson<{
      leadId?: string;
      assignedUserId?: string;
      scheduledAt: string;
      durationMinutes?: number;
      notes?: string;
    }>(req);

    const [created] = await db
      .insert(appointments)
      .values({
        businessId: auth.businessId,
        leadId: body.leadId ?? null,
        assignedUserId: body.assignedUserId ?? null,
        scheduledAt: new Date(body.scheduledAt),
        durationMinutes: body.durationMinutes ?? 30,
        status: "SCHEDULED",
        notes: body.notes ? normalizePersianText(body.notes) : null,
      })
      .returning();

    return ok(created, 201);
  });
}
