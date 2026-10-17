import { json, parseBody, parseId, route } from "@/server/http";
import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { addComment } from "@/server/services/comments.service";
import { commentSchema } from "@/shared/schemas";

export const POST = route<{ id: string }>(async (req, params) => {
  const user = await requireUser(req);
  const id = parseId(params.id);
  const { body } = await parseBody(req, commentSchema);

  const comment = await prisma.$transaction((tx) => addComment(tx, user, id, body));
  return json({ comment }, 201);
});
