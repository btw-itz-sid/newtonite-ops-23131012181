import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { PATCH } from "@/app/api/items/[id]/route";
import { claimItem, transitionItem } from "@/server/services/items.service";
import { handlers } from "@/worker/handlers";
import { backoffMs, claimJobs, processBatch, runJob, type Handlers } from "@/worker/process";
import { call, makeItem, resetDb, setupTeams } from "./helpers";

describe("transactional outbox + worker", () => {
  let t: Awaited<ReturnType<typeof setupTeams>>;
  beforeEach(async () => {
    await resetDb();
    t = await setupTeams();
  });

  const reassign = (version: number, itemId: string, assigneeId: string) =>
    call(PATCH, { method: "PATCH", token: t.lead.token, params: { id: itemId }, body: { version, assigneeId } });

  it("writes the job in the same transaction as the change", async () => {
    const item = await makeItem(t.member, t.ops.id);
    expect((await reassign(1, item.id, t.member2.auth.id)).status).toBe(200);
    const jobs = await prisma.outboxJob.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: "NOTIFY_ASSIGNEE", status: "PENDING" });

    // A rejected (stale) change leaves no job behind
    expect((await reassign(1, item.id, t.member.auth.id)).status).toBe(409);
    expect(await prisma.outboxJob.count()).toBe(1);
  });

  it("processing the same job twice produces one notification", async () => {
    const item = await makeItem(t.member, t.ops.id);
    await reassign(1, item.id, t.member2.auth.id);

    const [job] = await claimJobs();
    await runJob(job, handlers);
    await runJob(job, handlers); // e.g. worker crashed before marking DONE and the job ran again

    const notifications = await prisma.notification.findMany();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe(t.member2.auth.id);
    expect((await prisma.outboxJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("DONE");
  });

  it("retries a failing job with backoff, then marks it FAILED after maxAttempts", async () => {
    const job = await prisma.outboxJob.create({
      data: {
        type: "NOTIFY_ASSIGNEE",
        payload: { itemId: "x", teamId: "x", message: "m" },
        dedupeKey: "always-fails",
        maxAttempts: 3,
      },
    });
    const failing: Handlers = {
      NOTIFY_ASSIGNEE: async () => {
        throw new Error("SMTP down");
      },
      NOTIFY_APPROVERS: async () => {},
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = Date.now();
      expect(await processBatch(failing)).toBe(1);
      const saved = await prisma.outboxJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(saved.attempts).toBe(attempt);
      expect(saved.lastError).toBe("SMTP down");

      if (attempt < 3) {
        expect(saved.status).toBe("PENDING");
        expect(saved.nextRunAt.getTime()).toBeGreaterThanOrEqual(before + backoffMs(attempt) - 50);
        expect(await processBatch(failing)).toBe(0); // not due yet: backoff is respected
        await prisma.outboxJob.update({ where: { id: job.id }, data: { nextRunAt: new Date() } }); // skip the wait
      } else {
        expect(saved.status).toBe("FAILED");
      }
    }
    expect(await processBatch(failing)).toBe(0); // FAILED jobs are never picked up again
  });

  it("backoff doubles and is capped", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffMs(30)).toBe(5 * 60_000);
  });

  it("two workers claiming at the same time never get the same job (SKIP LOCKED)", async () => {
    await prisma.outboxJob.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        type: "NOTIFY_APPROVERS" as const,
        payload: { itemId: "x", teamId: t.ops.id, message: "m" },
        dedupeKey: `job-${i}`,
      })),
    });

    const [a, b] = await Promise.all([claimJobs(10), claimJobs(10)]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("notifies the team's leads when an item needs approval", async () => {
    const item = await makeItem(t.member, t.ops.id);
    await prisma.$transaction(async (tx) => {
      await claimItem(tx, t.member.auth, item.id);
      await transitionItem(tx, t.member.auth, item.id, { to: "IN_PROGRESS", version: 2 });
      await transitionItem(tx, t.member.auth, item.id, { to: "AWAITING_APPROVAL", version: 3 });
    });
    await processBatch(handlers);

    const recipients = (await prisma.notification.findMany()).map((n) => n.userId).sort();
    expect(recipients).toEqual([t.admin.auth.id, t.lead.auth.id].sort());
  });
});
