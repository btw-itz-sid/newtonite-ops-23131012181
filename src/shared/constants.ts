// Enum values shared by the server (Zod validation) and the browser (dropdowns).
// `satisfies` makes TypeScript fail if these ever drift from the Prisma enums.
import type { ActivityType, ItemStatus, ItemType, Priority, Role } from "@prisma/client";

export const ROLES = ["VIEWER", "MEMBER", "LEAD", "ADMIN"] as const satisfies readonly Role[];
export const ITEM_TYPES = [
  "INCIDENT",
  "CUSTOMER_ISSUE",
  "PAYMENT",
  "COMPLIANCE",
  "TASK",
] as const satisfies readonly ItemType[];
export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const satisfies readonly Priority[];
export const STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "AWAITING_APPROVAL",
  "RESOLVED",
  "CLOSED",
] as const satisfies readonly ItemStatus[];
export const ACTIVITY_TYPES = [
  "CREATED",
  "STATE_CHANGED",
  "ASSIGNEE_CHANGED",
  "PRIORITY_CHANGED",
  "COMMENT_ADDED",
  "EDITED",
] as const satisfies readonly ActivityType[];

export const VIEWS = ["assigned_to_me", "unassigned_urgent", "awaiting_my_approval"] as const;

/** Statuses where the work is still "live" (shown in "assigned to me"). */
export const ACTIVE_STATUSES: ItemStatus[] = ["OPEN", "IN_PROGRESS", "AWAITING_APPROVAL"];
/** An unassigned item can only be claimed while work is still to be done. */
export const CLAIMABLE_STATUSES: ItemStatus[] = ["OPEN", "IN_PROGRESS"];

export type { ActivityType, ItemStatus, ItemType, Priority, Role };
