#!/usr/bin/env node
/**
 * CI gate: prove the test run EXECUTED everything (green must mean verified).
 *
 * Vitest exits 0 even when whole suites skip via describe.skipIf / ctx.skip,
 * so a misconfigured CI (missing TEST_DATABASE_URL / REDIS_URL) would look
 * green while running only unit tests. This script fails the build unless:
 *   1. the run reports success with zero failed tests, AND
 *   2. zero tests were skipped/pending/todo across the whole run, AND
 *   3. every tests/integration + tests/e2e file on disk was collected and
 *      contributed at least one passed test (guards silent file exclusion).
 *
 * Usage: node scripts/ci/check-test-results.mjs <vitest-json-report>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: check-test-results.mjs <vitest-json-report>");
  process.exit(2);
}

const failures = [];
const fail = (msg) => failures.push(msg);

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  console.error(`cannot parse vitest JSON report at ${reportPath}: ${err.message}`);
  process.exit(2);
}

// --- 1. The run itself must be green. ---
if (report.success !== true) fail(`vitest run reported success=${report.success}`);
if ((report.numFailedTests ?? 0) !== 0) fail(`numFailedTests=${report.numFailedTests}`);

// --- 2. Nothing may have been skipped. ---
const skipped = [];
for (const file of report.testResults ?? []) {
  for (const a of file.assertionResults ?? []) {
    if (a.status !== "passed") skipped.push(`${relative(process.cwd(), file.name)} :: ${a.fullName} [${a.status}]`);
  }
}
if ((report.numPendingTests ?? 0) !== 0) fail(`numPendingTests=${report.numPendingTests} (skipped suites)`);
for (const s of skipped) fail(`skipped: ${s}`);

// --- 3. Every integration/e2e file on disk must have run ≥1 passed test. ---
function listTestFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".test.ts")) out.push(resolve(p));
    }
  };
  walk(dir);
  return out;
}

const root = process.cwd();
const required = [...listTestFiles(join(root, "tests", "integration")), ...listTestFiles(join(root, "tests", "e2e"))];
const byFile = new Map((report.testResults ?? []).map((r) => [resolve(r.name), r]));
for (const abs of required) {
  const rel = relative(root, abs);
  const entry = byFile.get(abs);
  if (!entry) {
    fail(`not collected: ${rel}`);
    continue;
  }
  const passed = (entry.assertionResults ?? []).filter((a) => a.status === "passed").length;
  if (passed === 0) fail(`no passed tests: ${rel}`);
}

const files = (report.testResults ?? []).length;
console.log(
  `suites=${report.numTotalTestSuites} tests=${report.numTotalTests} ` +
    `passed=${report.numPassedTests} failed=${report.numFailedTests} skipped=${report.numPendingTests} ` +
    `files=${files} required=${required.length}`,
);

if (failures.length > 0) {
  console.error(`\ncheck-test-results: ${failures.length} violation(s) — CI must not be green:\n`);
  for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
  if (failures.length > 40) console.error(`  ... and ${failures.length - 40} more`);
  process.exit(1);
}
console.log("check-test-results: OK — full suite executed, nothing skipped.");
