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
