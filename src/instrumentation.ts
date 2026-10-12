/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Validates env (fail fast) and initializes monitoring.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv } = await import("@/lib/env");
    // Fail fast on invalid production configuration.
    getEnv();
    const { startTelemetry } = await import("@/lib/telemetry");
    startTelemetry();
    const { initMonitoring } = await import("@/lib/monitoring");
    await initMonitoring();
  }
}
