import { json, parseBody, parseId, route } from "@/server/http";
import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { getItem, toDetail, updateItem } from "@/server/services/items.service";
import { updateItemSchema } from "@/shared/schemas";

export const GET = route<{ id: string }>(async (req, params) => {
  const user = await requireUser(req);
  return json(await getItem(user, parseId(params.id)));
});

export const PATCH = route<{ id: string }>(async (req, params) => {
  const user = await requireUser(req);
  const id = parseId(params.id);
  const input = await parseBody(req, updateItemSchema);

  const item = await prisma.$transaction((tx) => updateItem(tx, user, id, input));
  return json(toDetail(user, item));
});
