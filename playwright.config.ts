import { defineConfig, devices } from "@playwright/test";
import { AUTH_FILE, BASE_URL, E2E_PORT } from "./tests/browser/auth-state";

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
const PORT = E2E_PORT;

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // The `github` reporter turns failures into check-run annotations, so a red
  // browser job is diagnosable from the pull request itself.
  reporter: process.env.CI
    ? [["list"], ["github"], ["json", { outputFile: "test-results/browser.json" }]]
    : [["list"]],
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
      // One real sign-in per run; the journeys then reuse the session (the login
      // endpoint allows 5 attempts per minute per IP and the suite has fifteen
      // journeys). Journeys that exercise the login form itself opt out with
      // `test.use({ storageState: { cookies: [], origins: [] } })`.
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium-desktop",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 }, storageState: AUTH_FILE },
    },
    {
      name: "chromium-mobile",
      dependencies: ["setup"],
      // RTL/responsive QA: a narrow Persian phone viewport must stay usable.
      use: { ...devices["Pixel 7"], locale: "fa-IR", timezoneId: "Asia/Tehran", storageState: AUTH_FILE },
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
