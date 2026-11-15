#!/usr/bin/env node
/**
 * Staging release acceptance.
 *
 * It never claims third-party success. This verifies the deployed HTTP surface:
 * TLS, liveness/readiness, security headers, PWA assets, and (with a bearer
 * token) the authenticated provider-readiness contract.
 */
const base = (process.env.STAGING_BASE_URL ?? "").replace(/\/$/, "");
const token = process.env.STAGING_BEARER_TOKEN ?? "";
const allowNonStaging = process.env.STAGING_ALLOW_NON_STAGING === "1";

if (!base) {
  console.error("[staging] STAGING_BASE_URL is required");
  process.exit(2);
}

let origin;
try {
  origin = new URL(base);
} catch {
  console.error("[staging] STAGING_BASE_URL must be an absolute URL");
  process.exit(2);
}

const local = ["localhost", "127.0.0.1", "::1"].includes(origin.hostname);
const looksStaging = /(?:staging|stage|preview|test|dev)/i.test(origin.hostname);
if (!local && !looksStaging && !allowNonStaging) {
  console.error("[staging] refusing a host that is not visibly staging/test; set STAGING_ALLOW_NON_STAGING=1 only after review");
  process.exit(2);
}
if (!local && origin.protocol !== "https:") {
  console.error("[staging] remote acceptance requires HTTPS");
  process.exit(2);
}

const failures = [];
const evidence = [];

async function request(path, options = {}) {
  const res = await fetch(new URL(path, base), {
    redirect: "manual",
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  return res;
}

function check(condition, name, detail = "") {
  evidence.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures.push(name);
}

const live = await request("/api/health/live");
check(live.status === 200, "liveness", `HTTP ${live.status}`);

const ready = await request("/api/health/ready");
const readyBody = await ready.json().catch(() => ({}));
check(ready.status === 200 && readyBody.status === "ready", "readiness", `HTTP ${ready.status}`);

const home = await request("/");
check(home.status === 200, "public-home", `HTTP ${home.status}`);
const headers = Object.fromEntries(home.headers.entries());
check(Boolean(headers["content-security-policy"]), "csp");
check(Boolean(headers["strict-transport-security"]) || local, "hsts");
check(headers["x-content-type-options"] === "nosniff", "nosniff");
check(headers["x-frame-options"] === "DENY", "frame-deny");

const manifest = await request("/manifest.webmanifest");
const manifestBody = await manifest.json().catch(() => ({}));
check(manifest.status === 200 && manifestBody.display === "standalone", "pwa-manifest", `HTTP ${manifest.status}`);

const sw = await request("/sw.js");
const swText = await sw.text().catch(() => "");
check(sw.status === 200 && swText.includes('url.pathname.startsWith("/api/")'), "pwa-service-worker-no-api-cache");

if (token) {
  const readinessContract = await request("/api/v1/business/readiness");
  const body = await readinessContract.json().catch(() => ({}));
  check(readinessContract.status === 200, "authenticated-readiness", `HTTP ${readinessContract.status}`);
  check(body.capabilities?.tenantIsolation === true, "tenant-isolation-capability");
  evidence.push({
    name: "external-provider-configuration",
    ok: body.coreReady === true,
    detail: body.coreReady ? "core providers configured" : "one or more core providers not configured",
  });
} else {
  evidence.push({ name: "authenticated-readiness", ok: false, detail: "not run: STAGING_BEARER_TOKEN not supplied" });
}

console.log(JSON.stringify({ target: base, evidence, failures }, null, 2));
if (failures.length) {
  console.error(`[staging] FAIL: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("[staging] PASS: deploy surface is healthy; third-party live acceptance remains separate.");
