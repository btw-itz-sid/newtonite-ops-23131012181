import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { PATCH } from "@/app/api/items/[id]/route";
import { call, makeItem, resetDb, setupTeams } from "./helpers";

describe("optimistic locking on PATCH", () => {
  let t: Awaited<ReturnType<typeof setupTeams>>;
  beforeEach(async () => {
    await resetDb();
    t = await setupTeams();
  });

  const patch = (token: string, id: string, body: object) =>
    call(PATCH, { method: "PATCH", token, params: { id }, body });

  it("rejects a stale version with 409, returns the latest item and leaves data unchanged", async () => {
    const item = await makeItem(t.member, t.ops.id, { title: "Original" });

    const first = await patch(t.member.token, item.id, { version: 1, title: "First edit" });
    expect(first.status).toBe(200);
    expect(first.body.item.version).toBe(2);

    // Second user still holds version 1
    const stale = await patch(t.member2.token, item.id, { version: 1, title: "Stale edit" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    expect(stale.body.error.details.latest.title).toBe("First edit");
    expect(stale.body.error.details.latest.version).toBe(2);

    const saved = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(saved.title).toBe("First edit");
    expect(saved.version).toBe(2);
    // Only CREATED + one EDITED: the rejected update left no history
    expect(await prisma.activityEvent.count({ where: { itemId: item.id } })).toBe(2);
  });

  it("lets only one of two concurrent updates with the same version succeed", async () => {
    const item = await makeItem(t.member, t.ops.id);

    const results = await Promise.all([
      patch(t.member.token, item.id, { version: 1, title: "A" }),
      patch(t.member2.token, item.id, { version: 1, title: "B" }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!;
    const saved = await prisma.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(saved.title).toBe(winner.body.item.title);
    expect(saved.version).toBe(2);
  });

  it("requires a version", async () => {
    const item = await makeItem(t.member, t.ops.id);
    const res = await patch(t.member.token, item.id, { title: "No version" });
    expect(res.status).toBe(400);
  });

  it("writes one history event per kind of change, in the same transaction", async () => {
    const item = await makeItem(t.member, t.ops.id);
    const res = await patch(t.lead.token, item.id, {
      version: 1,
      title: "Renamed",
      priority: "URGENT",
      assigneeId: t.member2.auth.id,
    });
    expect(res.status).toBe(200);

    const events = await prisma.activityEvent.findMany({ where: { itemId: item.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.type).sort()).toEqual(["ASSIGNEE_CHANGED", "CREATED", "EDITED", "PRIORITY_CHANGED"]);
    const priority = events.find((e) => e.type === "PRIORITY_CHANGED")!;
    expect(priority.from).toEqual({ priority: "MEDIUM" });
    expect(priority.to).toEqual({ priority: "URGENT" });
  });
});
