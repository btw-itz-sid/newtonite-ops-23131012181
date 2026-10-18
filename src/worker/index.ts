// Worker process: `npm run worker` (separate from the web app).
// Polls the outbox table; sleeps only when there was nothing to do.
import { prisma } from "../server/db";
import { handlers } from "./handlers";
import { processBatch } from "./process";

const POLL_INTERVAL_MS = 1_000;
let stopping = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("Worker started, polling the outbox...");
  while (!stopping) {
    try {
      const processed = await processBatch(handlers);
      if (processed > 0) console.log(`Processed ${processed} job(s)`);
      else await sleep(POLL_INTERVAL_MS);
    } catch (err) {
      console.error("Worker loop error (will retry):", err);
      await sleep(POLL_INTERVAL_MS);
    }
  }
  await prisma.$disconnect();
  console.log("Worker stopped");
}

// Finish the current batch before exiting (docker compose stop sends SIGTERM).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

main();
