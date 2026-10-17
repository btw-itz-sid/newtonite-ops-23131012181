// The workflow, as data. The server enforces it (items.service.ts transitionItem);
// the browser reads the server's computed permissions, it never decides on its own.
import type { ItemStatus } from "./constants";

/**
 * Which permission a transition needs. "item:approve" is LEAD/ADMIN only (see authorize.ts).
 * Rejecting (AWAITING_APPROVAL -> IN_PROGRESS) is part of the approval decision, so it is also LEAD+.
 */
export type TransitionAction = "item:transition" | "item:approve";

export const TRANSITIONS: Record<ItemStatus, { to: ItemStatus; action: TransitionAction }[]> = {
  OPEN: [{ to: "IN_PROGRESS", action: "item:transition" }],
  IN_PROGRESS: [{ to: "AWAITING_APPROVAL", action: "item:transition" }],
  AWAITING_APPROVAL: [
    { to: "RESOLVED", action: "item:approve" },
    { to: "IN_PROGRESS", action: "item:approve" }, // rejected, back to work
  ],
  RESOLVED: [{ to: "CLOSED", action: "item:transition" }],
  CLOSED: [],
};

export function findTransition(from: ItemStatus, to: ItemStatus) {
  return TRANSITIONS[from].find((t) => t.to === to) ?? null;
}
