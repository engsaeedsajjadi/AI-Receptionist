import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/metrics/route";
import { withApiHandling } from "@/lib/server-core";
import { AppError } from "@/lib/errors";
describe("operational telemetry", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("keeps metrics private and exports real success/error counters", async () => {
    vi.stubEnv("METRICS_TOKEN", "test-metrics-secret");
    expect((await GET(new NextRequest("http://localhost/api/metrics"))).status).toBe(401);
    const response = await withApiHandling(async () => Response.json({ ok: true }));
    expect(response.headers.get("x-trace-id")).toMatch(/^[a-f0-9]{32}$/);
    await withApiHandling(async () => { throw new AppError(503, "DEPENDENCY_UNAVAILABLE", "test failure"); });
    const result = await GET(new NextRequest("http://localhost/api/metrics", { headers: { authorization: "Bearer test-metrics-secret" } }));
    expect(result.status).toBe(200);
    const output = await result.text();
    expect(output).toContain('receptionist_api_requests_total{status_class="2xx"}');
    expect(output).toContain('receptionist_api_requests_total{status_class="5xx"}');
    expect(output).toContain("receptionist_api_duration_seconds_bucket");
    expect(output).not.toContain("test-metrics-secret");
  });
});
