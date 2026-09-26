import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { properties } from "@/db/schema";
import { ApiError, ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { getProperty, updateProperty } from "@/lib/services/properties";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(400, "BAD_REQUEST", "Invalid property id");
    return ok(await getProperty(auth.businessId, id));
  });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const { id } = await ctx.params;
    const body = await parseJson<Record<string, unknown>>(req);
    return ok(await updateProperty(auth.businessId, id, body));
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const { id } = await ctx.params;
    const deleted = await db
      .delete(properties)
      .where(and(eq(properties.id, id), eq(properties.businessId, auth.businessId)))
      .returning({ id: properties.id });
    if (!deleted.length) throw new ApiError(404, "PROPERTY_NOT_FOUND", "Property not found");
    return ok({ ok: true });
  });
}
