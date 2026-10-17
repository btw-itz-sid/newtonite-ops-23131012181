import { json, parseBody, parseId, route } from "@/server/http";
import { requireUser } from "@/server/auth";
import { readIdempotencyKey, withIdempotency } from "@/server/idempotency";
import { toDetail, transitionItem } from "@/server/services/items.service";
import { transitionSchema } from "@/shared/schemas";

export const POST = route<{ id: string }>(async (req, params) => {
  const user = await requireUser(req);
  const id = parseId(params.id);
  const input = await parseBody(req, transitionSchema);

  const result = await withIdempotency(
    { userId: user.id, key: readIdempotencyKey(req), route: `POST /api/items/${id}/transition`, payload: input },
    async (tx) => ({ status: 200, body: toDetail(user, await transitionItem(tx, user, id, input)) }),
  );
  return json(result.body, result.status, result.replayed ? { "Idempotent-Replayed": "true" } : undefined);
});
