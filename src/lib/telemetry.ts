import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
const globals = globalThis as typeof globalThis & { receptionistTelemetry?: ReturnType<typeof createMetrics>; receptionistOtel?: NodeSDK };
function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "receptionist_" });
  const requests = new Counter({ name: "receptionist_api_requests_total", help: "Completed API requests", labelNames: ["status_class"], registers: [registry] });
  const duration = new Histogram({ name: "receptionist_api_duration_seconds", help: "API handler duration", buckets: [0.05, 0.1, 0.5, 1, 2, 5, 15, 60], registers: [registry] });
  const quotaRejections = new Counter({ name: "receptionist_quota_rejections_total", help: "Rejected quota admissions", labelNames: ["meter"], registers: [registry] });
  return { registry, requests, duration, quotaRejections };
}
export function metrics() { return globals.receptionistTelemetry ??= createMetrics(); }
export function startTelemetry() {
  metrics();
  if (!process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || globals.receptionistOtel) return;
  const sdk = new NodeSDK({ serviceName: "ai-receptionist", traceExporter: new OTLPTraceExporter() });
  sdk.start(); globals.receptionistOtel = sdk;
  process.once("SIGTERM", () => { void sdk.shutdown(); });
}
