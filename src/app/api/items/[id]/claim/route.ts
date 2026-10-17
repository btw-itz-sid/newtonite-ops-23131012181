import { json, parseId, route } from "@/server/http";
import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { claimItem, toDetail } from "@/server/services/items.service";

export const POST = route<{ id: string }>(async (req, params) => {
  const user = await requireUser(req);
  const id = parseId(params.id);

  const item = await prisma.$transaction((tx) => claimItem(tx, user, id));
  return json(toDetail(user, item));
});
