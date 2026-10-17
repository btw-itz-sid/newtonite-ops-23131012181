-- Hand-written migration: things the Prisma schema language cannot express.
-- Apply with `prisma migrate deploy`. If you ever run `prisma migrate dev`, check the generated
-- migration does not try to DROP these objects (Prisma does not know about them).

-- "Unassigned urgent" dashboard section. Only a small slice of items match this predicate,
-- so a partial index stays tiny and is cheap to maintain on every write.
-- The query in items.service.ts must use the SAME predicate, otherwise Postgres can't use it.
CREATE INDEX "WorkItem_unassigned_urgent_idx"
  ON "WorkItem" ("teamId", "createdAt" DESC, "id" DESC)
  WHERE "priority" = 'URGENT'
    AND "assigneeId" IS NULL
    AND "status" IN ('OPEN', 'IN_PROGRESS');

-- ActivityEvent is the audit history: it must never be edited or deleted.
-- The application never does this, and this trigger makes the database refuse it too
-- (protects against a future bug or a manual UPDATE). TRUNCATE (used by tests) is not affected.
CREATE FUNCTION activity_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ActivityEvent is append-only (% is not allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_event_append_only
  BEFORE UPDATE OR DELETE ON "ActivityEvent"
  FOR EACH ROW EXECUTE FUNCTION activity_event_append_only();
