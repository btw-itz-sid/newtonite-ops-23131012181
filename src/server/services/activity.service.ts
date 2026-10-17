import type { ActivityType, Prisma } from "@prisma/client";
import { prisma, type Tx } from "../db";
import type { AuthUser } from "../auth";
import { authorize } from "../authorize";
import { afterCursor, NEWEST_FIRST, toPage } from "../pagination";
import { notFound } from "../errors";

/**
 * Appends one history event. Takes `tx` on purpose: it must be called inside the same
 * transaction as the item change it describes, so history can never disagree with the item
 * (either both are committed or neither is).
 */
export async function recordActivity(
  tx: Tx,
  event: {
    itemId: string;
    actorId: string;
    type: ActivityType;
    from?: Record<string, unknown> | null;
    to?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.activityEvent.create({
    data: {
      itemId: event.itemId,
      actorId: event.actorId,
      type: event.type,
      from: (event.from ?? undefined) as Prisma.InputJsonValue | undefined,
      to: (event.to ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

export async function listActivity(user: AuthUser, itemId: string, page: { cursor?: string; limit: number }) {
  const item = await prisma.workItem.findUnique({ where: { id: itemId }, select: { teamId: true } });
  if (!item) throw notFound();
  authorize(user, "item:read", item);

  const rows = await prisma.activityEvent.findMany({
    where: { itemId, ...afterCursor(page.cursor) },
    orderBy: NEWEST_FIRST,
    take: page.limit + 1,
    include: { actor: { select: { id: true, name: true } } },
  });
  return toPage(rows, page.limit);
}
