// All work-item business logic. Route handlers only parse input and call these functions.
//
// Two rules hold for every write function below:
//  1. It receives `tx` and does everything (item update + ActivityEvent + outbox job) in that ONE
//     transaction, so history and notifications can never disagree with the item.
//  2. It loads the item through loadItem(), which runs authorize() before anything else.
import type { Prisma } from "@prisma/client";
import { prisma, type Tx } from "../db";
import type { AuthUser } from "../auth";
import { authorize, can, teamIdsFor, type Action } from "../authorize";
import { conflict, notFound, unprocessable } from "../errors";
import { enqueueJob } from "../outbox";
import { afterCursor, NEWEST_FIRST, toPage } from "../pagination";
import { recordActivity } from "./activity.service";
import { ACTIVE_STATUSES, CLAIMABLE_STATUSES } from "@/shared/constants";
import type { CreateItemInput, ListItemsQuery, TransitionInput, UpdateItemInput } from "@/shared/schemas";
import { findTransition, TRANSITIONS } from "@/shared/workflow";

const ITEM_INCLUDE = {
  team: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.WorkItemInclude;

export type Item = Prisma.WorkItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

type Db = Tx | typeof prisma;

/**
 * Loads an item and checks `action` on it.
 * Missing item and "item of a team you're not in" both give the same 404 (see authorize.ts).
 */
export async function loadItem(db: Db, user: AuthUser, id: string, action: Action): Promise<Item> {
  const item = await db.workItem.findUnique({ where: { id }, include: ITEM_INCLUDE });
  if (!item) throw notFound();
  authorize(user, action, item);
  return item;
}

function reload(tx: Tx, id: string): Promise<Item> {
  return tx.workItem.findUniqueOrThrow({ where: { id }, include: ITEM_INCLUDE });
}

/** 409 whose body carries the current item, so the client can show what changed. */
async function conflictWithLatest(tx: Tx, id: string, code: string, message: string) {
  // Read Committed: this new statement sees the write that beat us.
  return conflict(code, message, { latest: await reload(tx, id) });
}

function assertNotClosed(item: Item) {
  if (item.status === "CLOSED") throw unprocessable("ITEM_CLOSED", "Closed items can't be changed");
}

/**
 * What the current user may do with this item. The UI uses it only to hide buttons;
 * every action is still re-checked by the functions below.
 */
export function permissionsFor(user: AuthUser, item: Item) {
  const open = item.status !== "CLOSED";
  return {
    canEdit: open && can(user, "item:edit", item),
    canComment: can(user, "item:comment", item),
    canClaim: can(user, "item:claim", item) && !item.assigneeId && CLAIMABLE_STATUSES.includes(item.status),
    canAssign: open && can(user, "item:assign", item),
    canChangePriority: open && can(user, "item:change_priority", item),
    transitions: TRANSITIONS[item.status].filter((t) => can(user, t.action, item)).map((t) => t.to),
  };
}

export function toDetail(user: AuthUser, item: Item) {
  return { item, permissions: permissionsFor(user, item) };
}

// ---------------------------------------------------------------- reads

export async function getItem(user: AuthUser, id: string) {
  return toDetail(user, await loadItem(prisma, user, id, "item:read"));
}

const VIEW_FILTERS = {
  assigned_to_me: (user: AuthUser): Prisma.WorkItemWhereInput => ({
    assigneeId: user.id,
    status: { in: ACTIVE_STATUSES },
  }),
  // Must stay identical to the partial index predicate (migration ..._partial_index_and_append_only),
  // otherwise Postgres cannot use that index.
  unassigned_urgent: (): Prisma.WorkItemWhereInput => ({
    priority: "URGENT",
    assigneeId: null,
    status: { in: ["OPEN", "IN_PROGRESS"] },
  }),
  awaiting_my_approval: (user: AuthUser): Prisma.WorkItemWhereInput => ({
    status: "AWAITING_APPROVAL",
    teamId: { in: teamIdsFor(user, "LEAD") },
  }),
};

export async function listItems(user: AuthUser, query: ListItemsQuery) {
  const myTeams = teamIdsFor(user);
  const filters: Prisma.WorkItemWhereInput[] = [
    // Authorization scope, always applied first: only items of the user's teams.
    // Asking for another team's id simply yields no rows (nothing leaks).
    { teamId: { in: query.team ? myTeams.filter((t) => t === query.team) : myTeams } },
  ];

  if (query.status) filters.push({ status: query.status });
  if (query.priority) filters.push({ priority: query.priority });
  if (query.type) filters.push({ type: query.type });
  if (query.assignee === "me") filters.push({ assigneeId: user.id });
  else if (query.assignee === "none") filters.push({ assigneeId: null });
  else if (query.assignee) filters.push({ assigneeId: query.assignee });
  if (query.q) {
    // ILIKE '%q%', served by the pg_trgm GIN indexes on title and description
    filters.push({
      OR: [
        { title: { contains: query.q, mode: "insensitive" } },
        { description: { contains: query.q, mode: "insensitive" } },
      ],
    });
  }
  if (query.view) filters.push(VIEW_FILTERS[query.view](user));
  filters.push(afterCursor(query.cursor));

  const rows = await prisma.workItem.findMany({
    where: { AND: filters },
    orderBy: NEWEST_FIRST,
    take: query.limit + 1,
    include: ITEM_INCLUDE,
  });
  return toPage(rows, query.limit);
}

// ---------------------------------------------------------------- writes

export async function createItem(tx: Tx, user: AuthUser, input: CreateItemInput): Promise<Item> {
  authorize(user, "item:create", { teamId: input.teamId });

  const item = await tx.workItem.create({
    data: {
      teamId: input.teamId,
      title: input.title,
      description: input.description,
      type: input.type,
      priority: input.priority,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      createdById: user.id,
    },
    include: ITEM_INCLUDE,
  });
  await recordActivity(tx, {
    itemId: item.id,
    actorId: user.id,
    type: "CREATED",
    to: { title: item.title, type: item.type, priority: item.priority, status: item.status },
  });
  return item;
}

export async function claimItem(tx: Tx, user: AuthUser, id: string): Promise<Item> {
  const item = await loadItem(tx, user, id, "item:claim");
  if (!CLAIMABLE_STATUSES.includes(item.status)) {
    throw unprocessable("NOT_CLAIMABLE", `A ${item.status} item can't be claimed`);
  }

  // ATOMIC CLAIM. "Is it still unassigned?" and "assign it to me" happen in ONE UPDATE statement.
  // If two people claim at once, Postgres locks the row for the first UPDATE; the second waits,
  // then re-checks `assigneeId IS NULL` against the committed row, matches 0 rows, and gets a 409.
  // A read-then-write (findUnique, then update) would let both of them "win".
  const { count } = await tx.workItem.updateMany({
    where: { id, assigneeId: null, status: { in: CLAIMABLE_STATUSES } },
    data: { assigneeId: user.id, version: { increment: 1 } },
  });
  if (count === 0) {
    throw await conflictWithLatest(tx, id, "ALREADY_CLAIMED", "Someone else claimed this item first");
  }

  await recordActivity(tx, {
    itemId: id,
    actorId: user.id,
    type: "ASSIGNEE_CHANGED",
    from: { assigneeId: null },
    to: { assigneeId: user.id },
  });
  return reload(tx, id);
}

async function assertAssignable(tx: Tx, teamId: string, userId: string) {
  const membership = await tx.membership.findUnique({ where: { userId_teamId: { userId, teamId } } });
  if (!membership || membership.role === "VIEWER") {
    throw unprocessable("INVALID_ASSIGNEE", "The assignee must be a MEMBER or above of this item's team");
  }
}

const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export async function updateItem(tx: Tx, user: AuthUser, id: string, input: UpdateItemInput): Promise<Item> {
  const item = await loadItem(tx, user, id, "item:edit");
  assertNotClosed(item);
  if (item.version !== input.version) {
    throw conflict("VERSION_CONFLICT", "This item was changed by someone else. Reload to see the latest.", {
      latest: item,
    });
  }

  // Work out what actually changes, and check the extra permission for sensitive fields.
  const data: Prisma.WorkItemUncheckedUpdateManyInput = {};
  const editedFrom: Record<string, unknown> = {};
  const editedTo: Record<string, unknown> = {};

  if (input.title !== undefined && input.title !== item.title) {
    data.title = editedTo.title = input.title;
    editedFrom.title = item.title;
  }
  if (input.description !== undefined && input.description !== item.description) {
    data.description = editedTo.description = input.description;
    editedFrom.description = item.description;
  }
  if (input.type !== undefined && input.type !== item.type) {
    data.type = editedTo.type = input.type;
    editedFrom.type = item.type;
  }
  if (input.dueDate !== undefined && input.dueDate !== dateOnly(item.dueDate)) {
    data.dueDate = input.dueDate ? new Date(input.dueDate) : null;
    editedFrom.dueDate = dateOnly(item.dueDate);
    editedTo.dueDate = input.dueDate;
  }

  const priorityChanged = input.priority !== undefined && input.priority !== item.priority;
  if (priorityChanged) {
    authorize(user, "item:change_priority", item);
    data.priority = input.priority;
  }

  const assigneeChanged = input.assigneeId !== undefined && input.assigneeId !== item.assigneeId;
  if (assigneeChanged) {
    authorize(user, "item:assign", item);
    if (input.assigneeId) await assertAssignable(tx, item.teamId, input.assigneeId);
    data.assigneeId = input.assigneeId;
  }

  if (Object.keys(data).length === 0) return item; // no real change: no version bump, no history

  // OPTIMISTIC LOCK. Only succeeds if the row still has the version the client saw.
  // The check above gives a fast answer; this WHERE clause is what makes it safe when two
  // requests pass that check at the same moment (only one UPDATE can match version N).
  const { count } = await tx.workItem.updateMany({
    where: { id, version: input.version },
    data: { ...data, version: { increment: 1 } },
  });
  if (count === 0) {
    throw await conflictWithLatest(
      tx,
      id,
      "VERSION_CONFLICT",
      "This item was changed by someone else. Reload to see the latest.",
    );
  }

  // History rows, in the same transaction as the update above.
  if (Object.keys(editedTo).length > 0) {
    await recordActivity(tx, { itemId: id, actorId: user.id, type: "EDITED", from: editedFrom, to: editedTo });
  }
  if (priorityChanged) {
    await recordActivity(tx, {
      itemId: id,
      actorId: user.id,
      type: "PRIORITY_CHANGED",
      from: { priority: item.priority },
      to: { priority: input.priority },
    });
  }
  if (assigneeChanged) {
    await recordActivity(tx, {
      itemId: id,
      actorId: user.id,
      type: "ASSIGNEE_CHANGED",
      from: { assigneeId: item.assigneeId },
      to: { assigneeId: input.assigneeId },
    });
    if (input.assigneeId && input.assigneeId !== user.id) {
      await enqueueJob(tx, {
        type: "NOTIFY_ASSIGNEE",
        payload: {
          itemId: id,
          teamId: item.teamId,
          userId: input.assigneeId,
          message: `${user.name} assigned you "${item.title}"`,
        },
        dedupeKey: `assign:${id}:v${item.version + 1}`,
      });
    }
  }

  return reload(tx, id);
}

export async function transitionItem(tx: Tx, user: AuthUser, id: string, input: TransitionInput): Promise<Item> {
  const item = await loadItem(tx, user, id, "item:transition");

  // Version first: if the client's view is stale, "invalid transition" would be misleading.
  if (item.version !== input.version) {
    throw conflict("VERSION_CONFLICT", "This item was changed by someone else. Reload to see the latest.", {
      latest: item,
    });
  }

  const transition = findTransition(item.status, input.to);
  if (!transition) {
    throw unprocessable("INVALID_TRANSITION", `Can't move an item from ${item.status} to ${input.to}`, {
      allowed: TRANSITIONS[item.status].map((t) => t.to),
    });
  }
  authorize(user, transition.action, item); // approve / reject need LEAD or ADMIN
  if (input.to === "IN_PROGRESS" && !item.assigneeId) {
    throw unprocessable("ASSIGNEE_REQUIRED", "Claim or assign the item before starting work");
  }

  // Same optimistic lock as updateItem.
  const { count } = await tx.workItem.updateMany({
    where: { id, version: input.version },
    data: { status: input.to, version: { increment: 1 } },
  });
  if (count === 0) {
    throw await conflictWithLatest(
      tx,
      id,
      "VERSION_CONFLICT",
      "This item was changed by someone else. Reload to see the latest.",
    );
  }

  await recordActivity(tx, {
    itemId: id,
    actorId: user.id,
    type: "STATE_CHANGED",
    from: { status: item.status },
    to: { status: input.to },
  });

  const newVersion = item.version + 1;
  if (input.to === "AWAITING_APPROVAL") {
    await enqueueJob(tx, {
      type: "NOTIFY_APPROVERS",
      payload: { itemId: id, teamId: item.teamId, message: `"${item.title}" is waiting for your approval` },
      dedupeKey: `approval:${id}:v${newVersion}`,
    });
  }
  if (transition.action === "item:approve" && item.assigneeId && item.assigneeId !== user.id) {
    const verdict = input.to === "RESOLVED" ? "approved" : "sent back for more work";
    await enqueueJob(tx, {
      type: "NOTIFY_ASSIGNEE",
      payload: {
        itemId: id,
        teamId: item.teamId,
        userId: item.assigneeId,
        message: `"${item.title}" was ${verdict} by ${user.name}`,
      },
      dedupeKey: `decision:${id}:v${newVersion}`,
    });
  }

  return reload(tx, id);
}
