import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { POST as transition } from "@/app/api/items/[id]/transition/route";
import { POST as claim } from "@/app/api/items/[id]/claim/route";
import { PATCH } from "@/app/api/items/[id]/route";
import { call, makeItem, resetDb, setupTeams, type TestUser } from "./helpers";

describe("workflow rules", () => {
  let t: Awaited<ReturnType<typeof setupTeams>>;
  beforeEach(async () => {
    await resetDb();
    t = await setupTeams();
  });

  const move = (user: TestUser, id: string, to: string, version: number) =>
    call(transition, { method: "POST", token: user.token, params: { id }, body: { to, version } });

  /** Creates an item claimed by `member` and moved to AWAITING_APPROVAL (version 4). */
  async function itemAwaitingApproval() {
    const item = await makeItem(t.member, t.ops.id);
    await call(claim, { method: "POST", token: t.member.token, params: { id: item.id } });
    expect((await move(t.member, item.id, "IN_PROGRESS", 2)).status).toBe(200);
    expect((await move(t.member, item.id, "AWAITING_APPROVAL", 3)).status).toBe(200);
    return item;
  }

  it("rejects an invalid jump (OPEN -> CLOSED) with 422 and lists allowed moves", async () => {
    const item = await makeItem(t.member, t.ops.id);
    const res = await move(t.lead, item.id, "CLOSED", 1);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("INVALID_TRANSITION");
    expect(res.body.error.details.allowed).toEqual(["IN_PROGRESS"]);
    const saved = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(saved.status).toBe("OPEN");
  });

  it("requires an assignee before work starts", async () => {
    const item = await makeItem(t.member, t.ops.id);
    const res = await move(t.member, item.id, "IN_PROGRESS", 1);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("ASSIGNEE_REQUIRED");
  });

  it("does not let a MEMBER approve", async () => {
    const item = await itemAwaitingApproval();
    const res = await move(t.member, item.id, "RESOLVED", 4);

    expect(res.status).toBe(403);
    const saved = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(saved.status).toBe("AWAITING_APPROVAL");
  });

  it("lets a LEAD approve and an ADMIN reject", async () => {
    const approved = await itemAwaitingApproval();
    const ok = await move(t.lead, approved.id, "RESOLVED", 4);
    expect(ok.status).toBe(200);
    expect(ok.body.item.status).toBe("RESOLVED");

    const rejected = await itemAwaitingApproval();
    const back = await move(t.admin, rejected.id, "IN_PROGRESS", 4);
    expect(back.status).toBe(200);
    expect(back.body.item.status).toBe("IN_PROGRESS");
  });

  it("does not let a MEMBER reject either (rejecting is part of approval)", async () => {
    const item = await itemAwaitingApproval();
    expect((await move(t.member2, item.id, "IN_PROGRESS", 4)).status).toBe(403);
  });

  it("returns 409 for a transition based on a stale version", async () => {
    const item = await itemAwaitingApproval();
    const res = await move(t.lead, item.id, "RESOLVED", 3);
    expect(res.status).toBe(409);
    expect(res.body.error.details.latest.status).toBe("AWAITING_APPROVAL");
  });

  it("records every state change in history and blocks edits once CLOSED", async () => {
    const item = await itemAwaitingApproval();
    await move(t.lead, item.id, "RESOLVED", 4);
    expect((await move(t.member, item.id, "CLOSED", 5)).status).toBe(200);

    const changes = await prisma.activityEvent.findMany({
      where: { itemId: item.id, type: "STATE_CHANGED" },
      orderBy: { createdAt: "asc" },
    });
    expect(changes.map((e) => (e.to as { status: string }).status)).toEqual([
      "IN_PROGRESS",
      "AWAITING_APPROVAL",
      "RESOLVED",
      "CLOSED",
    ]);

    const edit = await call(PATCH, {
      method: "PATCH",
      token: t.lead.token,
      params: { id: item.id },
      body: { version: 6, title: "Too late" },
    });
    expect(edit.status).toBe(422);
    expect(edit.body.error.code).toBe("ITEM_CLOSED");
  });
});
