import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OIDC sign-in (Google / Microsoft) without a network: `openid-client` and
 * Redis are replaced by in-memory fakes. The security properties under test are
 * the ones a login-CSRF or code-replay attack would target: PKCE + state +
 * nonce are generated and stored server-side, the callback state must match the
 * browser cookie, a flow is single-use and bound to its provider, and a
 * response without a real identity is refused.
 */
const lib = vi.hoisted(() => ({
  discovery: vi.fn(),
  enableNonRepudiationChecks: vi.fn(),
  authorizationCodeGrant: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  counter: 0,
}));
const store = vi.hoisted(() => new Map<string, string>());

vi.mock("openid-client", () => ({
  discovery: lib.discovery,
  enableNonRepudiationChecks: lib.enableNonRepudiationChecks,
  authorizationCodeGrant: lib.authorizationCodeGrant,
  buildAuthorizationUrl: lib.buildAuthorizationUrl,
  randomState: () => `state-${++lib.counter}`,
  randomPKCECodeVerifier: () => `verifier-${lib.counter}`,
  randomNonce: () => `nonce-${lib.counter}`,
  // Opaque on purpose: the challenge must not reveal the verifier.
  calculatePKCECodeChallenge: async (verifier: string) => `s256:${verifier.length}:${lib.counter}`,
}));

vi.mock("@/lib/redis", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/redis")>()),
  redisGet: async (key: string) => store.get(key) ?? null,
  redisSet: async (key: string, value: string) => { store.set(key, value); },
  redisDel: async (key: string) => { store.delete(key); },
  setNx: async (key: string, value: string) => {
    if (store.has(key)) return false;
    store.set(key, value);
    return true;
  },
}));

async function load() {
  vi.resetModules(); // the module caches discovery per provider
  return import("@/lib/oidc");
}

const MS_TENANT = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  store.clear();
  lib.counter = 0;
  lib.discovery.mockReset().mockImplementation(async (issuer: URL) => ({ issuer: issuer.href }));
  lib.enableNonRepudiationChecks.mockReset();
  lib.authorizationCodeGrant.mockReset();
  lib.buildAuthorizationUrl.mockReset().mockImplementation(
    (_config: unknown, params: Record<string, string>) =>
      new URL(`https://idp.example.test/authorize?${new URLSearchParams(params)}`),
  );
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-secret");
  vi.stubEnv("MICROSOFT_CLIENT_ID", "ms-client");
  vi.stubEnv("MICROSOFT_CLIENT_SECRET", "ms-secret");
  vi.stubEnv("MICROSOFT_TENANT_ID", MS_TENANT);
  vi.stubEnv("APP_URL", "https://app.example.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider selection and configuration", () => {
  it("accepts only the two supported providers", async () => {
    const { oauthProvider } = await load();
    expect(oauthProvider("google")).toBe("google");
    expect(oauthProvider("microsoft")).toBe("microsoft");
    for (const value of ["github", "", "Google", "../google"]) {
      expect(() => oauthProvider(value)).toThrowError(/not found/);
    }
  });

  it("is unavailable (503) when credentials or a valid Microsoft tenant id are missing", async () => {
    const { oauthConfiguration } = await load();
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    expect(() => oauthConfiguration("google")).toThrowError(/not configured/);

    vi.stubEnv("MICROSOFT_TENANT_ID", "common");
    expect(() => oauthConfiguration("microsoft")).toThrowError(/not configured/);
    expect(lib.discovery).not.toHaveBeenCalled();
  });

  it("discovers each issuer once, with non-repudiation checks, and retries after a failed discovery", async () => {
    const { oauthConfiguration } = await load();
    await oauthConfiguration("google");
    await oauthConfiguration("google");
    await oauthConfiguration("microsoft");

    expect(lib.discovery).toHaveBeenCalledTimes(2);
    expect(lib.discovery.mock.calls[0][0].href).toBe("https://accounts.google.com/");
    expect(lib.discovery.mock.calls[0].slice(1)).toEqual(["google-client", "google-secret"]);
    expect(lib.discovery.mock.calls[1][0].href).toBe(`https://login.microsoftonline.com/${MS_TENANT}/v2.0`);
    expect(lib.enableNonRepudiationChecks).toHaveBeenCalledTimes(2);

    const fresh = await load();
    lib.discovery.mockReset().mockRejectedValueOnce(new Error("idp down")).mockResolvedValueOnce({ ok: true });
    await expect(fresh.oauthConfiguration("google")).rejects.toThrow("idp down");
    await expect(fresh.oauthConfiguration("google")).resolves.toEqual({ ok: true });
  });
});

describe("cookie and callback URL", () => {
  it("builds an HttpOnly, SameSite=Lax state cookie that is Secure only in production", async () => {
    const { oauthCookie } = await load();
    vi.stubEnv("NODE_ENV", "test");
    expect(oauthCookie("a b")).toBe("ar_oidc=a%20b; HttpOnly; Path=/; SameSite=Lax; Max-Age=600");
    vi.stubEnv("NODE_ENV", "production");
    expect(oauthCookie("s", 0)).toBe("ar_oidc=s; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Secure");
  });

  it("derives the callback URL from APP_URL", async () => {
    const { oauthCallbackUrl } = await load();
    expect(oauthCallbackUrl("microsoft").href).toBe("https://app.example.test/api/v1/auth/oauth/microsoft/callback");
  });
});

describe("startOAuth", () => {
  it("stores state, PKCE verifier and nonce server-side and sends only the challenge to the IdP", async () => {
    const { startOAuth } = await load();
    const started = await startOAuth("google", { userId: "u1", businessId: "b1", credentialVersion: 3 });

    expect(started.cookie).toContain("ar_oidc=state-1;");
    expect(JSON.parse(store.get("oauth:flow:state-1")!)).toEqual({
      provider: "google", verifier: "verifier-1", nonce: "nonce-1", userId: "u1", businessId: "b1", credentialVersion: 3,
    });

    const url = new URL(started.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      redirect_uri: "https://app.example.test/api/v1/auth/oauth/google/callback",
      scope: "openid email profile",
      state: "state-1",
      nonce: "nonce-1",
      code_challenge_method: "S256",
      code_challenge: "s256:10:1",
    });
    expect(started.url).not.toContain("verifier-1");
  });
});

describe("finishOAuth", () => {
  const callback = (state: string | null) =>
    new URL(`https://app.example.test/api/v1/auth/oauth/google/callback?code=abc${state ? `&state=${state}` : ""}`);

  async function started(provider: "google" | "microsoft" = "google") {
    const oidc = await load();
    await oidc.startOAuth(provider);
    lib.authorizationCodeGrant.mockResolvedValue({
      claims: () => ({ sub: "subject-123", iss: "https://accounts.google.com" }),
    });
    return oidc;
  }

  it("exchanges the code with the stored verifier and nonce and returns the verified identity", async () => {
    const { finishOAuth } = await started();
    const result = await finishOAuth("google", callback("state-1"), "state-1");

    expect(result).toMatchObject({ subject: "subject-123", issuer: "https://accounts.google.com" });
    expect(result.flow).toMatchObject({ provider: "google", verifier: "verifier-1", nonce: "nonce-1" });
    const [, url, checks] = lib.authorizationCodeGrant.mock.calls[0];
    expect(url.searchParams.get("code")).toBe("abc");
    expect(checks).toEqual({
      pkceCodeVerifier: "verifier-1", expectedState: "state-1", expectedNonce: "nonce-1", idTokenExpected: true,
    });
    expect(store.has("oauth:flow:state-1")).toBe(false);
  });

  it("refuses a callback whose state is missing or does not match the browser cookie", async () => {
    const { finishOAuth } = await started();
    await expect(finishOAuth("google", callback(null), "state-1")).rejects.toThrow("OAuth state mismatch");
    await expect(finishOAuth("google", callback("state-1"), null)).rejects.toThrow("OAuth state mismatch");
    await expect(finishOAuth("google", callback("state-1"), "attacker-state")).rejects.toThrow("OAuth state mismatch");
    expect(lib.authorizationCodeGrant).not.toHaveBeenCalled();
    // A rejected attempt must not burn the victim's legitimate flow.
    expect(store.has("oauth:flow:state-1")).toBe(true);
  });

  it("is single-use: a replayed callback is refused", async () => {
    const { finishOAuth } = await started();
    await finishOAuth("google", callback("state-1"), "state-1");
    await expect(finishOAuth("google", callback("state-1"), "state-1")).rejects.toThrow("expired or consumed");
    expect(lib.authorizationCodeGrant).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown or expired flow", async () => {
    const { finishOAuth } = await started();
    await expect(finishOAuth("google", callback("state-999"), "state-999")).rejects.toThrow("expired or consumed");
    expect(lib.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it("refuses a flow started with one provider and finished with another", async () => {
    const { finishOAuth } = await started("google");
    await expect(finishOAuth("microsoft", callback("state-1"), "state-1")).rejects.toThrow("provider mismatch");
    expect(lib.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it("refuses a token response without a subject or issuer", async () => {
    const { finishOAuth } = await started();
    lib.authorizationCodeGrant.mockResolvedValue({ claims: () => ({ sub: "", iss: "https://accounts.google.com" }) });
    await expect(finishOAuth("google", callback("state-1"), "state-1")).rejects.toThrow("identity token required");

    // A fresh sign-in attempt gets a new state (state-2).
    const second = await started();
    lib.authorizationCodeGrant.mockResolvedValue({ claims: () => undefined });
    await expect(second.finishOAuth("google", callback("state-2"), "state-2")).rejects.toThrow("identity token required");
  });
});
