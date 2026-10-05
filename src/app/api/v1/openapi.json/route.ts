import { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

/**
 * OpenAPI 3.1 description of the public API surface.
 *
 * The document is generated from the route inventory below (kept in sync by
 * `tests/unit/openapi.test.ts`, which fails when a documented path no longer
 * exists on disk) and is intentionally description-only: it never leaks
 * internal schemas beyond request/response shapes.
 */
const SECURITY = [{ bearerAuth: [] }];
const PAGINATED = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    data: { type: "array", items: { type: "object" } },
    nextCursor: { type: ["string", "null"] },
    hasMore: { type: "boolean" },
  },
} as const;
const ERROR = {
  type: "object",
  properties: {
    success: { type: "boolean", enum: [false] },
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: "string" },
      },
      required: ["code", "message", "requestId"],
    },
  },
  required: ["success", "error"],
} as const;

function list(description: string) {
  return { get: { summary: description, security: SECURITY, responses: { "200": { description: "OK", content: { "application/json": { schema: PAGINATED } } }, "401": { description: "Unauthorized", content: { "application/json": { schema: ERROR } } } } } };
}

function mutation(description: string, status = "201") {
  return {
    post: {
      summary: description,
      security: SECURITY,
      requestBody: { required: false, content: { "application/json": { schema: { type: "object" } } } },
      responses: {
        [status]: { description: "Created/updated", content: { "application/json": { schema: { type: "object" } } } },
        "400": { description: "Validation error", content: { "application/json": { schema: ERROR } } },
        "403": { description: "Forbidden", content: { "application/json": { schema: ERROR } } },
      },
    },
  };
}

/** Paths that must exist as files for the document to be considered truthful. */
export const DOCUMENTED_ROUTES: Array<{ path: string; file: string }> = [
  { path: "/api/health/live", file: "src/app/api/health/live/route.ts" },
  { path: "/api/health/ready", file: "src/app/api/health/ready/route.ts" },
  { path: "/api/metrics", file: "src/app/api/metrics/route.ts" },
  { path: "/api/v1/calls", file: "src/app/api/v1/calls/route.ts" },
  { path: "/api/v1/leads", file: "src/app/api/v1/leads/route.ts" },
  { path: "/api/v1/customers", file: "src/app/api/v1/customers/route.ts" },
  { path: "/api/v1/appointments", file: "src/app/api/v1/appointments/route.ts" },
  { path: "/api/v1/agents", file: "src/app/api/v1/agents/route.ts" },
  { path: "/api/v1/knowledge", file: "src/app/api/v1/knowledge/route.ts" },
  { path: "/api/v1/knowledge/search", file: "src/app/api/v1/knowledge/search/route.ts" },
  { path: "/api/v1/properties", file: "src/app/api/v1/properties/route.ts" },
  { path: "/api/v1/billing", file: "src/app/api/v1/billing/route.ts" },
  { path: "/api/v1/billing/checkout", file: "src/app/api/v1/billing/checkout/route.ts" },
  { path: "/api/v1/billing/ledger", file: "src/app/api/v1/billing/ledger/route.ts" },
  { path: "/api/v1/billing/quotas", file: "src/app/api/v1/billing/quotas/route.ts" },
  { path: "/api/v1/usage", file: "src/app/api/v1/usage/route.ts" },
  { path: "/api/v1/admin/roles", file: "src/app/api/v1/admin/roles/route.ts" },
  { path: "/api/v1/admin/api-keys", file: "src/app/api/v1/admin/api-keys/route.ts" },
  { path: "/api/v1/admin/service-accounts", file: "src/app/api/v1/admin/service-accounts/route.ts" },
  { path: "/api/v1/admin/invitations", file: "src/app/api/v1/admin/invitations/route.ts" },
  { path: "/api/v1/admin/webhooks", file: "src/app/api/v1/admin/webhooks/route.ts" },
  { path: "/api/v1/admin/webhooks/deliveries", file: "src/app/api/v1/admin/webhooks/deliveries/route.ts" },
  { path: "/api/v1/admin/exports", file: "src/app/api/v1/admin/exports/route.ts" },
  { path: "/api/v1/admin/privacy", file: "src/app/api/v1/admin/privacy/route.ts" },
  { path: "/api/v1/auth/invitations/accept", file: "src/app/api/v1/auth/invitations/accept/route.ts" },
  { path: "/api/v1/platform/tenants", file: "src/app/api/v1/platform/tenants/route.ts" },
  { path: "/api/v1/platform/tenants/deletion", file: "src/app/api/v1/platform/tenants/deletion/route.ts" },
  { path: "/api/v1/platform/billing", file: "src/app/api/v1/platform/billing/route.ts" },
  { path: "/api/v1/platform/billing/refunds", file: "src/app/api/v1/platform/billing/refunds/route.ts" },
  { path: "/api/v1/platform/billing/credit-notes", file: "src/app/api/v1/platform/billing/credit-notes/route.ts" },
  { path: "/api/v1/platform/billing/providers", file: "src/app/api/v1/platform/billing/providers/route.ts" },
  { path: "/api/v1/platform/support-sessions", file: "src/app/api/v1/platform/support-sessions/route.ts" },
  { path: "/api/v1/platform/webhooks-health", file: "src/app/api/v1/platform/webhooks-health/route.ts" },
  { path: "/api/v1/webhooks/voice/inbound", file: "src/app/api/v1/webhooks/voice/inbound/route.ts" },
  { path: "/api/v1/webhooks/voice/call-ended", file: "src/app/api/v1/webhooks/voice/call-ended/route.ts" },
  { path: "/api/v1/webhooks/voice/call-started", file: "src/app/api/v1/webhooks/voice/call-started/route.ts" },
  { path: "/api/v1/webhooks/payments/{provider}", file: "src/app/api/v1/webhooks/payments/[provider]/route.ts" },
];

export function buildOpenApiDocument(baseUrl: string) {
  const paths: Record<string, unknown> = {
    "/api/health/live": { get: { summary: "Liveness probe", responses: { "200": { description: "live" } } } },
    "/api/health/ready": { get: { summary: "Readiness probe (DB, Redis, migrations, storage)", responses: { "200": { description: "ready" }, "503": { description: "not ready" } } } },
    "/api/metrics": { get: { summary: "Prometheus metrics (bearer METRICS_TOKEN)", responses: { "200": { description: "metrics" }, "401": { description: "unauthorized" } } } },
    "/api/v1/calls": list("List calls (cursor pagination)"),
    "/api/v1/leads": list("List leads"),
    "/api/v1/customers": list("List customers"),
    "/api/v1/appointments": list("List appointments"),
    "/api/v1/agents": list("List agents"),
    "/api/v1/knowledge": list("List knowledge documents"),
    "/api/v1/knowledge/search": mutation("Governed knowledge search (ACL + lifecycle + optional rerank)", "200"),
    "/api/v1/properties": list("List properties"),
    "/api/v1/billing": { get: { summary: "Subscription + invoices", security: SECURITY, responses: { "200": { description: "OK" } } }, ...mutation("Request a manual invoice") },
    "/api/v1/billing/checkout": mutation("Start a provider checkout"),
    "/api/v1/billing/ledger": list("Billing ledger (charges, refunds, credit notes, subscription events)"),
    "/api/v1/billing/quotas": { get: { summary: "Quota usage and limits", security: SECURITY, responses: { "200": { description: "OK" } } } },
    "/api/v1/usage": list("Usage records"),
    "/api/v1/admin/roles": { ...list("Custom roles"), ...mutation("Create a custom role") },
    "/api/v1/admin/api-keys": { ...list("API keys (hash-only)"), ...mutation("Create an API key") },
    "/api/v1/admin/service-accounts": { ...list("Service accounts"), ...mutation("Create a service account") },
    "/api/v1/admin/invitations": { ...list("Invitations"), ...mutation("Invite a teammate") },
    "/api/v1/admin/webhooks": { ...list("Outbound webhook endpoints"), ...mutation("Create an endpoint") },
    "/api/v1/admin/webhooks/deliveries": list("Webhook delivery log"),
    "/api/v1/admin/exports": { ...list("Data exports"), ...mutation("Request a tenant data export") },
    "/api/v1/admin/privacy": { get: { summary: "Data inventory + retention policy", security: SECURITY, responses: { "200": { description: "OK" } } } },
    "/api/v1/auth/invitations/accept": mutation("Accept an invitation"),
    "/api/v1/platform/tenants": list("Platform tenant inventory"),
    "/api/v1/platform/tenants/deletion": { ...list("Tenants due for purge"), ...mutation("Request tenant deletion") },
    "/api/v1/platform/billing": { get: { summary: "Manual invoice queue", security: SECURITY, responses: { "200": { description: "OK" } } }, ...mutation("Record a manual payment", "200") },
    "/api/v1/platform/billing/refunds": mutation("Refund a captured charge"),
    "/api/v1/platform/billing/credit-notes": mutation("Issue a credit note"),
    "/api/v1/platform/billing/providers": { get: { summary: "Payment provider capabilities", security: SECURITY, responses: { "200": { description: "OK" } } } },
    "/api/v1/platform/support-sessions": mutation("Start a read-only support session"),
    "/api/v1/platform/webhooks-health": { get: { summary: "Outbox + webhook delivery health", security: SECURITY, responses: { "200": { description: "OK" } } } },
    "/api/v1/webhooks/voice/inbound": { post: { summary: "Telephony inbound call webhook (provider signature verified)", responses: { "200": { description: "TwiML" }, "401": { description: "bad signature" } } } },
    "/api/v1/webhooks/voice/call-ended": { post: { summary: "Signed call-ended lifecycle (usage settlement)", responses: { "200": { description: "settled" } } } },
    "/api/v1/webhooks/voice/call-started": { post: { summary: "Signed call-started lifecycle", responses: { "200": { description: "admitted" } } } },
    "/api/v1/webhooks/payments/{provider}": { post: { summary: "Payment provider webhook (signature verified, replay protected)", responses: { "200": { description: "processed" }, "401": { description: "bad signature" } } } },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "AI Receptionist API",
      version: "0.2.0",
      description:
        "Multi-tenant AI receptionist platform API. Tenant endpoints require a bearer JWT or a tenant API key; platform endpoints require SUPER_ADMIN with MFA. Errors always use { success: false, error: { code, message, requestId } }.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        apiKey: { type: "http", scheme: "bearer", description: "Tenant API key: ar_live_<prefix>_<secret>" },
      },
      schemas: { Paginated: PAGINATED, Error: ERROR },
    },
    paths,
  };
}

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const url = new URL(req.url);
    return ok(buildOpenApiDocument(`${url.protocol}//${url.host}`));
  });
}
