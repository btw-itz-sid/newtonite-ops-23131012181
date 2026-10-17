import { json, parseId, route } from "@/server/http";
import { requireUser } from "@/server/auth";
import { listTeamMembers } from "@/server/services/teams.service";

export const GET = route<{ id: string }>(async (req, params) => {
  const user = await requireUser(req);
  return json({ members: await listTeamMembers(user, parseId(params.id, "Team")) });
});
