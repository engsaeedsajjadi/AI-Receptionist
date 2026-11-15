#!/usr/bin/env node
/**
 * CI gate: every `test:live:*` suite must FAIL LOUDLY when its required
 * configuration is absent.
 *
 * The enterprise rule is that live acceptance suites may never pass — or be
 * skipped into green — because credentials are missing. This script asserts that
 * with no credentials present and only a disposable test database designated:
 *
 *   1. the LIVE config refuses to load without an explicitly disposable
 *      database (TEST_DATABASE_URL + LIVE_TEST_CONFIRM_RESET=yes),
 *   2. invoking the suite without credentials exits non-zero,
 *   3. the failures are configuration errors ("Live acceptance unavailable: …"),
 *      not a crash or an empty run.
 *
 * Usage: node scripts/ci/check-live-suite-fails.mjs <suite>
 * Suites: llm | embedding | stt | tts | smtp | oauth | storage | telephony
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const SUITES = {
  llm: { env: ["LLM_PROVIDER", "OPENAI_API_KEY", "COMPATIBLE_LLM_BASE_URL"], label: "LLM turn completion" },
  embedding: { env: ["EMBEDDING_PROVIDER", "OPENAI_API_KEY"], label: "embeddings" },
  stt: { env: ["STT_PROVIDER", "OPENAI_API_KEY", "DEEPGRAM_API_KEY"], label: "speech-to-text" },
  tts: { env: ["TTS_PROVIDER", "ELEVENLABS_API_KEY", "OPENAI_API_KEY"], label: "text-to-speech" },
  smtp: { env: ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"], label: "transactional email" },
  oauth: { env: ["GOOGLE_CLIENT_ID", "MICROSOFT_CLIENT_ID", "OAUTH_REDIRECT_BASE_URL"], label: "OAuth login" },
  storage: { env: ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"], label: "object storage" },
  telephony: { env: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"], label: "telephony" },
};

const suite = process.argv[2];
if (!suite || !SUITES[suite]) {
  console.error(`usage: node scripts/ci/check-live-suite-fails.mjs <${Object.keys(SUITES).join("|")}>`);
  process.exit(2);
}

const root = process.cwd();
const suiteFile = path.join("tests", "live", `${suite}.acceptance.ts`);
if (!existsSync(path.join(root, "vitest.live.config.ts")) || !existsSync(path.join(root, "tests", "live"))) {
  console.error(`FAIL [${suite}] live suite infrastructure is missing (vitest.live.config.ts / tests/live/)`);
  process.exit(1);
}
if (!existsSync(path.join(root, suiteFile))) {
  console.error(`FAIL [${suite}] ${suiteFile} does not exist — the suite is not implemented`);
  process.exit(1);
}

const work = path.join(root, "test-results", "live-gate", suite);
mkdirSync(work, { recursive: true });
const reportPath = path.join(work, "report.json");

// Credential-scrubbed environment: the only thing that can stop the run is the
// missing provider configuration (the disposable-database guard is satisfied).
const childEnv = { ...process.env, LIVE_TEST_CONFIRM_RESET: "yes", LIVE_SUITE_UNDER_TEST: suite };
for (const key of Object.values(SUITES).flatMap((entry) => entry.env)) delete childEnv[key];

let result;
try {
  result = spawnSync(
    "npx",
    [
      "vitest",
      "run",
      "--config",
      "vitest.live.config.ts",
      suiteFile,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    { cwd: root, env: childEnv, encoding: "utf8", timeout: 300_000 },
  );
} catch (error) {
  rmSync(work, { recursive: true, force: true });
  console.error(`FAIL [${suite}] could not invoke the live suite: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
let report = null;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch {
  report = null;
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (result.status === 0) {
  console.error(
    `FAIL [${suite}] the live ${SUITES[suite].label} suite PASSED with no credentials configured. ` +
      `Live suites must fail loudly without configuration.`,
  );
  process.exit(1);
}

if (!report || typeof report.numTotalTests !== "number") {
  console.error(`FAIL [${suite}] no machine-readable result was produced. Output:\n${output.slice(-2000)}`);
  process.exit(1);
}
if (report.numTotalTests === 0) {
  console.error(`FAIL [${suite}] the live run executed zero tests — a missing credential must fail a real test case.`);
  process.exit(1);
}
if (!report.numFailedTests) {
  console.error(
    `FAIL [${suite}] the live run reported ${report.numPassedTests ?? 0} passing / ${report.numSkippedTests ?? 0} skipped tests instead of failing.`,
  );
  process.exit(1);
}

const messages = [];
for (const file of report.testResults ?? []) {
  for (const assertion of file.assertionResults ?? []) {
    for (const message of assertion.failureMessages ?? []) messages.push(String(message));
  }
}
const loud =
  messages.length > 0 &&
  messages.every((message) =>
    /Live acceptance unavailable|is required|not set|must be set|Missing credentials|LIVE_TEST_CONFIRM_RESET|Set TEST_DATABASE_URL/i.test(
      message,
    ),
  );
if (!loud) {
  console.error(
    `FAIL [${suite}] the live suite failed for a reason other than missing configuration. Messages:\n${messages
      .join("\n---\n")
      .slice(0, 2000)}`,
  );
  process.exit(1);
}

console.log(
  `OK [${suite}] live ${SUITES[suite].label} suite fails loudly without configuration (exit ${result.status}, ${report.numFailedTests}/${report.numTotalTests} failed on missing config)`,
);
