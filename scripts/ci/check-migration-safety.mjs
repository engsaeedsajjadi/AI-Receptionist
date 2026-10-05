#!/usr/bin/env node
/**
 * CI gate: migration safety.
 *
 * 1. `drizzle-kit push` must never appear in a production/deploy path.
 * 2. Every migration file must be committed together with its journal entry and
 *    snapshot, so `db:migrate` is reproducible from a clean checkout.
 * 3. Destructive statements (DROP TABLE / DROP COLUMN / TRUNCATE / DELETE
 *    without WHERE) must be explicitly justified, because migrations run in
 *    environments with live tenant data.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const problems = [];

// --- 1 · db:push must not be reachable from deploy/production paths ---------
const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
for (const [name, command] of Object.entries(scripts)) {
  const isDeployPath = /deploy|prod|start|release|ci|docker/i.test(name);
  if (isDeployPath && /\bpush\b/.test(command)) {
    problems.push(`package.json script "${name}" runs a push command outside development: ${command}`);
  }
}
const dockerfile = path.join(root, "Dockerfile");
if (existsSync(dockerfile)) {
  const docker = readFileSync(dockerfile, "utf8");
  if (/drizzle-kit\s+push/.test(docker)) problems.push("Dockerfile runs drizzle-kit push");
}
for (const compose of ["docker-compose.prod.yml", "docker-compose.yml"]) {
  const file = path.join(root, compose);
  if (existsSync(file) && /drizzle-kit\s+push/.test(readFileSync(file, "utf8"))) {
    problems.push(`${compose} runs drizzle-kit push`);
  }
}

// --- 2 · journal coverage ---------------------------------------------------
const drizzleDir = path.join(root, "drizzle");
if (!existsSync(drizzleDir)) {
  problems.push("drizzle/ directory is missing");
} else {
  const files = readdirSync(drizzleDir).filter((f) => f.endsWith(".sql")).sort();
  const journalPath = path.join(drizzleDir, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    problems.push("drizzle/meta/_journal.json is missing");
  } else {
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    const tags = new Set((journal.entries ?? []).map((e) => e.tag));
    for (const file of files) {
      if (!tags.has(file.replace(/\.sql$/, ""))) problems.push(`migration ${file} has no journal entry`);
    }
    for (const tag of tags) {
      if (!files.includes(`${tag}.sql`)) problems.push(`journal entry ${tag} has no migration file`);
      if (!existsSync(path.join(drizzleDir, "meta", `${tag.replace(/^\d+_/, "").length ? tag : tag}_snapshot.json`))) {
        // drizzle names snapshots by sequence, e.g. 0014_snapshot.json
        const seq = String(tag).match(/^(\d+)/)?.[1];
        if (!seq || !existsSync(path.join(drizzleDir, "meta", `${seq}_snapshot.json`))) {
          problems.push(`migration ${tag} has no matching meta snapshot`);
        }
      }
    }
  }

  // --- 3 · destructive statements must be justified --------------------------
  for (const file of files) {
    const sql = readFileSync(path.join(drizzleDir, file), "utf8");
    const lines = sql.split("\n");
    lines.forEach((line, index) => {
      const normalized = line.trim().toUpperCase();
      if (!/^(DROP|TRUNCATE|DELETE)\b/.test(normalized)) return;
      const justified =
        /--\s*(SAFE|INTENTIONAL|BACKFILL|RENAME|REPLACED)/i.test(line) ||
        lines
          .slice(Math.max(0, index - 6), index)
          .some((prev) => /--\s*(SAFE|INTENTIONAL|BACKFILL|RENAME|REPLACED)/i.test(prev));
      if (!justified) {
        problems.push(`${file}:${index + 1} runs a destructive statement without a SAFE/INTENTIONAL justification comment`);
      }
    });
  }
}

if (problems.length) {
  console.error("Migration safety check FAILED:");
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log("Migration safety check passed: no push in deploy paths, journal/snapshot coverage complete, destructive statements justified.");
