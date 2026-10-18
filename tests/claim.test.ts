import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { POST as claim } from "@/app/api/items/[id]/claim/route";
import { call, makeItem, resetDb, setupTeams } from "./helpers";

describe("atomic claim", () => {
  let t: Awaited<ReturnType<typeof setupTeams>>;
  beforeEach(async () => {
    await resetDb();
    t = await setupTeams();
  });

  it("lets exactly one of several parallel claims win", async () => {
    const item = await makeItem(t.member, t.ops.id);
    const claimers = [t.member, t.member2, t.lead, t.admin];

    const results = await Promise.all(
      claimers.map((u) => call(claim, { method: "POST", token: u.token, params: { id: item.id } })),
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.error.code).toBe("ALREADY_CLAIMED");

    const winner = results.find((r) => r.status === 200)!;
    const saved = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(saved.assigneeId).toBe(winner.body.item.assigneeId);
    expect(saved.version).toBe(2);

    // Exactly one history row for the one successful claim
    const events = await prisma.activityEvent.count({ where: { itemId: item.id, type: "ASSIGNEE_CHANGED" } });
    expect(events).toBe(1);
  });

  it("rejects claiming an already assigned item with 409 and the current item", async () => {
    const item = await makeItem(t.member, t.ops.id);
    await call(claim, { method: "POST", token: t.member.token, params: { id: item.id } });

    const res = await call(claim, { method: "POST", token: t.member2.token, params: { id: item.id } });
    expect(res.status).toBe(409);
    expect(res.body.error.details.latest.assigneeId).toBe(t.member.auth.id);
  });

  it("does not let a VIEWER claim", async () => {
    const item = await makeItem(t.member, t.ops.id);
    const res = await call(claim, { method: "POST", token: t.viewer.token, params: { id: item.id } });
    expect(res.status).toBe(403);
  });
});
