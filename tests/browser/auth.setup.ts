import { expect, test as setup } from "@playwright/test";
import { AUTH_FILE, BASE_URL } from "./auth-state";
import { login } from "./helpers";

/**
 * Signs the seeded admin in once and reuses the session for every journey.
 *
 * The captured state is then *proved*: a cookie jar that cannot restore a session
 * would otherwise turn every journey into a page that never renders, and the real
 * cause ("the suite is running unauthenticated") would only show up as thirty
 * unrelated "element(s) not found" failures. A setup that stores a session has to
 * demonstrate that the session works.
 */
setup("authenticate as the seeded admin", async ({ page, browser }) => {
  await login(page);

  const state = await page.context().storageState({ path: AUTH_FILE });
  if (state.cookies.length === 0) {
    throw new Error(
      `No session cookie reached ${AUTH_FILE}: the sign-in did not complete, so every journey would reuse an unauthenticated context.`,
    );
  }

  const restored = await browser.newContext({ baseURL: BASE_URL, locale: "fa-IR", storageState: AUTH_FILE });
  try {
    const probe = await restored.newPage();
    await probe.goto("/dashboard");
    const emailField = probe.getByLabel("ایمیل");
    const overview = probe.getByRole("heading", { name: "نمای کلی" });
    await expect(emailField.or(overview).first()).toBeVisible({ timeout: 30_000 });
    if (!(await overview.isVisible())) {
      throw new Error(`The session captured in ${AUTH_FILE} did not authenticate: /dashboard rendered the login form instead.`);
    }
  } finally {
    await restored.close();
  }
});
