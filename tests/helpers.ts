// Test helpers: real database, real route handlers, no mocks.
import type { Role } from "@prisma/client";
import { prisma } from "@/server/db";
import { loadAuthUser, signSessionToken, type AuthUser } from "@/server/auth";
import { createItem } from "@/server/services/items.service";
import type { CreateItemInput } from "@/shared/schemas";

export async function resetDb() {
  // TRUNCATE does not fire the append-only trigger on ActivityEvent (that one is per row).
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Notification", "OutboxJob", "IdempotencyKey", "Comment", "ActivityEvent",
              "WorkItem", "Membership", "Team", "User" CASCADE`,
  );
}

export type TestUser = { auth: AuthUser; token: string };

export async function createUser(name: string, memberships: [teamId: string, role: Role][]): Promise<TestUser> {
  const user = await prisma.user.create({
    data: {
      email: `${name.toLowerCase()}@test.dev`,
      name,
      passwordHash: "not-used-in-tests",
      memberships: { create: memberships.map(([teamId, role]) => ({ teamId, role })) },
    },
  });
  return { auth: (await loadAuthUser(user.id))!, token: await signSessionToken(user.id) };
}

/** Two teams: "ops" has one user per role, "other" has a single member. */
export async function setupTeams() {
  const ops = await prisma.team.create({ data: { name: "Ops" } });
  const other = await prisma.team.create({ data: { name: "Other" } });
  return {
    ops,
    other,
    admin: await createUser("Admin", [[ops.id, "ADMIN"]]),
    lead: await createUser("Lead", [[ops.id, "LEAD"]]),
    member: await createUser("Member", [[ops.id, "MEMBER"]]),
    member2: await createUser("Member2", [[ops.id, "MEMBER"]]),
    viewer: await createUser("Viewer", [[ops.id, "VIEWER"]]),
    outsider: await createUser("Outsider", [[other.id, "MEMBER"]]),
  };
}

export async function makeItem(user: TestUser, teamId: string, overrides: Partial<CreateItemInput> = {}) {
  return prisma.$transaction((tx) =>
    createItem(tx, user.auth, {
      teamId,
      title: "Test item",
      description: "",
      type: "TASK",
      priority: "MEDIUM",
      ...overrides,
    }),
  );
}

type Handler = (req: Request, ctx: { params: Promise<never> }) => Promise<Response>;

/** Calls a Next.js route handler directly with a real Request, like the framework does. */
export async function call(
  handler: unknown,
  opts: {
    method?: string;
    path?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    params?: Record<string, string>;
  } = {},
) {
  const req = new Request(`http://test.local${opts.path ?? "/"}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await (handler as Handler)(req, { params: Promise.resolve((opts.params ?? {}) as never) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = await res.json();
  return { status: res.status, body, headers: res.headers };
}
