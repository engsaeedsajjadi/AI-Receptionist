import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import type { BrowserSeed } from "./global-setup";

export function seed(): BrowserSeed {
  return JSON.parse(readFileSync("test-results/browser-seed.json", "utf8")) as BrowserSeed;
}

/** Sign in through the real login form (never by injecting tokens). */
export async function login(page: Page, email = seed().adminEmail, password = seed().adminPassword) {
  await page.goto("/dashboard/login");
  await page.getByLabel("ایمیل").fill(email);
  await page.getByLabel("گذرواژه").fill(password);
  await page.getByRole("button", { name: /ورود/ }).click();
  await expect(page).toHaveURL(/\/dashboard(?!\/login)/, { timeout: 20_000 });
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
