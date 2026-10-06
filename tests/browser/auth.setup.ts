import { expect, test as setup } from "@playwright/test";
import { loginThroughForm } from "./helpers";

/**
 * One explicit end-to-end login check. Authenticated product journeys do not
 * reuse this cookie because refresh tokens rotate on first use; each journey
 * mints its own server-issued test session in helpers.ts.
 */
setup("authenticate as the seeded admin", async ({ page }) => {
  await loginThroughForm(page);
  const cookies = await page.context().cookies();
  expect(cookies.some((cookie) => cookie.name === "ar_refresh")).toBe(true);
  await expect(page.getByRole("heading", { name: "نمای کلی" })).toBeVisible();
});
