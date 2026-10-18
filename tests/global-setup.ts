// Runs once before all tests: bring the test database schema up to date.
import { execSync } from "node:child_process";
import { TEST_DATABASE_URL } from "./test-env";

export default function setup() {
  // Tests TRUNCATE every table, so never let them point at a real database by mistake.
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to run tests against "${dbName}": the database name must end in _test`);
  }
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "inherit",
  });
}
