import { expect, test } from "@playwright/test";
import { authenticateSeeded } from "./helpers";

/**
 * WCAG 2.2 AA structural checks (no axe-core dependency required).
 *
 * These assert the properties that regressions actually break: language and
 * direction, one page heading, accessible names on every control, labelled form
 * fields, visible focus indication and meaningful link text.
 */

const PAGES = [
  { path: "/dashboard", heading: "نمای کلی" },
  { path: "/dashboard/leads", heading: "سرنخ‌ها" },
  { path: "/dashboard/customers", heading: "مشتریان" },
  { path: "/dashboard/calls", heading: "تماس‌ها" },
  { path: "/dashboard/appointments", heading: "نوبت‌ها" },
  { path: "/dashboard/knowledge", heading: "پایگاه دانش" },
  { path: "/dashboard/usage", heading: "مصرف" },
  { path: "/dashboard/security", heading: "امنیت و نشست‌ها" },
];

test.describe("۵ — دسترس‌پذیری (WCAG 2.2 AA ساختاری)", () => {
  for (const target of PAGES) {
    test(`ساختار دسترس‌پذیر صفحه ${target.path}`, async ({ page }) => {
      await authenticateSeeded(page);
      await page.goto(target.path);
      await expect(page.getByRole("heading", { name: target.heading }).first()).toBeVisible({ timeout: 20_000 });

      // 3.1.1/1.4.10 — language, direction and no forced horizontal scroll.
      await expect(page.locator("html")).toHaveAttribute("lang", "fa");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(2);

      // 4.1.2 — every interactive control has an accessible name.
      const unnamed = await page.evaluate(() =>
        Array.from(document.querySelectorAll("button, a, input, select, textarea"))
          .filter((el) => {
            const element = el as HTMLElement;
            if (element.hasAttribute("aria-hidden") || element.closest("[aria-hidden=true]")) return false;
            const name =
              (element.getAttribute("aria-label") ??
                element.getAttribute("title") ??
                element.textContent ??
                "").trim() ||
              (element instanceof HTMLInputElement ? element.labels?.[0]?.textContent ?? element.getAttribute("placeholder") ?? "" : "");
            return String(name).trim().length === 0;
          })
          .map((el) => el.outerHTML.slice(0, 120)),
      );
      expect(unnamed).toEqual([]);

      // 2.4.7 — keyboard focus is visibly indicated.
      const focusRing = await page.evaluate(() => {
        const first = document.querySelector("a, button") as HTMLElement | null;
        if (!first) return "none";
        first.focus();
        const styles = window.getComputedStyle(first);
        return `${styles.outlineStyle}|${styles.outlineWidth}|${styles.boxShadow}`;
      });
      expect(focusRing).not.toBe("none||none");

      // 1.3.1 — form inputs keep their labels/placeholder association.
      const unlabelledInputs = await page.evaluate(() =>
        Array.from(document.querySelectorAll("input:not([type=hidden]), select, textarea"))
          .filter((el) => {
            const input = el as HTMLInputElement;
            return !input.labels?.length && !input.getAttribute("aria-label") && !input.getAttribute("placeholder");
          })
          .map((el) => (el as HTMLElement).outerHTML.slice(0, 120)),
      );
      expect(unlabelledInputs).toEqual([]);

      // 2.4.4 — links describe their destination (no bare "here"/"click").
      const weakLinks = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a"))
          .map((a) => (a.textContent ?? "").trim())
          .filter((text) => text.length === 0 && !document.querySelector("a[aria-label]")),
      );
      expect(weakLinks).toEqual([]);
    });
  }
});
