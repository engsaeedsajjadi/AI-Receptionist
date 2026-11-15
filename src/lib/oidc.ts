import * as oidc from "openid-client";
import { AppError } from "@/lib/errors";
import { redisDel, redisGet, redisSet, setNx } from "@/lib/redis";
import { safeEqual } from "@/lib/security";
export type OAuthProvider = "google" | "microsoft";
type Flow = { provider: OAuthProvider; verifier: string; nonce: string; userId?: string; businessId?: string; credentialVersion?: number };
export function oauthProvider(value: string): OAuthProvider {
  if (value !== "google" && value !== "microsoft") throw new AppError(404, "NOT_FOUND", "OAuth provider not found");
  return value;
}
const configurations = new Map<string, Promise<oidc.Configuration>>();
export function oauthConfiguration(provider: OAuthProvider) {
  const prefix = provider.toUpperCase();
  const id = process.env[`${prefix}_CLIENT_ID`], secret = process.env[`${prefix}_CLIENT_SECRET`];
  const tenant = process.env.MICROSOFT_TENANT_ID;
  if (!id || !secret || (provider === "microsoft" && !/^[a-f\d-]{36}$/i.test(tenant ?? ""))) throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "OAuth provider is not configured");
  if (!configurations.has(provider)) {
    const issuer = provider === "google" ? "https://accounts.google.com" : `https://login.microsoftonline.com/${tenant}/v2.0`;
    const promise = oidc.discovery(new URL(issuer), id, secret).then((configuration) => { oidc.enableNonRepudiationChecks(configuration); return configuration; }).catch((error) => { configurations.delete(provider); throw error; });
    configurations.set(provider, promise);
  }
  return configurations.get(provider)!;
}
export function oauthCookie(value: string, maxAge = 600): string {
  return `ar_oidc=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export function oauthCallbackUrl(provider: OAuthProvider): URL { return new URL(`/api/v1/auth/oauth/${provider}/callback`, process.env.APP_URL ?? "http://localhost:3000"); }
export async function startOAuth(provider: OAuthProvider, account?: Pick<Flow, "userId" | "businessId" | "credentialVersion">) {
  const configuration = await oauthConfiguration(provider);
  const state = oidc.randomState(), verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce();
  await redisSet(`oauth:flow:${state}`, JSON.stringify({ provider, verifier, nonce, ...account } satisfies Flow), 600);
  const url = oidc.buildAuthorizationUrl(configuration, { redirect_uri: oauthCallbackUrl(provider).href,
    scope: "openid email profile", state, nonce, code_challenge_method: "S256", code_challenge: await oidc.calculatePKCECodeChallenge(verifier) });
  return { url: url.href, cookie: oauthCookie(state) };
}
export async function finishOAuth(provider: OAuthProvider, callback: URL, cookie: string | null) {
  const state = callback.searchParams.get("state");
  if (!state || !cookie || !safeEqual(state, cookie)) throw new AppError(401, "UNAUTHORIZED", "OAuth state mismatch");
  const value = await redisGet(`oauth:flow:${state}`);
  if (!value || !(await setNx(`oauth:consumed:${state}`, "1", 600))) throw new AppError(401, "UNAUTHORIZED", "OAuth flow expired or consumed");
  await redisDel(`oauth:flow:${state}`);
  const flow = JSON.parse(value) as Flow;
  if (flow.provider !== provider) throw new AppError(401, "UNAUTHORIZED", "OAuth provider mismatch");
  const tokens = await oidc.authorizationCodeGrant(await oauthConfiguration(provider), callback,
    { pkceCodeVerifier: flow.verifier, expectedState: state, expectedNonce: flow.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims?.sub || !claims.iss) throw new AppError(401, "UNAUTHORIZED", "Valid identity token required");
  return { flow, subject: claims.sub, issuer: claims.iss };
}
