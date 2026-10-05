import "dotenv/config";
import { closeDb } from "../src/db";
import { closeRedis } from "../src/lib/redis";
import { processNextJob } from "../src/lib/services/jobs";
import { registerDefaultOutboxHandlers } from "../src/lib/services/outbox-handlers";
import { logError } from "../src/lib/logger";
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
async function main() {
  // Outbox side effects (tenant webhooks, queued notifications) are only wired
  // when the worker runs; the API process never delivers them inline.
  registerDefaultOutboxHandlers();
  while (!stopping) {
    try { if (await processNextJob()) continue; }
    catch (error) { logError("Automation worker error", { error }); }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await closeRedis(); await closeDb();
}
void main();
