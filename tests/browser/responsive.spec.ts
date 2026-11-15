import { expect, test } from "@playwright/test";
import { authenticateSeeded, expectRtlDocument } from "./helpers";

/**
 * RTL / responsive QA on a narrow Persian phone viewport (project: chromium-mobile).
 * The product must remain usable — and never scroll horizontally — on a phone.
 */

test.describe("۴ — واکنش‌گرایی و راست‌چین در موبایل", () => {
  test.describe("صفحه ورود", () => {
    // The login form is only reachable without a session.
    test.use({ storageState: { cookies: [], origins: [] } });

    test("صفحه ورود در موبایل بدون سرریز افقی نمایش داده می‌شود", async ({ page }) => {
      await page.goto("/dashboard/login");
      await expectRtlDocument(page);
      await expect(page.getByLabel("ایمیل")).toBeVisible();
      await expect(page.getByLabel("گذرواژه")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(2);
    });
  });

  test("ناوبری داشبورد در موبایل قابل استفاده است", async ({ page }) => {
    await authenticateSeeded(page);
    await expectRtlDocument(page);
    // The compact, horizontally scrollable navigation replaces the sidebar below md.
    const nav = page.getByRole("link", { name: "سرنخ‌ها", exact: true }).first();
    await nav.scrollIntoViewIfNeeded();
    await nav.click();
    await expect(page).toHaveURL(/\/dashboard\/leads/);
    await expect(page.getByRole("heading", { name: "سرنخ‌ها" })).toBeVisible();
  });

  test("جدول‌های داده در موبایل سرریز افقی صفحه ایجاد نمی‌کنند", async ({ page }) => {
    await authenticateSeeded(page);
    await page.goto("/dashboard/calls");
    await expect(page.getByRole("heading", { name: "تماس‌ها" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });
});
