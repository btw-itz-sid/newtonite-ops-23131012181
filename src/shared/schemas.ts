// Request validation (Zod). Every route handler parses its input with one of these
// before calling a service, so services can trust their arguments.
import { z } from "zod";
import { ITEM_TYPES, PRIORITIES, STATUSES, VIEWS } from "./constants";

const title = z.string().trim().min(1, "Title is required").max(200);
const description = z.string().trim().max(5000);
const dueDate = z.iso.date().nullable(); // "YYYY-MM-DD", stored as a DATE column

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(200),
  password: z.string().min(1).max(200),
});

export const createItemSchema = z.object({
  teamId: z.uuid(),
  title,
  description: description.default(""),
  type: z.enum(ITEM_TYPES),
  priority: z.enum(PRIORITIES).default("MEDIUM"),
  dueDate: dueDate.optional(),
});
export type CreateItemInput = z.infer<typeof createItemSchema>;

// `version` is required: it is the value the client last saw, used for optimistic locking.
export const updateItemSchema = z
  .object({
    version: z.int().positive(),
    title: title.optional(),
    description: description.optional(),
    type: z.enum(ITEM_TYPES).optional(),
    dueDate: dueDate.optional(),
    priority: z.enum(PRIORITIES).optional(),
    assigneeId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 1, { message: "Nothing to update" });
export type UpdateItemInput = z.infer<typeof updateItemSchema>;

export const transitionSchema = z.object({
  to: z.enum(STATUSES),
  version: z.int().positive(),
});
export type TransitionInput = z.infer<typeof transitionSchema>;

export const commentSchema = z.object({
  body: z.string().trim().min(1, "Comment cannot be empty").max(5000),
});

const limit = z.coerce.number().int().min(1).max(100).default(25);

export const listItemsQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(ITEM_TYPES).optional(),
  team: z.uuid().optional(),
  // a user id, "me", or "none" (unassigned)
  assignee: z.union([z.uuid(), z.literal("me"), z.literal("none")]).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  view: z.enum(VIEWS).optional(),
  cursor: z.string().optional(),
  limit,
});
export type ListItemsQuery = z.infer<typeof listItemsQuerySchema>;

export const pageQuerySchema = z.object({ cursor: z.string().optional(), limit });
