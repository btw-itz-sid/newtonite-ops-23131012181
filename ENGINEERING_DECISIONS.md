# Engineering decisions

The open questions and the assumption I made for each are listed in
[`docs/DESIGN.md`](docs/DESIGN.md#1-open-questions-and-assumptions). This file covers the choices
that shape the system, the options I considered, and the trade-offs.

## 1. Data model and history

**Context.** Several people change the same item, and an operations team has to be able to answer
"who changed what, and when". History that disagrees with the item is worse than no history.

**Options.**
- (a) Store only current state, with `updatedAt` / `updatedBy`.
- (b) Event sourcing: events are the source of truth and the item is derived from them.
- (c) Current state in `WorkItem`, plus an append-only `ActivityEvent` table written in the same
  transaction as each change.

**Choice: (c).** `WorkItem` holds the current state and a `version` counter. Every state,
assignee, priority, edit and comment change appends one `ActivityEvent` with `from` / `to` JSON,
through `recordActivity(tx, ...)`, which only accepts a transaction client. A database trigger
rejects UPDATE and DELETE on `ActivityEvent`, so the history stays append-only even if a future bug
or a manual query tries to change it.

**Trade-off.** Every write is two inserts instead of one, and `from`/`to` is JSON, so history is
less strictly typed than the item. Event sourcing would give replay, but it makes every read harder
and is much more to explain and test. (c) gives an audit trail that can't drift from the item,
using ordinary queries.

## 2. Concurrency control

**Context.** Two people claim the same urgent item at once; a lead reassigns while a member edits;
a flaky network makes the browser resend a POST.

**Options.**
- (a) Last write wins (plain `UPDATE ... WHERE id = ?`).
- (b) Pessimistic locks (`SELECT ... FOR UPDATE`, held while the user thinks).
- (c) Conditional updates: optimistic locking with `version`, an atomic claim, and idempotency keys.

**Choice: (c), one tool per problem.**
- **Claim:** `updateMany({ where: { id, assigneeId: null } })`. The check and the write are one
  statement, so Postgres's row lock serializes concurrent claims. 0 rows updated means 409.
- **Edits and transitions:** the client sends the `version` it saw;
  `UPDATE ... WHERE id = ? AND version = ?` then increments it. A mismatch returns 409 with the latest
  item in the body, so the UI can show what changed.
- **Retries:** an `Idempotency-Key` row is inserted first, in the same transaction as the work.
  The unique index on `(userId, key)` makes a concurrent duplicate wait, then replay the stored
  response. The same key with a different payload gets 422. A failed request rolls its key back,
  so the client can safely retry.

**Trade-off.** Users sometimes see "this item changed, reload" and have to redo a change. For
items that are edited rarely but must never be silently overwritten, that's the right default.
Pessimistic locks would hold row locks while a user thinks, which doesn't work for a web UI.
Stored idempotency keys need a cleanup job eventually (see limitations).

## 3. Authorization model

**Context.** Roles are per team, so the same person can be a LEAD in one team and a MEMBER in
another. Checks scattered across endpoints are how permission bugs happen.

**Options.**
- (a) Checks inside each route handler.
- (b) A policy library or RBAC/ABAC engine.
- (c) One function, `authorize(user, action, resource)`, plus a `MIN_ROLE` table mapping each
  action to the lowest role allowed, and `teamIdsFor(user)` to scope every list query.

**Choice: (c).** Every service loads the resource and calls `authorize()` before doing anything.
The JWT only carries the user id. Memberships are loaded from the database on every request, so
removing someone from a team takes effect immediately.

**Policy for other teams' items:** **404 for both read and write.** A 403 would confirm that the
item exists in a team the user can't see, which leaks information. **403** is only for team members
whose role is too low (for example a VIEWER commenting), and its message says which role is needed.
The UI hides buttons using `permissions` computed by the server, but the server always re-checks.

**Trade-off.** A role ladder (VIEWER < MEMBER < LEAD < ADMIN) is simple, but it can't express rules
like "a member can edit only items assigned to them". Adding that later means adding a condition to
`authorize()` for that one action, not changing the model. ADMIN currently equals LEAD within its
teams, because membership management (the only ADMIN-only feature) is out of scope.

## 4. Synchronous vs asynchronous work

**Context.** Assigning an item or requesting approval should notify people. Sending notifications
inside the request makes it slow and fragile. Sending them after the commit loses them if the
process crashes in between.

**Options.**
- (a) Notify inline in the request.
- (b) Fire-and-forget after the commit (or an in-process queue).
- (c) A transactional outbox: write an `OutboxJob` row in the same transaction as the change, and
  let a separate worker deliver it.
- (d) A message broker (SQS, RabbitMQ, Kafka).

**Choice: (c).** The job exists if and only if the change committed. The worker
(`src/worker`) claims jobs with `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`, so
several workers never take the same job. It retries failures with exponential backoff (1s, 2s, 4s,
up to 5 minutes), marks a job FAILED after `maxAttempts`, and re-claims jobs stuck in PROCESSING
after a crash. Delivery is at least once, so handlers are idempotent: notifications have a unique
`dedupeKey` and are inserted with `ON CONFLICT DO NOTHING`.

**Trade-off.** Notifications are delayed by up to one polling interval (1 second), and the worker
adds load on Postgres. A broker would scale further, but it brings back the dual-write problem
(commit the DB, then publish) unless it's fed from an outbox anyway. Postgres is already there and
transactional.

## 5. Search and pagination

**Context.** About 5,000 items now, and many more later. The dashboard filters by team, status,
priority, type and assignee, and searches titles and descriptions.

**Options.**
- Pagination: OFFSET/LIMIT vs keyset (cursor) on `(createdAt, id)`.
- Search: `ILIKE` with no index; Postgres full-text (`tsvector` + GIN); `pg_trgm` trigram GIN; or a
  separate search engine.

**Choice.** **Keyset pagination** on `(createdAt DESC, id DESC)` with an opaque cursor. With
OFFSET, Postgres reads and discards every skipped row, and rows inserted while the user pages cause
duplicates or gaps. `id` breaks ties between rows with the same `createdAt`. The composite indexes
match the dashboard queries: `(teamId, createdAt, id)`, `(teamId, status, ...)`,
`(assigneeId, status, ...)`, a **partial index** for "unassigned urgent", and
`(itemId, createdAt, id)` for the timeline.

**Search uses `pg_trgm`** GIN indexes on title and description. Operators search for fragments such
as ticket numbers, merchant ids and batch numbers (`M-9127`, `3599`), which full-text search tokenizes
poorly. Trigrams support any substring with `ILIKE`, so Prisma's `contains` uses the index unchanged.

**Trade-off.** Keyset pagination can't jump to "page 37", only "next". That's fine for a work queue.
Trigram search has no ranking or stemming. If relevance matters later, I'd add a `tsvector` column
next to it, or move search to a dedicated engine.

## 6. What I chose not to build

- **Websockets / live updates.** The UI polls every 15 seconds and on focus. Conflicts are caught by
  `version` anyway, so live push would only make things feel faster; correctness doesn't depend on it.
- **Email or Slack delivery.** Handlers write to a `Notification` table. A real channel would be one
  more handler with the same idempotency rule.
- **Membership/team management, sign-up, SSO, password reset, file attachments.** Out of scope; the
  seed provides users and teams.
- **A frontend design system.** Plain CSS. Effort went into error handling and rollback instead.
- **Generic "audit everything" middleware.** History is written explicitly by each service function,
  so each event is visible in the code next to the change it describes.

## At 10x scale (and beyond)

- **Reads:** send list and dashboard queries to a read replica. Writes and the "reload after
  conflict" read stay on the primary.
- **ActivityEvent growth:** partition by month (`createdAt`) so old history is cheap to archive, and
  timeline queries only touch recent partitions.
- **Search:** move to OpenSearch/Elasticsearch fed from the outbox, once ranking or typo tolerance
  is needed or trigram indexes get too large.
- **Queue:** keep the outbox as the source of truth, but have a relay publish jobs to a real queue
  (SQS/Kafka) so consumers scale independently of Postgres.
- **Live updates:** websockets or server-sent events for item changes, fed by the same events, to
  cut polling load.
- **Housekeeping:** scheduled cleanup of old idempotency keys and DONE outbox jobs; connection
  pooling (PgBouncer) for many app instances.
