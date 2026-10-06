import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, E2E_PORT } from "./tests/browser/auth-state";

const PORT = E2E_PORT;

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
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
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium-desktop",
      dependencies: ["setup"],
      testMatch: /(?:journeys|accessibility|responsive)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 } },
    },
    {
      name: "chromium-mobile",
      dependencies: ["setup"],
      testMatch: /responsive\.spec\.ts/,
      use: { ...devices["Pixel 7"], locale: "fa-IR", timezoneId: "Asia/Tehran" },
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
