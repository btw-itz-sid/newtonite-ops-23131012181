import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { POST as createItem } from "@/app/api/items/route";
import { POST as transition } from "@/app/api/items/[id]/transition/route";
import { POST as claim } from "@/app/api/items/[id]/claim/route";
import { call, makeItem, resetDb, setupTeams } from "./helpers";

describe("Idempotency-Key", () => {
  let t: Awaited<ReturnType<typeof setupTeams>>;
  beforeEach(async () => {
    await resetDb();
    t = await setupTeams();
  });

  const create = (token: string, key: string | null, body: object) =>
    call(createItem, {
      method: "POST",
      path: "/api/items",
      token,
      body,
      headers: key ? { "Idempotency-Key": key } : {},
    });

  it("same key sent twice creates one item and returns the same response", async () => {
    const body = { teamId: t.ops.id, title: "Refund stuck", type: "PAYMENT", priority: "HIGH" };

    const first = await create(t.member.token, "key-1", body);
    const second = await create(t.member.token, "key-1", body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await prisma.workItem.count()).toBe(1);
    expect(await prisma.activityEvent.count({ where: { type: "CREATED" } })).toBe(1);
  });

  it("same key sent in parallel still creates exactly one item", async () => {
    const body = { teamId: t.ops.id, title: "Double click", type: "TASK" };

    const results = await Promise.all(Array.from({ length: 5 }, () => create(t.member.token, "key-par", body)));

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.item.id)).size).toBe(1);
    expect(await prisma.workItem.count()).toBe(1);
  });

  it("same key with a different payload is rejected with 422", async () => {
    await create(t.member.token, "key-2", { teamId: t.ops.id, title: "One", type: "TASK" });
    const res = await create(t.member.token, "key-2", { teamId: t.ops.id, title: "Two", type: "TASK" });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await prisma.workItem.count()).toBe(1);
  });

  it("keys are per user, and requests without a key are not deduplicated", async () => {
    const body = { teamId: t.ops.id, title: "Same", type: "TASK" };
    await create(t.member.token, "shared-key", body);
    await create(t.member2.token, "shared-key", body);
    await create(t.member.token, null, body);
    await create(t.member.token, null, body);
    expect(await prisma.workItem.count()).toBe(4);
  });

  it("a failed request does not burn the key", async () => {
    const body = { teamId: t.ops.id, title: "Viewer try", type: "TASK" };
    const denied = await create(t.viewer.token, "key-3", body);
    expect(denied.status).toBe(403);
    expect(await prisma.idempotencyKey.count()).toBe(0);
  });

  it("replays a transition instead of applying it twice", async () => {
    const item = await makeItem(t.member, t.ops.id);
    await call(claim, { method: "POST", token: t.member.token, params: { id: item.id } });

    const send = () =>
      call(transition, {
        method: "POST",
        token: t.member.token,
        params: { id: item.id },
        body: { to: "IN_PROGRESS", version: 2 },
        headers: { "Idempotency-Key": "move-1" },
      });
    const first = await send();
    const retry = await send(); // without the key this would be a 409 (version is now 3)

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(await prisma.activityEvent.count({ where: { itemId: item.id, type: "STATE_CHANGED" } })).toBe(1);
  });
});
