# Defense notes

For each critical behaviour: where it lives, how it works, what failure it prevents, and how I would
change it live in a demo.

---

## 1. Atomic claim

**Where:** `src/server/services/items.service.ts`, `claimItem()`. Test: `tests/claim.test.ts`.

**How it works.**
"Is it unassigned?" and "assign it to me" are a single statement:
`updateMany({ where: { id, assigneeId: null, status: in CLAIMABLE }, data: { assigneeId, version: +1 } })`.
Postgres locks the row for the first UPDATE. The second one waits, re-checks `assigneeId IS NULL`
against the committed row, matches 0 rows, and we return 409 with the current item.

**Failure it prevents.** With read-then-write (`findUnique`, check, `update`), two people both read
"unassigned", both write, and the last write silently wins. Both think they own the item.

**Modify live: "let LEADs take over an assigned item".** Add a `takeOverItem()` for LEAD+
(`authorize(user, "item:assign", item)`) that uses `where: { id, version }` instead of
`assigneeId: null`, so it's still conflict-safe, and records an `ASSIGNEE_CHANGED` event with the old
assignee in `from`.

---

## 2. Optimistic locking

**Where:** `items.service.ts`, `updateItem()` and `transitionItem()`; `version` column in
`prisma/schema.prisma`. Test: `tests/optimistic-lock.test.ts`.

**How it works.**
The client sends the `version` it last saw. The write is
`updateMany({ where: { id, version }, data: { ..., version: { increment: 1 } } })`. If 0 rows match,
someone else changed it first, so we return 409 `VERSION_CONFLICT` with `details.latest`. The early
`item.version !== input.version` check is only a fast path; the WHERE clause is what makes it safe.

**Failure it prevents.** Lost updates: a lead changes priority while a member edits the title from
an old screen, and the member's save overwrites the lead's change without anyone noticing.

**Modify live: "make the title edit merge instead of conflicting".** For fields the other writer
didn't touch, you could retry automatically: on 409, compare `latest` with what the client
changed, and if they're disjoint, re-send with `latest.version`. I'd do that on the client in
`useItemMutation`'s `onError`, and keep the server strict.

---

## 3. Idempotency keys

**Where:** `src/server/idempotency.ts`, `withIdempotency()`; used in `src/app/api/items/route.ts`
(POST) and `src/app/api/items/[id]/transition/route.ts`. Test: `tests/idempotency.test.ts`.

**How it works.**
Inside one transaction, we first INSERT `(userId, key, route, requestHash)`, then do the work and
store the response on that row. A concurrent duplicate blocks on the unique index until the first
commits, then gets a unique violation, and we return the stored response (header
`Idempotent-Replayed: true`). A different payload under the same key gets 422. A failure rolls back
the key row too, so the retry can run.

**Failure it prevents.** A user double-clicks "Create" or the network times out and the browser
retries, and two identical incidents get created (or a transition is applied twice).

**Modify live: "add idempotency to comments".** In `comments/route.ts`, wrap the call the same way:
`withIdempotency({ userId, key: readIdempotencyKey(req), route: "POST /api/items/:id/comments", payload: { id, body } }, async (tx) => ({ status: 201, body: { comment: await addComment(tx, user, id, body) } }))`.
Including `id` in the payload means the same key on a different item counts as a different request.

---

## 4. Workflow rules and approval

**Where:** `src/shared/workflow.ts` (the `TRANSITIONS` map), `items.service.ts`, `transitionItem()`.
Test: `tests/workflow.test.ts`.

**How it works.**
The allowed moves are data: `TRANSITIONS[from]` lists each `to` with the permission it needs
(`item:transition` for MEMBER+, `item:approve` for LEAD+). Anything not in the map is 422
`INVALID_TRANSITION` with the allowed list. Approve (to RESOLVED) and reject (back to IN_PROGRESS)
both need `item:approve`. Moving to IN_PROGRESS needs an assignee.

**Failure it prevents.** Items skipping review (OPEN to CLOSED), or a member approving their own
work. Because the UI reads `permissions.transitions` from the server, a hidden button can't be the
only thing stopping it.

**Modify live: "add a BLOCKED status".** Add `BLOCKED` to the `ItemStatus` enum in
`schema.prisma` and run `prisma migrate dev` (it generates `ALTER TYPE ... ADD VALUE`). Add it to
`STATUSES` in `constants.ts` (the `satisfies` makes TypeScript fail until you do), then add
`{ to: "BLOCKED", action: "item:transition" }` under IN_PROGRESS and `BLOCKED: [{ to: "IN_PROGRESS", ... }]`
to `TRANSITIONS`. The service, the UI buttons and the history all follow automatically.

---

## 5. Resource-level authorization

**Where:** `src/server/authorize.ts`, `authorize()`, `can()`, `teamIdsFor()`, `MIN_ROLE`; called
from `loadItem()` in `items.service.ts` and every other service. Test: `tests/authorization.test.ts`.

**How it works.**
`MIN_ROLE` is the permission matrix (lowest role per action). `authorize()` looks up the user's role
in the resource's team: no membership gives 404 (we don't reveal that the item exists), and a role
that's too low gives 403 with the needed role. Lists are always filtered with
`teamId IN teamIdsFor(user)`, and asking for another team's id just returns nothing.

**Failure it prevents.** IDOR: changing the id in a URL to read or edit another team's items.
Also stale privileges: roles aren't in the JWT, so removing a membership takes effect on the next
request.

**Modify live: "let MEMBERs change priority, but only up to HIGH".** Change
`MIN_ROLE["item:change_priority"]` to `"MEMBER"`, and in `updateItem()` add
`if (input.priority === "URGENT" && !can(user, "item:approve", item)) throw forbidden("Only a lead can set URGENT")`.
`permissionsFor()` picks up the matrix change and shows the dropdown to members.

---

## 6. Transactional outbox and worker

**Where:** `src/server/outbox.ts`, `enqueueJob()` (called inside `updateItem`/`transitionItem`);
`src/worker/process.ts`, `claimJobs()` / `runJob()` / `backoffMs()`; `src/worker/handlers.ts`;
`src/worker/index.ts`. Test: `tests/outbox.test.ts`.

**How it works.**
The job row is written with the same `tx` as the item change, so it exists only if the change
committed. The worker claims due jobs with `FOR UPDATE SKIP LOCKED` (parallel workers skip each
other's rows) and marks them PROCESSING. On error it schedules a retry after 1s, 2s, 4s... up to
5 minutes, then FAILED after `maxAttempts`. Handlers insert notifications with a unique `dedupeKey`
and `skipDuplicates`, so running a job twice yields one notification.

**Failure it prevents.** Lost notifications (crash between commit and send), phantom notifications
(sent, then the transaction rolled back), duplicates after a worker crash, and a poison job retrying
forever.

**Modify live: "notify the creator when their item is resolved".** In `transitionItem()`, when
`input.to === "RESOLVED"`, call
`enqueueJob(tx, { type: "NOTIFY_ASSIGNEE", payload: { itemId: id, teamId: item.teamId, userId: item.createdById, message: ... }, dedupeKey: \`resolved:${id}:v${newVersion}\` })`.
The existing handler already does the rest. For a new kind of job, add a `JobType` enum value and a
handler in `handlers.ts`; TypeScript forces the handler to exist because `Handlers` is a
`Record<JobType, ...>`.

---

## 7. Optimistic UI with rollback

**Where:** `src/app/items/[id]/page.tsx`, `useItemMutation()`; error messages in
`src/client/api.ts`, `errorText()`.

**How it works.**
`onMutate` cancels in-flight polls, saves the current cached item, and writes the guessed result
(e.g. assignee = me). `onError` restores the saved copy and shows the server's reason. A 409 shows
"This item changed, reload" with a Reload button. `onSuccess` replaces the guess with the server's
item (with the new `version`). Buttons are disabled while an action is in flight.

**Failure it prevents.** The screen showing a change the server refused (for example "claimed by me"
when someone else won), or a slow UI that waits for every round trip.

**Modify live: "on 409, show the latest data immediately instead of asking to reload".** In
`onError`, if `err instanceof ApiError && err.status === 409 && err.details?.latest`, call
`qc.setQueryData(key, { ...previous, item: err.details.latest })` and refetch for fresh
permissions. The server already sends `latest` for exactly this.

---

## Hard rule: history in the same transaction

**Where:** `src/server/services/activity.service.ts`, `recordActivity(tx, ...)`, called from
`createItem`, `claimItem`, `updateItem`, `transitionItem` and `addComment`. Append-only trigger in
`prisma/migrations/20261016000100_partial_index_and_append_only`.

`recordActivity` only takes a transaction client. Route handlers wrap each service call in
`prisma.$transaction`, so the item update and its event commit together or not at all.
`tests/optimistic-lock.test.ts` ("writes one history event per kind of change") and
`tests/history-and-pagination.test.ts` (append-only) check this.

---

## Two details worth knowing

- **Database timezone pinned to UTC** (`prisma/migrations/20261018000000_utc_timezone`). Prisma
  writes `DateTime` as UTC into `timestamp` columns, but raw SQL `now()` uses the session timezone.
  On a Postgres running in IST, the worker would see every backoff as already expired. The outbox
  retry test caught this.
- **The tests refuse to run against a database not ending in `_test`** (`tests/global-setup.ts`),
  because they truncate tables.
