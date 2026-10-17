import { prisma } from "../db";
import type { AuthUser } from "../auth";
import { authorize } from "../authorize";

/** Members of a team (for the "assign to" dropdown). Only visible to members of that team. */
export async function listTeamMembers(user: AuthUser, teamId: string) {
  authorize(user, "item:read", { teamId });
  const memberships = await prisma.membership.findMany({
    where: { teamId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return memberships.map((m) => ({ ...m.user, role: m.role }));
}
