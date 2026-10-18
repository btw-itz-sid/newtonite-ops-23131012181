// Job handlers. Each one must be safe to run more than once for the same job.
// Idempotency comes from Notification.dedupeKey (unique): we derive it from the job's dedupeKey
// and the recipient, and insert with skipDuplicates, so a second run inserts nothing.
import type { OutboxJob } from "@prisma/client";
import { prisma } from "../server/db";
import type { NotifyPayload } from "../server/outbox";
import type { Handlers } from "./process";

async function notify(job: OutboxJob, userIds: string[]) {
  const payload = job.payload as NotifyPayload;
  await prisma.notification.createMany({
    data: userIds.map((userId) => ({
      userId,
      itemId: payload.itemId,
      message: payload.message,
      dedupeKey: `${job.dedupeKey}:${userId}`,
    })),
    skipDuplicates: true,
  });
}

export const handlers: Handlers = {
  NOTIFY_ASSIGNEE: async (job) => {
    const payload = job.payload as NotifyPayload;
    if (!payload.userId) throw new Error("NOTIFY_ASSIGNEE job without userId");
    await notify(job, [payload.userId]);
  },

  // Recipients are looked up when the job runs, so a lead added in the meantime is included.
  NOTIFY_APPROVERS: async (job) => {
    const payload = job.payload as NotifyPayload;
    const approvers = await prisma.membership.findMany({
      where: { teamId: payload.teamId, role: { in: ["LEAD", "ADMIN"] } },
      select: { userId: true },
    });
    await notify(
      job,
      approvers.map((a) => a.userId),
    );
  },
};
