import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { issueAuthTokens, REFRESH_COOKIE_NAME } from "@/lib/auth";
import type { UserRole } from "@/lib/permissions";
import type { BrowserSeed } from "./global-setup";
import { BASE_URL } from "./auth-state";

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
 * Mint a unique real refresh session for one browser journey.
 *
 * Rotating refresh tokens cannot safely be copied through a static Playwright
 * storageState file: the first browser context rotates the token and every later
 * context would replay the revoked predecessor. Each test therefore receives a
 * fresh server-issued refresh token. This bypasses only the public login rate
 * limiter; token issuance, DB persistence, rotation, revocation and the browser
 * refresh flow are exactly the production code paths.
 */
export async function authenticateSeeded(page: Page, identity: "admin" | "viewer" = "admin") {
  const fixture = seed();
  const isViewer = identity === "viewer";
  const role: UserRole = isViewer ? "VIEWER" : "ADMIN";
  const tokens = await issueAuthTokens({
    userId: isViewer ? fixture.viewerUserId : fixture.adminUserId,
    businessId: fixture.businessId,
    role,
    userAgent: "playwright-e2e",
  });

  await page.context().addCookies([
    {
      name: REFRESH_COOKIE_NAME,
      value: tokens.refreshToken,
      url: BASE_URL,
      httpOnly: true,
      secure: BASE_URL.startsWith("https://"),
      sameSite: "Lax",
    },
  ]);

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: SIGNED_IN_HEADING })).toBeVisible({ timeout: 20_000 });
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
