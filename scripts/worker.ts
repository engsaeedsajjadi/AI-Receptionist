import "dotenv/config";
import { closeDb } from "../src/db";
import { closeRedis } from "../src/lib/redis";
import { processNextJob } from "../src/lib/services/jobs";
import { logError } from "../src/lib/logger";
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
async function main() {
  while (!stopping) {
    try { if (await processNextJob()) continue; }
    catch (error) { logError("Automation worker error", { error }); }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await closeRedis(); await closeDb();
}
void main();
