// Keyset (cursor) pagination on (createdAt DESC, id DESC).
//
// Why not OFFSET: "OFFSET 4000" makes Postgres read and throw away 4000 rows, so later pages get
// slower, and rows inserted meanwhile shift pages (duplicates / skipped rows). A cursor says
// "give me rows older than the last one I saw", which is an index range scan on every page.
// `id` is the tie-breaker because many rows can share the same createdAt.
import { badRequest } from "./errors";

type Cursor = { createdAt: Date; id: string };

export function encodeCursor(row: Cursor): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64url");
}

export function decodeCursor(cursor: string): Cursor {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const createdAt = new Date(iso);
  if (!id || Number.isNaN(createdAt.getTime())) throw badRequest("INVALID_CURSOR", "Invalid cursor");
  return { createdAt, id };
}

/** WHERE clause for "rows strictly after the cursor" in (createdAt DESC, id DESC) order. */
export function afterCursor(cursor: string | undefined) {
  if (!cursor) return {};
  const c = decodeCursor(cursor);
  return {
    OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }],
  };
}

export const NEWEST_FIRST = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/** We fetch limit + 1 rows: if the extra row exists there is a next page. */
export function toPage<T extends Cursor>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(items[items.length - 1]) : null;
  return { items, nextCursor };
}
