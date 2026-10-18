import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { GET as listItems } from "@/app/api/items/route";
import { GET as activity } from "@/app/api/items/[id]/activity/route";
import { POST as comment } from "@/app/api/items/[id]/comments/route";
import { call, makeItem, resetDb, setupTeams } from "./helpers";

describe("activity history", () => {
  let t: Awaited<ReturnType<typeof setupTeams>>;
  beforeEach(async () => {
    await resetDb();
    t = await setupTeams();
  });

  it("is append-only: the database refuses UPDATE and DELETE", async () => {
    const item = await makeItem(t.member, t.ops.id);
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "ActivityEvent" SET "type" = 'EDITED' WHERE "itemId" = '${item.id}'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "ActivityEvent" WHERE "itemId" = '${item.id}'`),
    ).rejects.toThrow(/append-only/);
  });

  it("records comments and pages through the timeline newest first", async () => {
    const item = await makeItem(t.member, t.ops.id);
    for (let i = 1; i <= 4; i++) {
      const res = await call(comment, {
        method: "POST",
        token: t.member.token,
        params: { id: item.id },
        body: { body: `note ${i}` },
      });
      expect(res.status).toBe(201);
    }

    const page1 = await call(activity, { token: t.viewer.token, path: "/?limit=3", params: { id: item.id } });
    const page2 = await call(activity, {
      token: t.viewer.token,
      path: `/?limit=3&cursor=${page1.body.nextCursor}`,
      params: { id: item.id },
    });
    const types = [...page1.body.items, ...page2.body.items].map((e: { type: string }) => e.type);
    expect(types).toEqual(["COMMENT_ADDED", "COMMENT_ADDED", "COMMENT_ADDED", "COMMENT_ADDED", "CREATED"]);
    expect(page2.body.nextCursor).toBeNull();
  });
});

describe("list: keyset pagination, filters and search", () => {
  let t: Awaited<ReturnType<typeof setupTeams>>;
  beforeEach(async () => {
    await resetDb();
    t = await setupTeams();
  });

  it("walks every item exactly once, newest first, without OFFSET", async () => {
    for (let i = 0; i < 23; i++) await makeItem(t.member, t.ops.id, { title: `Item ${i}` });
    await makeItem(t.outsider, t.other.id, { title: "Other team" });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const path: string = `/api/items?limit=5${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await call(listItems, { token: t.member.token, path });
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    const expected = await prisma.workItem.findMany({
      where: { teamId: t.ops.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    expect(seen).toEqual(expected.map((e) => e.id));
  });

  it("filters and searches on the server", async () => {
    await makeItem(t.member, t.ops.id, { title: "Refund stuck for order 4821", type: "PAYMENT", priority: "URGENT" });
    await makeItem(t.member, t.ops.id, { title: "Rotate keys", description: "refund service creds" });
    await makeItem(t.member, t.ops.id, { title: "Unrelated" });

    const search = await call(listItems, { token: t.member.token, path: "/api/items?q=REFUND" });
    expect(search.body.items).toHaveLength(2); // case-insensitive, title or description

    const urgent = await call(listItems, { token: t.member.token, path: "/api/items?view=unassigned_urgent" });
    expect(urgent.body.items.map((i: { title: string }) => i.title)).toEqual(["Refund stuck for order 4821"]);

    const byType = await call(listItems, { token: t.member.token, path: "/api/items?type=PAYMENT" });
    expect(byType.body.items).toHaveLength(1);

    const bad = await call(listItems, { token: t.member.token, path: "/api/items?status=NOPE" });
    expect(bad.status).toBe(400);
  });
});
