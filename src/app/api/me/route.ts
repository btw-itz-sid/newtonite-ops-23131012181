import { json, route } from "@/server/http";
import { requireUser } from "@/server/auth";

export const GET = route(async (req) => {
  const user = await requireUser(req);
  return json({ user });
});
