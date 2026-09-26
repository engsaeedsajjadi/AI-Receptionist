/**
 * Shared HTTP-test helpers.
 *
 * Rate-limit bucket convention (TRUST_PROXY=false in tests, so the limiter
 * reads `x-real-ip` directly). Buckets are per (preset, ip, 60s-window) in a
 * Redis shared by every test file AND every consecutive local run — a fixed
 * IP reused across files (or hammered 61x by rate-limits.test.ts) makes
 * other files flake with 429 depending on timing. Keep the blocks disjoint:
 *
 * - 198.51.100.0/24 (TEST-NET-2): rbac.test.ts sequential client IPs only.
 * - 203.0.113.0/24 (TEST-NET-3): fixed-bucket tests (rate-limits, auth
 *   lockout/register, maintenance). Never use these octets elsewhere.
 * - 192.0.2.0/24 (TEST-NET-1): everything else — use uniqueTestIp() so each
 *   request lands in its own bucket and consecutive runs never accumulate.
 */

// Random base per worker + monotonic counter: unique within a run, and
// consecutive runs start at different offsets (no cross-run accumulation).
const base = Math.floor(Math.random() * 200);
let seq = 0;

/** A fresh TEST-NET-1 client IP for one test request. */
export function uniqueTestIp(): string {
  const octet = ((base + seq++) % 200) + 1;
  return `192.0.2.${octet}`;
}
