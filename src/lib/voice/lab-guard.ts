import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { AppError } from "@/lib/errors";

/**
 * DEVELOPER LAB ONLY — never a production endpoint.
 * The database must be local and explicitly disposable, so a UI test cannot
 * write AI usage, transcripts or bookings into an operational database.
 */
export function assertIsolatedLab(): void {
  if (process.env.NODE_ENV !== "development") {
    throw new AppError(404, "NOT_FOUND", "Local telephone lab is disabled");
  }
  let url: URL;
  try {
    url = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    throw new AppError(503, "DEPENDENCY_UNAVAILABLE", "Isolated test database is not configured");
  }
  if (!["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.pathname.endsWith("/ai_receptionist_test") ||
      (process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL !== url.toString())) {
    throw new AppError(403, "FORBIDDEN", "Local telephone lab requires localhost/ai_receptionist_test, never the original database");
  }
}

/** The tenant's active agent, or 404 (never another tenant's). */
export async function requireLabAgent(businessId: string, agentId: string): Promise<{ id: string }> {
  const [agent] = await db.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.businessId, businessId), eq(agents.isActive, true))).limit(1);
  if (!agent) throw new AppError(404, "AGENT_NOT_FOUND", "Active agent not found for this tenant");
  return agent;
}
