-- Runs once, the first time the Postgres container starts with an empty volume.
-- The main database (newtonite) is created by POSTGRES_DB; this adds the test database.
CREATE DATABASE newtonite_test;
