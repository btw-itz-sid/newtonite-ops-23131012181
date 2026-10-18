// Browser-side API client. The session cookie is httpOnly, so the browser sends it automatically
// and this code never sees the token.
import type { ActivityType, ItemStatus, ItemType, Priority, Role } from "@/shared/constants";

export type Me = {
  id: string;
  email: string;
  name: string;
  memberships: { teamId: string; teamName: string; role: Role }[];
};

export type Item = {
  id: string;
  title: string;
  description: string;
  type: ItemType;
  priority: Priority;
  status: ItemStatus;
  teamId: string;
  assigneeId: string | null;
  dueDate: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  team: { id: string; name: string };
  assignee: { id: string; name: string } | null;
  createdBy: { id: string; name: string };
};

/** Computed by the server (permissionsFor). Used only to hide buttons; the server re-checks everything. */
export type Permissions = {
  canEdit: boolean;
  canComment: boolean;
  canClaim: boolean;
  canAssign: boolean;
  canChangePriority: boolean;
  transitions: ItemStatus[];
};

export type ItemDetail = { item: Item; permissions: Permissions };
export type Page<T> = { items: T[]; nextCursor: string | null };

export type ActivityEvent = {
  id: string;
  type: ActivityType;
  from: Record<string, unknown> | null;
  to: Record<string, unknown> | null;
  createdAt: string;
  actor: { id: string; name: string };
};

export type TeamMember = { id: string; name: string; email: string; role: Role };
export type Notification = { id: string; message: string; itemId: string; createdAt: string };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // A full page load (not router.push) so no cached data from the expired session survives.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    if (res.status === 401 && window.location.pathname !== "/login") window.location.href = "/login";
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

/** One message per status code, so every screen explains errors the same way. */
export function errorText(err: unknown): string {
  if (!(err instanceof ApiError)) return "Network error. Check your connection and try again.";
  switch (err.status) {
    case 401:
      return "Your session has expired. Please log in again.";
    case 403:
      return `Not allowed: ${err.message}`;
    case 404:
      return "Not found, or you don't have access to it.";
    case 409:
      return `This item changed, reload. ${err.message}`;
    default:
      return err.message;
  }
}

export function toQuery(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  return search.toString();
}
