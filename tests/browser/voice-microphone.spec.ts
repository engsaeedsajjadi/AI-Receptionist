import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("microphone selection and silence guard regression", async () => {
  test.setTimeout(120_000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL
    ?? `http://127.0.0.1:${process.env.E2E_PORT ?? "3100"}`;

  const { stdout } = await execFileAsync(
    process.execPath,
    [join(process.cwd(), "tests/browser/voice-microphone-regression.cjs")],
    {
      cwd: process.cwd(),
      timeout: 110_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        VOICE_UI_BASE_URL: baseURL,
        PLAYWRIGHT_BROWSER_CHANNEL: "chromium",
      },
    },
  );

  expect(stdout.match(/SCENARIO_RESULT=PASS/g) ?? []).toHaveLength(2);
  expect(stdout).toContain("STEP_222_RESULT=PASS");
});
