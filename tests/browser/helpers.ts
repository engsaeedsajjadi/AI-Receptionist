import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import type { BrowserSeed } from "./global-setup";

export function seed(): BrowserSeed {
  return JSON.parse(readFileSync("test-results/browser-seed.json", "utf8")) as BrowserSeed;
}

/**
 * The heading the signed-in `/dashboard` overview renders; the login page never
 * does. It is visible on every viewport, unlike the sidebar's logout control.
 */
const SIGNED_IN_HEADING = "نمای کلی";

/**
 * Sign in through the real login form (never by injecting tokens).
 *
 * Idempotent: when the context already carries a session (the suite reuses the
 * state captured by `auth.setup.ts`) the dashboard is reachable directly and no
 * credentials are sent — the login endpoint is rate limited to 5 attempts per
 * minute per IP.
 *
 * The decisions here must be made on *rendered* evidence, not on timing. The
 * shell picks its interface on the client: with a valid refresh cookie it renders
 * the dashboard, otherwise it replaces the route with `/dashboard/login` once the
 * refresh attempt fails. That happens after `page.goto()` resolves, so asking
 * `page.url()` immediately (as this helper used to) saw a still-loading
 * `/dashboard`, concluded "already signed in" and returned without submitting
 * anything. Every later assertion then failed on a page that had quietly become
 * the login form — including `auth.setup.ts`, which captured an empty cookie jar
 * that authenticated nobody.
 */
export async function login(page: Page, email = seed().adminEmail, password = seed().adminPassword) {
  await page.goto("/dashboard");

  const emailField = page.getByLabel("ایمیل");
  const overview = page.getByRole("heading", { name: SIGNED_IN_HEADING });
  await expect(emailField.or(overview).first()).toBeVisible({ timeout: 30_000 });

  if (await emailField.isVisible()) {
    await emailField.fill(email);
    await page.getByLabel("گذرواژه").fill(password);
    // Exact name: the form also has "ورود با Google" / "ورود با Microsoft"
    // buttons, and a regex matches all three (strict-mode violation).
    await page.getByRole("button", { name: "ورود", exact: true }).click();
  }

  // Signed in means the dashboard rendered — not merely that a URL changed.
  await expect(overview).toBeVisible({ timeout: 20_000 });
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
