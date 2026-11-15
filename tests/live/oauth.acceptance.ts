import { describe, expect, it } from "vitest";
import { requireAnyEnv, requireLiveEnv } from "./live-config";

/**
 * Live OAuth acceptance: real OIDC discovery against the production issuer plus
 * a well-formed PKCE authorization URL. The interactive consent exchange
 * (authorization code) genuinely cannot be automated without a human login, so
 * it is reported as BLOCKED in docs/PRODUCTION-READINESS.md instead of being
 * faked here.
 */
describe("Live: OAuth / OIDC provider", () => {
  it("performs OIDC discovery and builds a PKCE authorization URL", async () => {
    const provider = requireAnyEnv(["GOOGLE_CLIENT_ID", "MICROSOFT_CLIENT_ID"], "OAuth provider") === "GOOGLE_CLIENT_ID" ? "google" : "microsoft";
    requireLiveEnv(
      provider === "google"
        ? ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]
        : ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_TENANT_ID"],
      `OAuth (${provider})`,
    );
    process.env.APP_URL ??= "http://localhost:3000";
    const { oauthConfiguration, startOAuth, oauthCallbackUrl } = await import("@/lib/oidc");
    const configuration = await oauthConfiguration(provider);
    expect(configuration.serverMetadata().issuer).toMatch(/^https:\/\//);
    const started = await startOAuth(provider);
    const url = new URL(started.url);
    expect(url.protocol).toBe("https:");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state") ?? "").not.toBe("");
    expect(url.searchParams.get("redirect_uri")).toBe(oauthCallbackUrl(provider).href);
    console.log(`[live:oauth] provider=${provider} issuer=${configuration.serverMetadata().issuer}`);
  }, 60_000);
});
