import { expect, test } from "@playwright/test";

test.describe("۶ — PWA و حریم خصوصی offline", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("manifest قابل نصب و service worker فاقد cache API است", async ({ page, request }) => {
    await page.goto("/");
    const manifestLink = page.locator('link[rel="manifest"]');
    await expect(manifestLink).toHaveAttribute("href", /manifest\.webmanifest/);

    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.status()).toBe(200);
    const body = await manifest.json();
    expect(body.display).toBe("standalone");
    expect(body.start_url).toBe("/dashboard");
    expect(body.dir).toBe("rtl");

    const worker = await request.get("/sw.js");
    expect(worker.status()).toBe(200);
    const source = await worker.text();
    expect(source).toContain('url.pathname.startsWith("/api/")');
    expect(source).not.toContain('caches.add("/dashboard")');
  });

  test("offline shell هیچ داده tenant نمایش نمی‌دهد", async ({ page }) => {
    await page.goto("/offline");
    await expect(page.getByRole("heading", { name: "اتصال اینترنت در دسترس نیست" })).toBeVisible();
    await expect(page.getByText(/داده‌های تماس، مشتری و داشبورد/)).toBeVisible();
  });
});
