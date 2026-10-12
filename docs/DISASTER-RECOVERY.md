# Disaster recovery — backup, restore and RPO/RTO

Status: **drill executed and passing locally** (2026-10-05). Production recovery remains a
release activity: the drill proves the procedure, not that production backups are configured.

## Objectives

| Objective | Target | Mechanism |
| --- | --- | --- |
| RPO (max data loss) | ≤ 24 h with the default daily backup; ≤ 5 min when WAL archiving/PITR is enabled by the operator | `scripts/backup.sh` (custom-format `pg_dump`), plus the object-store lifecycle for media/recordings |
| RTO (time to restore service) | ≤ 60 min for the database plus app boot on the documented compose stack | `scripts/restore.sh` + `npm run db:migrate` + readiness probe |
| Restore verification | Every restore is validated into an **isolated** database before promotion | `scripts/ci/restore-drill.sh` |

Backups are operational artifacts: `backups/` is git-ignored and never committed.

## Procedure

1. **Backup** — `DATABASE_URL=... ./scripts/backup.sh [dir] [retention-days]` writes
   `app_db-<UTC>.dump` and prunes older dumps. Run it on a schedule (cron/systemd timer or the
   platform's managed backup) and copy dumps off-host; a dump on the same volume as the
   database is not a backup.
2. **Restore into isolation** — never restore straight over production:
   `scripts/ci/restore-drill.sh` creates `ai_restore_drill`, restores into it, validates,
   migrates twice and drops it. `scripts/restore.sh` refuses production-looking targets
   (`*prod*`, `*amazonaws.com*`, `*neon.tech*`, `*supabase*`) unless `RESTORE_ALLOW_PROD=1`.
3. **Validate** — table-count parity with the source, presence of critical tenant tables
   (`businesses`, `users`, `outbox_events`, `webhook_events`, `knowledge_documents`,
   `payment_transactions`, `audit_logs`), a sentinel tenant written before the backup must
   exist after the restore, and `webhook_events` must have zero rows without a tenant.
4. **Migrate** — `npm run db:migrate` is executed **twice** on the restored copy; a migration
   that is not idempotent on real data fails the drill.
5. **Health checks** — `SELECT 1`, pgvector extension, HNSW vector index and the trigram
   index must all exist; then the application probes `/api/health/live` and
   `/api/health/ready` after it is pointed at the restored database.
6. **Promote** — only after 3–5 pass. Keep the pre-promotion dump until the new instance has
   served traffic for at least one full business day.

## Drill evidence (2026-10-05, local PostgreSQL 16 + pgvector)

```
[drill] 1/8 creating isolated database ai_restore_drill
[drill] 3/8 seeding a sentinel tenant and capturing source facts
[drill]      source: 51 tables, ~16 rows
[drill] 5/8 restoring into the isolated database (scripts/restore.sh)
[drill]      sentinel tenant survived the round trip
[drill] 7/8 migrating the restored database twice (idempotency on real data)
[drill]      migrations recorded: 15
[drill] 8/8 health checks
[drill] PASS: backup → isolated restore → validate → migrate ×2 → health checks (sentinel round-tripped)
```

The same script runs in CI (job `container-and-restore`), so the drill cannot silently rot.

## Never auto-restore over production

There is no automated restore path in the application, the worker, the container entrypoint or
CI. Restores are operator-initiated, target-checked and run against an isolated database first.
A restore is never triggered by a schema mismatch or a failed migration; migrations are forward
and retried through `npm run db:migrate` with an advisory lock.

## Failure playbooks (short form)

- **Database corruption / bad migration:** stop writers (`docker compose stop app worker media`),
  take a fresh dump of the broken state for forensics, restore the last good dump into an
  isolated database, validate, then promote.
- **Accidental data deletion:** restore into isolation, extract the affected tenant's rows only,
  re-insert into production with the tenant boundary intact, and record the incident in the
  audit log.
- **Region loss:** dumps are replicated off-host; bring up the compose stack in the new region,
  restore, run migrations, verify probes, then re-point DNS.
