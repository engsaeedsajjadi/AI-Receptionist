import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import type { BrowserSeed } from "./global-setup";

export function seed(): BrowserSeed {
  return JSON.parse(readFileSync("test-results/browser-seed.json", "utf8")) as BrowserSeed;
}

/**
 * Sign in through the real login form (never by injecting tokens).
 *
 * Idempotent: when the context already carries a session (the suite reuses the
 * state captured by `auth.setup.ts`) the dashboard is reachable directly and no
 * credentials are sent — the login endpoint is rate limited to 5 attempts per
 * minute per IP. Only a context that lands on the login page fills the form.
 */
export async function login(page: Page, email = seed().adminEmail, password = seed().adminPassword) {
  await page.goto("/dashboard");
  if (/\/dashboard\/login/.test(page.url())) {
    await page.getByLabel("ایمیل").fill(email);
    await page.getByLabel("گذرواژه").fill(password);
    // Exact name: the form also has "ورود با Google" / "ورود با Microsoft"
    // buttons, and a regex matches all three (strict-mode violation).
    await page.getByRole("button", { name: "ورود", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard(?!\/login)/, { timeout: 20_000 });
  }
}

/** The whole product is Persian/RTL; every journey asserts the document contract. */
export async function expectRtlDocument(page: Page) {
  const html = page.locator("html");
  await expect(html).toHaveAttribute("dir", "rtl");
  await expect(html).toHaveAttribute("lang", "fa");
}

/** Collect console errors and failed requests for the honesty assertions. */
export function watchFailures(page: Page) {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => failedRequests.push(request.url()));
  return { consoleErrors, failedRequests };
}
