// THE permission check. Every service calls authorize() before reading or changing anything,
// and every list query is scoped with teamIdsFor(). The frontend only hides buttons; this is the rule.
import type { Role } from "@prisma/client";
import type { AuthUser } from "./auth";
import { forbidden, notFound } from "./errors";

export type Action =
  | "item:read"
  | "item:create"
  | "item:comment"
  | "item:claim"
  | "item:edit"
  | "item:transition"
  | "item:approve"
  | "item:assign"
  | "item:change_priority";

const ROLE_RANK: Record<Role, number> = { VIEWER: 0, MEMBER: 1, LEAD: 2, ADMIN: 3 };

/** The permission matrix: the lowest role (in the item's team) that may perform each action. */
export const MIN_ROLE: Record<Action, Role> = {
  "item:read": "VIEWER",
  "item:create": "MEMBER",
  "item:comment": "MEMBER",
  "item:claim": "MEMBER",
  "item:edit": "MEMBER",
  "item:transition": "MEMBER",
  "item:approve": "LEAD",
  "item:assign": "LEAD",
  "item:change_priority": "LEAD",
};

/** Anything that belongs to a team: a work item, or a team written as { teamId }. */
export type TeamResource = { teamId: string };

export function roleIn(user: AuthUser, teamId: string): Role | null {
  return user.memberships.find((m) => m.teamId === teamId)?.role ?? null;
}

export function hasAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function can(user: AuthUser, action: Action, resource: TeamResource): boolean {
  const role = roleIn(user, resource.teamId);
  return role !== null && hasAtLeast(role, MIN_ROLE[action]);
}

/**
 * Throws if `user` may not perform `action` on `resource`.
 *
 * Policy (documented in ENGINEERING_DECISIONS.md):
 * - Not a member of the resource's team -> 404, for reads AND writes. Answering 403 would
 *   confirm that the item exists, which leaks information across teams.
 * - Member, but role too low -> 403 with a reason (they can already see the item).
 */
export function authorize(user: AuthUser, action: Action, resource: TeamResource): void {
  const role = roleIn(user, resource.teamId);
  if (role === null) throw notFound();
  if (!hasAtLeast(role, MIN_ROLE[action])) {
    throw forbidden(`Your role in this team (${role}) cannot do this; it needs ${MIN_ROLE[action]} or above`);
  }
}

/** Team ids where the user has at least `min` role. Used to scope every list query. */
export function teamIdsFor(user: AuthUser, min: Role = "VIEWER"): string[] {
  return user.memberships.filter((m) => hasAtLeast(m.role, min)).map((m) => m.teamId);
}
