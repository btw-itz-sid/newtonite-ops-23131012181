// Transactional outbox: enqueue a background job as part of the business transaction.
//
// Why: if we committed the item change and THEN tried to send the notification, a crash in
// between would lose it; if we sent first and the transaction rolled back, we'd notify about
// something that never happened. Writing the job row in the SAME transaction means the job
// exists if and only if the change committed. The worker (src/worker) delivers it later.
import type { JobType, Prisma } from "@prisma/client";
import type { Tx } from "./db";

export type NotifyPayload = { itemId: string; teamId: string; message: string; userId?: string };

/** Always pass the transaction client `tx`, never the global prisma client. */
export async function enqueueJob(
  tx: Tx,
  job: { type: JobType; payload: NotifyPayload; dedupeKey: string },
): Promise<void> {
  // skipDuplicates = ON CONFLICT DO NOTHING on dedupeKey: enqueueing the same job twice is a no-op
  // instead of an error that would abort the whole business transaction.
  await tx.outboxJob.createMany({
    data: [{ type: job.type, payload: job.payload as Prisma.InputJsonValue, dedupeKey: job.dedupeKey }],
    skipDuplicates: true,
  });
}
