// Idempotency-Key support for POST /api/items and POST /api/items/:id/transition.
//
// Problem: a client times out and retries, or the user double-clicks, and we create two items.
// Fix: the client sends a unique Idempotency-Key per logical operation; we remember the response.
//
// How it stays correct under concurrency:
//   The key row is INSERTED FIRST, inside the SAME transaction as the real work.
//   - Two identical requests at the same moment: the second INSERT hits the unique index
//     (userId, key) and Postgres makes it WAIT until the first transaction finishes.
//     If the first commits, the second gets a unique violation -> we return the stored response.
//   - If the work fails, the whole transaction rolls back, including the key row,
//     so a failed request never "burns" the key and the client can retry it.
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, type Tx } from "./db";
import { badRequest, unprocessable } from "./errors";

export type StoredResponse = { status: number; body: unknown };

class DuplicateKey extends Error {}

export function readIdempotencyKey(req: Request): string | null {
  const key = req.headers.get("idempotency-key")?.trim();
  if (!key) return null;
  if (key.length > 200) throw badRequest("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key is too long");
  return key;
}

/**
 * Runs `work` in a transaction. With a key: at most once per (user, key); repeats get the
 * stored response, and reusing the key for a different request is rejected with 422.
 */
export async function withIdempotency(
  opts: { userId: string; key: string | null; route: string; payload: unknown },
  work: (tx: Tx) => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  const { userId, key, route, payload } = opts;

  if (!key) {
    const result = await prisma.$transaction(work);
    return { ...toJsonResponse(result), replayed: false };
  }

  // Hash of route + validated payload: detects "same key, different request".
  const requestHash = createHash("sha256").update(JSON.stringify({ route, payload })).digest("hex");

  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.idempotencyKey
        .create({ data: { userId, key, route, requestHash } })
        .catch((err) => {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            throw new DuplicateKey(); // rolls this transaction back
          }
          throw err;
        });

      const result = toJsonResponse(await work(tx));
      await tx.idempotencyKey.update({
        where: { id: row.id },
        data: { responseStatus: result.status, responseBody: result.body as Prisma.InputJsonValue },
      });
      return { ...result, replayed: false };
    });
  } catch (err) {
    if (!(err instanceof DuplicateKey)) throw err;

    const existing = await prisma.idempotencyKey.findUniqueOrThrow({
      where: { userId_key: { userId, key } },
    });
    if (existing.requestHash !== requestHash) {
      throw unprocessable(
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used for a different request",
      );
    }
    return { status: existing.responseStatus!, body: existing.responseBody, replayed: true };
  }
}

/**
 * Normalise to plain JSON (Dates -> ISO strings) so a replay carries the same values as the
 * original. Postgres jsonb does not keep key order, so keys may come back in a different order.
 */
function toJsonResponse(result: StoredResponse): StoredResponse {
  return { status: result.status, body: JSON.parse(JSON.stringify(result.body)) };
}
