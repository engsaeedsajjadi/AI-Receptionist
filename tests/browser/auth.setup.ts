import { test as setup } from "@playwright/test";
import { AUTH_FILE } from "./auth-state";
import { login } from "./helpers";

/** Signs the seeded admin in once and reuses the session for every journey. */
setup("authenticate as the seeded admin", async ({ page }) => {
  await login(page);
  await page.context().storageState({ path: AUTH_FILE });
});
