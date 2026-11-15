import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const run = promisify(execFile);
test("local G.711 telephone lab UI with mocked provider", async () => {
  test.setTimeout(120_000);
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ??
    `http://127.0.0.1:${process.env.E2E_PORT ?? "3100"}`;
  const { stdout } = await run(process.execPath,
    [join(process.cwd(), "tests/browser/local-telephony-browser.cjs")],
    {
      cwd: process.cwd(), timeout: 100_000, maxBuffer: 1024 * 1024,
      env: {
        ...process.env, VOICE_UI_BASE_URL: baseURL,
        PLAYWRIGHT_BROWSER_CHANNEL: "chromium",
      },
    },
  );
  expect(stdout).toContain("CODEC_UI=PASS");
  expect(stdout).toContain("G711_FORM_UPLOAD=PASS");
  expect(stdout).toContain("EXACT_MIC_SELECTED=true");
  expect(stdout).toContain("AI_ROUTE_MOCKED=PASS");
  expect(stdout).toContain("LOCAL_TELEPHONY_BROWSER_RESULT=PASS");
});
