import type { NextConfig } from "next";

/**
 * Content-Security-Policy notes
 * -----------------------------
 * Next.js injects inline bootstrap scripts, so `script-src` must allow
 * 'unsafe-inline' (a nonce pipeline would require middleware that rewrites every
 * document). Everything else is locked down: no external script/frame/object
 * origins, no cross-origin form targets, and `connect-src 'self'` so a stolen
 * token cannot be exfiltrated to a third-party origin from the browser.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  /**
   * Dev-server origin allowlist. The app is developed behind the sandbox/preview
   * proxy, so cross-origin requests for `/_next/*` from the preview host must be
   * accepted instead of rejected (which would break the live preview).
   */
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS ?? "*.e2b.app,localhost,127.0.0.1")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  async headers() {
    return [
      {
        // Baseline hardening for pages + API.
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
      {
        // Never let a proxy or browser cache tenant data or credentials.
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
    ];
  },
};

export default nextConfig;
