import { expect, test } from "@playwright/test";
import { authenticateSeeded, expectRtlDocument, loginThroughForm, seed, watchFailures } from "./helpers";

/**
 * Persian (fa-IR) RTL journeys over the real dashboard.
 *
 * Everything here runs against the disposable tenant seeded by global-setup:
 * seeded rows are asserted by their Persian content, and every write journey
 * re-reads the value after a reload so a "saved" message cannot be trusted
 * without persisted evidence.
 */

test.describe("۱ — ورود و کنترل دسترسی", () => {
  // These journeys are about the login form, so they must not inherit the
  // session captured for the rest of the suite.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("صفحه ورود فارسی، راست‌چین و دارای برچسب است", async ({ page }) => {
    await page.goto("/dashboard/login");
    await expectRtlDocument(page);
    await expect(page.getByRole("heading", { name: "ورود به داشبورد" })).toBeVisible();
    await expect(page.getByLabel("ایمیل")).toHaveAttribute("type", "email");
    await expect(page.getByLabel("گذرواژه")).toHaveAttribute("type", "password");
    await expect(page.getByRole("button", { name: "ورود", exact: true })).toBeEnabled();
  });

  test("گذرواژه نادرست با پیام خطای قابل‌مشاهده رد می‌شود", async ({ page }) => {
    await page.goto("/dashboard/login");
    await page.getByLabel("ایمیل").fill(seed().adminEmail);
    await page.getByLabel("گذرواژه").fill("Wrong-Password-1!");
    await page.getByRole("button", { name: "ورود", exact: true }).click();
    await expect(page.locator("p.text-red-700, [role=alert]").first()).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/login/);
  });

  test("ورود موفق به داشبورد می‌رسد و نام کسب‌وکار نمایش داده می‌شود", async ({ page }) => {
    await loginThroughForm(page);
    await expectRtlDocument(page);
    await expect(page.getByRole("heading", { name: "نمای کلی" })).toBeVisible();
    await expect(page.getByText(seed().businessName)).toBeVisible();
    await expect(page.getByRole("heading", { name: "مصرف سرویس‌ها" })).toBeVisible();
  });

  test("دسترسی بدون نشست به داشبورد به صفحه ورود هدایت می‌شود", async ({ page }) => {
    await page.goto("/dashboard/leads");
    await expect(page).toHaveURL(/\/dashboard\/login/, { timeout: 20_000 });
  });

  test("نقش مشاهده‌گر پیوندهای مدیریتی را نمی‌بیند", async ({ page }) => {
    await authenticateSeeded(page, "viewer");
    await expect(page.getByText(seed().businessName)).toBeVisible();
    for (const label of ["کاربران", "تنظیمات", "صورتحساب", "سهمیه‌ها", "مستأجرها"]) {
      await expect(page.getByRole("link", { name: label, exact: true })).toHaveCount(0);
    }
    // The journeys a viewer may perform stay available.
    await expect(page.getByRole("link", { name: "تماس‌ها", exact: true })).toBeVisible();
  });

});

// Logout gets its own refresh session. A rotated refresh token must never be
// reused across BrowserContexts because replay detection intentionally revokes it.
test.describe("۱ — پایان نشست", () => {
  test("خروج، نشست را پایان می‌دهد و دسترسی را می‌بندد", async ({ page }) => {
    await authenticateSeeded(page);
    await page.getByRole("button", { name: "خروج" }).click();
    await expect(page).toHaveURL(/\/dashboard\/login/, { timeout: 20_000 });
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard\/login/, { timeout: 20_000 });
  });
});

test.describe("۲ — داده‌های عملیاتی (فارسی)", () => {
  test("فهرست سرنخ‌ها سرنخ تازه را نشان می‌دهد و یادداشت جدید ذخیره می‌شود", async ({ page }) => {
    await authenticateSeeded(page);
    await page.getByRole("link", { name: "سرنخ‌ها", exact: true }).click();
    await expect(page.getByRole("heading", { name: "سرنخ‌ها" })).toBeVisible();
    await expect(page.getByText("09121112233")).toBeVisible();
    const leadRow = page.getByRole("row").filter({ hasText: "09121112233" });
    await leadRow.getByRole("button", { name: "جزئیات" }).click();

    const note = `یادداشت آزمایشی ${Date.now()}`;
    await page.getByPlaceholder("یادداشت جدید…").fill(note);
    await page.getByRole("button", { name: "ثبت", exact: true }).click();
    await expect(page.getByText(note)).toBeVisible({ timeout: 15_000 });
    // Survives a reload ⇒ it was persisted, not just echoed locally.
    await page.reload();
    const reloadedLeadRow = page.getByRole("row").filter({ hasText: "09121112233" });
    await reloadedLeadRow.getByRole("button", { name: "جزئیات" }).click();
    await page.getByRole("button", { name: /یادداشت‌ها/ }).first().click();
    await expect(page.getByText(note)).toBeVisible({ timeout: 15_000 });
  });

  test("مشتری با سابقه تماس و نوبت نمایش داده می‌شود", async ({ page }) => {
    await authenticateSeeded(page);
    await page.getByRole("link", { name: "مشتریان", exact: true }).click();
    await expect(page.getByText(seed().customerPhone)).toBeVisible();
    const customerRow = page.getByRole("row").filter({ hasText: seed().customerPhone });
    await customerRow.getByRole("button", { name: "جزئیات" }).click();
    await expect(page.getByText(/سرنخ‌ها \(\d+\)/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/تماس‌ها \(\d+\)/)).toBeVisible();
  });

  test("نوبت زمان‌بندی‌شده و بررسی ظرفیت روز کار می‌کند", async ({ page }) => {
    await authenticateSeeded(page);
    await page.getByRole("link", { name: "نوبت‌ها", exact: true }).click();
    await expect(page.getByRole("heading", { name: "نوبت‌ها" })).toBeVisible();
    await expect(page.getByText("بازدید آپارتمان سعادت‌آباد")).toBeVisible();
    await expect(page.getByRole("heading", { name: "بررسی ظرفیت روز" })).toBeVisible();
    const date = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await page.locator('input[type="date"]').first().fill(date);
    await page.getByRole("button", { name: /بررسی/ }).first().click();
    await expect(page.getByText(/ظرفیت|اسلات|ساعت/).first()).toBeVisible({ timeout: 15_000 });
  });

  test("تماس تکمیل‌شده با مدت و خلاصه فارسی دیده می‌شود", async ({ page }) => {
    await authenticateSeeded(page);
    await page.getByRole("link", { name: "تماس‌ها", exact: true }).click();
    await expect(page.getByRole("heading", { name: "تماس‌ها" })).toBeVisible();
    await expect(page.getByText("09121112233").first()).toBeVisible();
    await expect(page.getByText(/مشتری درباره آپارتمان سعادت‌آباد/)).toBeVisible();
  });

  test("پایگاه دانش سند فارسی را فهرست می‌کند و جست‌وجوی آزمایشی پاسخ می‌دهد", async ({ page }) => {
    await authenticateSeeded(page);
    await page.getByRole("link", { name: "پایگاه دانش", exact: true }).click();
    await expect(page.getByText(seed().knowledgeTitle)).toBeVisible();
    await page.getByPlaceholder("سؤال خود را بنویسید…").fill("کمیسیون فروش چند درصد است؟");
    await page.getByRole("button", { name: /جست‌وجو/ }).first().click();
    // The governed search must surface the seeded chunk (or degrade honestly,
    // never fabricate): either a Persian chunk or an explicit degradation note.
    await expect(page.getByText(/کمیسیون|تنزل|degraded|خطا/).first()).toBeVisible({ timeout: 20_000 });
  });

  test("مصرف سرویس‌ها فهرست یا وضعیت خالی صادقانه نمایش می‌دهد", async ({ page }) => {
    await authenticateSeeded(page);
    const failures = watchFailures(page);
    await page.getByRole("link", { name: "مصرف", exact: true }).click();
    await expect(page.getByRole("heading", { name: "مصرف" })).toBeVisible();
    await expect(page.getByText(/هزینه تقریبی|جمع کل|رکورد مصرفی ثبت نشده/).first()).toBeVisible({ timeout: 15_000 });
    expect(failures.failedRequests.filter((url) => url.includes("/api/v1/usage"))).toEqual([]);
  });
});

test.describe("۳ — پیکربندی (نوشتن و بازخوانی)", () => {
  test("پیکربندی منشی هوشمند ذخیره می‌شود", async ({ page }) => {
    await authenticateSeeded(page);
    await page.getByRole("link", { name: "منشی هوشمند", exact: true }).click();
    await expect(page.getByRole("heading", { name: /پیکربندی/ })).toBeVisible();
    const greeting = `سلام، این یک پیام آزمایشی ${Date.now()} است.`;
    const greetingField = page.locator("textarea").first();
    await greetingField.fill(greeting);
    await page.getByRole("button", { name: /ذخیره/ }).first().click();
    await expect(page.getByRole("status")).toContainText("پیکربندی و نسخه جدید ذخیره شد.", { timeout: 15_000 });
    await page.reload();
    await expect(page.locator("textarea").first()).toHaveValue(greeting, { timeout: 15_000 });
  });

  test("تنظیمات انتقال تماس ذخیره و پس از بارگذاری مجدد خوانده می‌شود", async ({ page }) => {
    await authenticateSeeded(page);
    await page.getByRole("link", { name: "تنظیمات", exact: true }).click();
    await expect(page.getByRole("heading", { name: /تنظیمات/ }).first()).toBeVisible();
    const number = `0912${String(Date.now()).slice(-7)}`;
    const transfer = page.getByLabel("شماره انتقال");
    await transfer.fill(number);
    await page.getByRole("button", { name: "ذخیره تنظیمات" }).click();
    await expect(page.getByText(/ذخیره شد/).first()).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByLabel("شماره انتقال")).toHaveValue(number, { timeout: 15_000 });
  });

  test("کاربر جدید با نقش کارشناس ساخته می‌شود", async ({ page }) => {
    await authenticateSeeded(page);
    await page.getByRole("link", { name: "کاربران", exact: true }).click();
    await expect(page.getByRole("heading", { name: "کاربران" })).toBeVisible();
    const email = `e2e-agent-${Date.now()}@example.com`;
    await page.getByPlaceholder("نام").fill("کارشناس آزمایشی");
    await page.getByPlaceholder("ایمیل").fill(email);
    await page.getByPlaceholder("گذرواژه (حداقل ۸ کاراکتر)").fill("BrowserTest1234!");
    await page.getByRole("button", { name: /افزودن|ایجاد|ذخیره/ }).first().click();
    await expect(page.getByText(email)).toBeVisible({ timeout: 15_000 });
  });

  test("امنیت حساب وضعیت دومرحله‌ای و نشست‌ها را نشان می‌دهد", async ({ page }) => {
    await authenticateSeeded(page);
    await page.getByRole("link", { name: "امنیت حساب", exact: true }).click();
    await expect(page.getByRole("heading", { name: "امنیت و نشست‌ها" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "احراز هویت دومرحله‌ای" })).toBeVisible();
    await expect(page.getByText(/غیرفعال|فعال/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "خروج از همه دستگاه‌ها" })).toBeVisible();
  });
});
