# Service level objectives (SLOs)

Status: **objectives defined and instrumented; not yet evidenced in production**. Nothing in
this document is an SLA. A target becomes an SLA only after a stable production baseline
exists; until then the tables below are internal objectives used for alerting.

## Availability and correctness

| Objective | Target (30-day rolling) | Measurement | Alert |
| --- | --- | --- | --- |
| Dashboard/API availability | 99.5% of non-5xx responses | Prometheus request counter at `/api/metrics` (token-protected) | `ApiAvailabilityLow` — burn rate > 2% over 1 h |
| Call admission success | 99% of inbound calls get a media session (excluding caller hangs up within 3 s) | `call_admission` telemetry + media-server capacity closes | `MediaCapacity` — close code 4429 observed |
| Readiness truthfulness | `/api/health/ready` returns 503 whenever any dependency (DB, Redis, migrations, providers) is unhealthy | readiness endpoint | `ReadyProbeFailing` |
| Data durability | RPO ≤ 24 h (daily dump), RTO ≤ 60 min | restore drill (see `docs/DISASTER-RECOVERY.md`) | weekly drill failure |

## Latency

| Path | Target | Notes |
| --- | --- | --- |
| API p95 (dashboard reads) | ≤ 400 ms | measured from request telemetry; excludes LLM calls |
| API p99 (writes) | ≤ 1.5 s | includes outbox insert, excludes provider I/O |
| Agent turn first token | ≤ 1.5 s p95 | live provider only; excluded from dev/test |
| Tool call round trip | ≤ 2.5 s p95 | bounded by provider timeout settings |
| Media websocket frame latency | ≤ 250 ms p95 | process-local measurement |

## Provider dependencies

| Dependency | Budget | Degradation policy |
| --- | --- | --- |
| LLM | ≤ 1% turn failures | retry once, then hand off to a human with an honest failure event |
| STT/TTS | ≤ 1% utterance failures | failed turn returns the caller to LISTENING (never silent) |
| Payment provider | ≤ 0.5% webhook processing failures | retry with backoff, dead-letter after 8 attempts, never fake a success |
| SMTP | ≤ 2% delivery failures | queued as `notification.requested` outbox events; delivery status visible to the tenant |
| Object storage | ≤ 0.5% operation failures | upload/download errors surface as 502 `STORAGE_ERROR`, never as success |

## Operational hygiene

- Quota state is reconciled by `npm run maintenance` (reservations, meters, storage usage) —
  drift must return to zero and is reported as a metric, never silently adjusted.
- Retention jobs must complete daily; the maintenance report records failures.
- Backup/restore drill runs weekly against an isolated database.
- Load smoke (`npm run test:load`, budget-enforcing) runs against staging before a release;
  see `docs/LOAD-TESTING.md` for the k6 soak and the recorded local baselines.
- Alert rules and Grafana provisioning are documented in `docs/ENTERPRISE-DEPLOYMENT.md`; the
  production telemetry endpoint remains **BLOCKED — external endpoint required**.
