import { defineConfig, devices } from "@playwright/test";

/**
 * Browser journeys for the Persian/RTL dashboard.
 *
 * The suite drives the real Next.js application against the same test database
 * used by the integration suites (tests/helpers/db.ts). It never talks to a
 * production tenant: `tests/browser/global-setup.ts` refuses to run unless the
 * database URL points at a test database.
 *
 * Run:
 *   npm run test:browser               # boots a dev server on E2E_PORT (default 3100)
 *   E2E_MODE=production npm run build && E2E_MODE=production npm run test:browser
 *
 * The default server mode is `next dev`, because `next start` requires a full
 * production environment (real JWT/webhook secrets and non-dev providers) which
 * an offline E2E box does not have; the production build itself is validated in
 * the CI `validation` job. Optional: PLAYWRIGHT_BASE_URL to target an
 * already-running deployment.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["json", { outputFile: "test-results/browser.json" }]] : [["list"]],
  globalSetup: "./tests/browser/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    trace: "retain-on-failure",
    video: process.env.CI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 } },
    },
    {
      name: "chromium-mobile",
      // RTL/responsive QA: a narrow Persian phone viewport must stay usable.
      use: { ...devices["Pixel 7"], locale: "fa-IR", timezoneId: "Asia/Tehran" },
      testMatch: /responsive\.spec\.ts/,
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command:
          process.env.E2E_MODE === "production"
            ? `npm run start -- --port ${PORT} --hostname 0.0.0.0`
            : `npm run dev -- --port ${PORT} --hostname 0.0.0.0`,
        url: `${BASE_URL}/api/health/live`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
