import type { Tx } from "../db";
import type { AuthUser } from "../auth";
import { recordActivity } from "./activity.service";
import { loadItem } from "./items.service";

export async function addComment(tx: Tx, user: AuthUser, itemId: string, body: string) {
  await loadItem(tx, user, itemId, "item:comment");

  const comment = await tx.comment.create({ data: { itemId, authorId: user.id, body } });
  // The body is copied into the event so the timeline is self-contained. Comments are never
  // edited, so the copy can't go stale.
  await recordActivity(tx, {
    itemId,
    actorId: user.id,
    type: "COMMENT_ADDED",
    to: { commentId: comment.id, body },
  });
  return comment;
}
