# Load testing

Two harnesses exist; neither is allowed to point at production by accident.

## 1 · Smoke harness (dependency-free, runnable anywhere)

```bash
# default: http://127.0.0.1:3100, /api/health/live,/api/health/ready, 10 VUs, 10s
npm run test:load

# explicit target/paths/budgets
LOAD_BASE_URL=http://127.0.0.1:3100 \
LOAD_PATHS=/api/health/live,/api/health/ready,/api/v1/leads \
LOAD_CONCURRENCY=20 LOAD_DURATION_SECONDS=20 LOAD_MAX_P95_MS=400 \
LOAD_BEARER_TOKEN=<access token for authenticated paths> \
npm run test:load
```

- Non-local targets are refused unless `LOAD_ALLOW_REMOTE=1` is set.
- Exit code is non-zero when the error rate (`LOAD_MAX_ERROR_RATE`, default 1%) or p95
  (`LOAD_MAX_P95_MS`, default 400 ms) exceeds budget, so it is usable as a gate.
- `429` responses are counted as **throttled**, not as server errors, and reported
  separately: they are the application's own rate limiter shedding load. `LOAD_MAX_THROTTLE_RATE`
  (default 1.0) fails the run when throttling becomes significant.
- Never run capacity measurements against `next dev`: the dev compiler throttles under load.
  Use `E2E_MODE=production` (a real `next start`) or a staging deployment.

Recorded local runs (2026-10-05, sandbox, 8 VUs):

| Target | Requests | Errors | Throttled | p50 | p95 | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/health/live` (dev, warm) | 1113 | 0.00% | 0.0% | 13 ms | ~50 ms | PASS |
| `/api/health/live`,`/api/health/ready` (dev, cold compile) | 1634 | 0.00% | 49.9% | 40 ms | 58 ms | PASS (throttle noted) |
| `/api/health/live`,`/dashboard/login` | 442 | 0.00% | 0.0% | 60 ms | 193 ms | PASS |

The cold-compile throttling above is a dev-server artifact; `/api/health/*` returned 200 for
100% of requests once compilation settled, so the liveness/readiness endpoints are safe for
probe traffic.

## 2 · k6 staging soak (thresholds from `docs/SLO.md`)

```bash
k6 run -e BASE_URL=https://staging.example.com -e TOKEN=<token> scripts/load/k6.js
```

Ramps to 25 VUs over 1 minute, holds for 3 minutes, then ramps down; thresholds are
`http_req_failed < 1%` and `p(95) < 400 ms`. Staging data only — the script is not part of CI
because it needs a deployment and a disposable tenant.

## Status

| Item | Status |
| --- | --- |
| Smoke harness implemented + executed locally | **PASS** |
| k6 soak script implemented | **PASS** |
| Staging soak executed against a deployed environment | **BLOCKED — staging environment required** |
| Multi-replica media/worker soak | **BLOCKED — staging environment required** |
