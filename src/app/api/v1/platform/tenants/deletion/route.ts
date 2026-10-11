import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import {
  cancelTenantDeletion,
  OffboardSchema,
  purgeTenant,
  requestTenantDeletion,
  tenantsDueForPurge,
} from "@/lib/services/data-governance";
import { requirePlatformAdmin } from "@/lib/services/platform";
import { db } from "@/db";

/**
 * Tenant offboarding state machine.
 *   POST   → request PENDING_DELETION (SUPER_ADMIN + MFA + reason + confirm)
 *   DELETE → cancel inside the grace window
 *   PUT    → purge after the grace window elapsed (irreversible, audited)
 */
export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    await requirePlatformAdmin(db, auth.userId);
    return ok({ due: await tenantsDueForPurge() });
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    // Authorization before request validation: a tenant administrator must get
    // 403 (never a validation error that leaks nothing but reads as "try again").
    await requirePlatformAdmin(db, auth.userId);
    const body = await parseJsonWith(req, OffboardSchema);
    return ok(await requestTenantDeletion(auth.userId, body), 201);
  });
}

export async function DELETE(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    await requirePlatformAdmin(db, auth.userId);
    const { businessId } = await parseJsonWith(req, z.object({ businessId: z.string().uuid() }).strict());
    return ok(await cancelTenantDeletion(auth.userId, businessId));
  });
}

export async function PUT(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    await requirePlatformAdmin(db, auth.userId);
    const body = await parseJsonWith(req, z.object({ businessId: z.string().uuid(), confirm: z.literal(true) }).strict());
    return ok(await purgeTenant(auth.userId, body));
  });
}
