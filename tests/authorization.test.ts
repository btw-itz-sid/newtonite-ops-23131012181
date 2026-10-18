import { beforeEach, describe, expect, it } from "vitest";
import { GET as listItems, POST as createItem } from "@/app/api/items/route";
import { GET as getItem, PATCH } from "@/app/api/items/[id]/route";
import { POST as claim } from "@/app/api/items/[id]/claim/route";
import { POST as transition } from "@/app/api/items/[id]/transition/route";
import { POST as comment } from "@/app/api/items/[id]/comments/route";
import { GET as activity } from "@/app/api/items/[id]/activity/route";
import { GET as me } from "@/app/api/me/route";
import { call, makeItem, resetDb, setupTeams } from "./helpers";

describe("resource-level authorization", () => {
  let t: Awaited<ReturnType<typeof setupTeams>>;
  let itemId: string;
  beforeEach(async () => {
    await resetDb();
    t = await setupTeams();
    itemId = (await makeItem(t.member, t.ops.id)).id;
  });

  it("returns 401 without a token", async () => {
    expect((await call(me)).status).toBe(401);
    expect((await call(getItem, { params: { id: itemId } })).status).toBe(401);
  });

  it("accepts the session cookie as well as a Bearer token", async () => {
    const res = await call(me, { headers: { Cookie: `session=${t.member.token}` } });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(t.member.auth.id);
  });

  it("hides another team's item: 404 on read (item and activity)", async () => {
    expect((await call(getItem, { token: t.outsider.token, params: { id: itemId } })).status).toBe(404);
    expect((await call(activity, { token: t.outsider.token, params: { id: itemId } })).status).toBe(404);
    // Same answer as for an id that does not exist at all
    const missing = await call(getItem, {
      token: t.outsider.token,
      params: { id: "00000000-0000-4000-8000-000000000000" },
    });
    expect(missing.status).toBe(404);
  });

  it("returns 404 on every write to another team's item, and nothing changes", async () => {
    const opts = { token: t.outsider.token, params: { id: itemId } };
    expect((await call(claim, { ...opts, method: "POST" })).status).toBe(404);
    expect((await call(PATCH, { ...opts, method: "PATCH", body: { version: 1, title: "x" } })).status).toBe(404);
    expect((await call(transition, { ...opts, method: "POST", body: { to: "IN_PROGRESS", version: 1 } })).status).toBe(
      404,
    );
    expect((await call(comment, { ...opts, method: "POST", body: { body: "hi" } })).status).toBe(404);

    const check = await call(getItem, { token: t.member.token, params: { id: itemId } });
    expect(check.body.item.version).toBe(1);
    expect(check.body.item.assigneeId).toBeNull();
  });

  it("never lists another team's items, even when asked for that team", async () => {
    const all = await call(listItems, { token: t.outsider.token, path: "/api/items" });
    expect(all.body.items).toEqual([]);
    const forced = await call(listItems, { token: t.outsider.token, path: `/api/items?team=${t.ops.id}` });
    expect(forced.body.items).toEqual([]);
  });

  it("does not let a user create items in a team they are not in", async () => {
    const res = await call(createItem, {
      method: "POST",
      token: t.outsider.token,
      body: { teamId: t.ops.id, title: "Sneaky", type: "TASK" },
    });
    expect(res.status).toBe(404);
  });

  it("VIEWER can read but gets 403 on writes", async () => {
    const opts = { token: t.viewer.token, params: { id: itemId } };
    expect((await call(getItem, opts)).status).toBe(200);
    expect((await call(comment, { ...opts, method: "POST", body: { body: "hi" } })).status).toBe(403);
    expect((await call(PATCH, { ...opts, method: "PATCH", body: { version: 1, title: "x" } })).status).toBe(403);
  });

  it("MEMBER can edit but cannot change priority or reassign (LEAD only)", async () => {
    const opts = { token: t.member.token, params: { id: itemId }, method: "PATCH" };
    expect((await call(PATCH, { ...opts, body: { version: 1, priority: "URGENT" } })).status).toBe(403);
    expect((await call(PATCH, { ...opts, body: { version: 1, assigneeId: t.member2.auth.id } })).status).toBe(403);
    expect((await call(PATCH, { ...opts, body: { version: 1, title: "Fine" } })).status).toBe(200);
  });

  it("cannot assign to someone outside the team or to a VIEWER", async () => {
    const opts = { token: t.lead.token, params: { id: itemId }, method: "PATCH" };
    expect((await call(PATCH, { ...opts, body: { version: 1, assigneeId: t.outsider.auth.id } })).status).toBe(422);
    expect((await call(PATCH, { ...opts, body: { version: 1, assigneeId: t.viewer.auth.id } })).status).toBe(422);
  });

  it("returns permissions so the UI can hide buttons", async () => {
    const asViewer = await call(getItem, { token: t.viewer.token, params: { id: itemId } });
    expect(asViewer.body.permissions).toMatchObject({ canEdit: false, canClaim: false, transitions: [] });
    const asLead = await call(getItem, { token: t.lead.token, params: { id: itemId } });
    expect(asLead.body.permissions).toMatchObject({ canEdit: true, canClaim: true, canAssign: true });
  });
});
