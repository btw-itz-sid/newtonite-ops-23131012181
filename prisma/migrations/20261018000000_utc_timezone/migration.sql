-- Prisma writes DateTime values as UTC into "timestamp without time zone" columns.
-- Raw SQL (the worker's claim query) compares them with now(), which is rendered in the
-- session time zone. Pin it to UTC so both sides agree on any server, not only in Docker.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
END
$$;
