import { NextRequest } from "next/server";
import { safeEqual } from "@/lib/security";
import { metrics } from "@/lib/telemetry";
export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  const secret = process.env.METRICS_TOKEN;
  if (!secret || !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`))
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  const registry = metrics().registry;
  return new Response(await registry.metrics(), { headers: { "Content-Type": registry.contentType, "Cache-Control": "no-store" } });
}
