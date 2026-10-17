import { json, parseId, parseQuery, route } from "@/server/http";
import { requireUser } from "@/server/auth";
import { listActivity } from "@/server/services/activity.service";
import { pageQuerySchema } from "@/shared/schemas";

export const GET = route<{ id: string }>(async (req, params) => {
  const user = await requireUser(req);
  const page = parseQuery(req, pageQuerySchema);
  return json(await listActivity(user, parseId(params.id), page));
});
