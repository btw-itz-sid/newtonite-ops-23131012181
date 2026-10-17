import { json, parseBody, parseQuery, route } from "@/server/http";
import { requireUser } from "@/server/auth";
import { readIdempotencyKey, withIdempotency } from "@/server/idempotency";
import { createItem, listItems, toDetail } from "@/server/services/items.service";
import { createItemSchema, listItemsQuerySchema } from "@/shared/schemas";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  const query = parseQuery(req, listItemsQuerySchema);
  return json(await listItems(user, query));
});

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const input = await parseBody(req, createItemSchema);

  const result = await withIdempotency(
    { userId: user.id, key: readIdempotencyKey(req), route: "POST /api/items", payload: input },
    async (tx) => ({ status: 201, body: toDetail(user, await createItem(tx, user, input)) }),
  );
  return json(result.body, result.status, result.replayed ? { "Idempotent-Replayed": "true" } : undefined);
});
