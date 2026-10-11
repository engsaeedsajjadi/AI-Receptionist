#!/usr/bin/env node
/**
 * Dependency-free load smoke test.
 *
 * Usage:
 *   node scripts/load/smoke.mjs                       # local defaults
 *   LOAD_BASE_URL=http://127.0.0.1:3100 \
 *   LOAD_PATHS=/api/health/live,/api/health/ready \
 *   LOAD_CONCURRENCY=20 LOAD_DURATION_SECONDS=15 \
 *   node scripts/load/smoke.mjs
 *
 * Safety: refuses to target anything that is not obviously local (127.0.0.1,
 * localhost, *.local) unless LOAD_ALLOW_REMOTE=1 is set, so a smoke run can
 * never accidentally hammer production.
 *
 * Exit code is non-zero when the error rate or p95 latency exceeds the budget,
 * so the harness is usable as a CI/staging gate rather than a report generator.
 */

const baseUrl = process.env.LOAD_BASE_URL ?? "http://127.0.0.1:3100";
const paths = (process.env.LOAD_PATHS ?? "/api/health/live,/api/health/ready").split(",").map((p) => p.trim()).filter(Boolean);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 10);
const durationSeconds = Number(process.env.LOAD_DURATION_SECONDS ?? 10);
const maxErrorRate = Number(process.env.LOAD_MAX_ERROR_RATE ?? 0.01);
const maxThrottleRate = Number(process.env.LOAD_MAX_THROTTLE_RATE ?? 1);
const maxP95Ms = Number(process.env.LOAD_MAX_P95_MS ?? 400);
const token = process.env.LOAD_BEARER_TOKEN ?? "";

const LOCAL = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]|[\w.-]+\.local)(:\d+)?(\/|$)/i;
if (!LOCAL.test(baseUrl) && process.env.LOAD_ALLOW_REMOTE !== "1") {
  console.error(`[load] refusing to run against non-local target ${baseUrl} (set LOAD_ALLOW_REMOTE=1 to override)`);
  process.exit(2);
}
if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 500) {
  console.error("[load] LOAD_CONCURRENCY must be between 1 and 500");
  process.exit(2);
}
if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 600) {
  console.error("[load] LOAD_DURATION_SECONDS must be between 1 and 600");
  process.exit(2);
}

const latencies = [];
let ok = 0;
let throttled = 0;
let errors = 0;
let statusCounts = {};
const stopAt = Date.now() + durationSeconds * 1000;

function percentiles(values) {
  if (!values.length) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

async function worker() {
  while (Date.now() < stopAt) {
    for (const path of paths) {
      if (Date.now() >= stopAt) return;
      const started = performance.now();
      try {
        const res = await fetch(new URL(path, baseUrl), {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const elapsed = performance.now() - started;
        latencies.push(elapsed);
        statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
        // 2xx/3xx are healthy; 401/403 on a protected path is an expected
        // response when no token is supplied; 429 is the app's own rate limiter
        // shedding load (reported separately, not a server error).
        if (res.status < 400 || res.status === 401 || res.status === 403) ok += 1;
        else if (res.status === 429) throttled += 1;
        else errors += 1;
        await res.arrayBuffer().catch(() => undefined);
      } catch {
        const elapsed = performance.now() - started;
        latencies.push(elapsed);
        statusCounts.network_error = (statusCounts.network_error ?? 0) + 1;
        errors += 1;
      }
    }
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const wallSeconds = (Date.now() - started) / 1000;
const total = ok + throttled + errors;
const errorRate = total ? errors / total : 1;
const throttleRate = total ? throttled / total : 0;
const { p50, p95, p99 } = percentiles(latencies);
const rps = total / wallSeconds;

console.log(
  JSON.stringify(
    {
      target: baseUrl,
      paths,
      concurrency,
      durationSeconds,
      requests: total,
      ok,
      throttled,
      errors,
      errorRate: Number(errorRate.toFixed(4)),
      throttleRate: Number(throttleRate.toFixed(4)),
      rps: Number(rps.toFixed(1)),
      latencyMs: { p50: Number(p50.toFixed(1)), p95: Number(p95.toFixed(1)), p99: Number(p99.toFixed(1)) },
      statusCounts,
      budgets: { maxErrorRate, maxThrottleRate, maxP95Ms },
    },
    null,
    2,
  ),
);

if (errorRate > maxErrorRate) {
  console.error(`[load] FAIL: error rate ${(errorRate * 100).toFixed(2)}% exceeds ${(maxErrorRate * 100).toFixed(2)}%`);
  process.exit(1);
}
if (throttleRate > maxThrottleRate) {
  console.error(
    `[load] FAIL: ${(throttleRate * 100).toFixed(2)}% of requests were throttled (429) — raise LOAD_MAX_THROTTLE_RATE deliberately or reduce load`,
  );
  process.exit(1);
}
if (p95 > maxP95Ms) {
  console.error(`[load] FAIL: p95 ${p95.toFixed(0)}ms exceeds ${maxP95Ms}ms budget`);
  process.exit(1);
}
console.log(
  `[load] PASS: ${total} requests, ${(errorRate * 100).toFixed(2)}% errors, ${(throttleRate * 100).toFixed(1)}% throttled, p95 ${p95.toFixed(0)}ms`,
);
