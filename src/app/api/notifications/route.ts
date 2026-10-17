import { json, route } from "@/server/http";
import { requireUser } from "@/server/auth";
import { listMyNotifications } from "@/server/services/notifications.service";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  return json({ notifications: await listMyNotifications(user) });
});
