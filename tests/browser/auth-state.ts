/**
 * Where the authenticated browser state is written.
 *
 * The file holds session cookies, so it lives outside `test-results/` (which CI
 * uploads as an artifact) and is gitignored. Every journey that does not exercise
 * the login form itself reuses this state instead of signing in again — the login
 * endpoint is rate limited to 5 attempts per minute per IP, and re-authenticating
 * in all fifteen journeys both exceeded that budget and tested the login form
 * instead of the journey.
 */
export const AUTH_FILE = ".auth/browser-admin.json";

/**
 * Where the suite drives the application.
 *
 * Shared by the Playwright config, the seed and the session probe in
 * `auth.setup.ts` so that all three agree on one address, including when an
 * already-running server is targeted through `PLAYWRIGHT_BASE_URL`.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`;
