// Outbox processing: claim due jobs, run their handler, then mark DONE or schedule a retry.
// Delivery is "at least once": a job can run twice (e.g. the worker crashes after the handler
// but before marking DONE), which is why every handler must be idempotent (see handlers.ts).
import type { JobType, OutboxJob } from "@prisma/client";
import { prisma } from "../server/db";

export type JobHandler = (job: OutboxJob) => Promise<void>;
export type Handlers = Record<JobType, JobHandler>;

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60_000;
/** A job PROCESSING for longer than this is assumed to belong to a crashed worker. */
const STALE_LOCK = "5 minutes";

/** 1s, 2s, 4s, 8s ... capped at 5 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS);
}

/**
 * Atomically claims up to `limit` due jobs and marks them PROCESSING.
 * FOR UPDATE SKIP LOCKED: rows already locked by another worker are skipped instead of waited on,
 * so several workers can poll the same table without ever picking the same job.
 */
export async function claimJobs(limit = 10): Promise<OutboxJob[]> {
  return prisma.$queryRaw<OutboxJob[]>`
    UPDATE "OutboxJob"
    SET "status" = 'PROCESSING', "lockedAt" = now(), "attempts" = "attempts" + 1
    WHERE "id" IN (
      SELECT "id" FROM "OutboxJob"
      WHERE ("status" = 'PENDING' AND "nextRunAt" <= now())
         OR ("status" = 'PROCESSING' AND "lockedAt" < now() - ${STALE_LOCK}::interval)
      ORDER BY "nextRunAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
}

export async function runJob(job: OutboxJob, handlers: Handlers): Promise<void> {
  try {
    if (job.attempts > job.maxAttempts) throw new Error("Exceeded max attempts (worker crashed mid-job)");
    await handlers[job.type](job);
    await prisma.outboxJob.update({
      where: { id: job.id },
      data: { status: "DONE", processedAt: new Date(), lockedAt: null, lastError: null },
    });
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err);
    const giveUp = job.attempts >= job.maxAttempts;
    await prisma.outboxJob.update({
      where: { id: job.id },
      data: giveUp
        ? { status: "FAILED", lockedAt: null, lastError }
        : {
            status: "PENDING",
            lockedAt: null,
            lastError,
            nextRunAt: new Date(Date.now() + backoffMs(job.attempts)),
          },
    });
  }
}

/** One polling round. Returns how many jobs were claimed. */
export async function processBatch(handlers: Handlers, limit = 10): Promise<number> {
  const jobs = await claimJobs(limit);
  for (const job of jobs) await runJob(job, handlers);
  return jobs.length;
}
