import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import type { BrowserSeed } from "./global-setup";

export function seed(): BrowserSeed {
  return JSON.parse(readFileSync("test-results/browser-seed.json", "utf8")) as BrowserSeed;
}

const SIGNED_IN_HEADING = "نمای کلی";

/**
 * Sign in through the real login form. Used only by login-specific journeys.
 */
export async function loginThroughForm(
  page: Page,
  email = seed().adminEmail,
  password = seed().adminPassword,
) {
  await page.goto("/dashboard/login");
  await page.getByLabel("ایمیل").fill(email);
  await page.getByLabel("گذرواژه").fill(password);
  await page.getByRole("button", { name: "ورود", exact: true }).click();
  await expect(page.getByRole("heading", { name: SIGNED_IN_HEADING })).toBeVisible({ timeout: 20_000 });
}

/**
 * Start every browser journey through the same public login path used by a real
 * user. Directly minting refresh tokens from Playwright's runner process made
 * the test depend on cross-process DB/session timing before the Next dev server
 * ever saw the login. The E2E workflow has a loopback-only, non-production
 * rate-limit escape hatch, so repeated real logins remain deterministic while
 * password validation, session persistence, cookie issuance and refresh
 * rotation are all exercised exactly as production code does.
 */
export async function authenticateSeeded(page: Page, identity: "admin" | "viewer" = "admin") {
  const fixture = seed();
  await loginThroughForm(
    page,
    identity === "viewer" ? fixture.viewerEmail : fixture.adminEmail,
    identity === "viewer" ? fixture.viewerPassword : fixture.adminPassword,
  );
}

export async function expectRtlDocument(page: Page) {
  const html = page.locator("html");
  await expect(html).toHaveAttribute("dir", "rtl");
  await expect(html).toHaveAttribute("lang", "fa");
}

export function watchFailures(page: Page) {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => failedRequests.push(request.url()));
  return { consoleErrors, failedRequests };
}
