/**
 * Seed script: 4 teams, 11 users covering every role, ~5,000 work items.
 *
 * Every seeded item also gets the activity events that explain how it reached its current
 * state (CREATED -> ASSIGNEE_CHANGED -> STATE_CHANGED...), and its version equals
 * 1 + number of changes. So even seeded data obeys "history never disagrees with the item".
 *
 * Safe to run repeatedly: it does nothing if users already exist.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  PrismaClient,
  type ActivityType,
  type ItemStatus,
  type ItemType,
  type Prisma,
  type Priority,
  type Role,
} from "@prisma/client";

const prisma = new PrismaClient();

const ITEM_COUNT = Number(process.env.SEED_ITEM_COUNT ?? 5000);
const DEMO_PASSWORD = "password123";

type TeamName = "Payments" | "SRE" | "Support" | "Compliance";
const TEAM_NAMES: TeamName[] = ["Payments", "SRE", "Support", "Compliance"];

const USERS: { email: string; name: string; teams: Partial<Record<TeamName, Role>> }[] = [
  { email: "admin@newtonite.dev", name: "Asha Admin", teams: { Payments: "ADMIN" } },
  { email: "lead@newtonite.dev", name: "Leo Lead", teams: { Payments: "LEAD" } },
  { email: "member@newtonite.dev", name: "Mira Member", teams: { Payments: "MEMBER" } },
  { email: "member2@newtonite.dev", name: "Manav Member", teams: { Payments: "MEMBER" } },
  { email: "viewer@newtonite.dev", name: "Vik Viewer", teams: { Payments: "VIEWER" } },
  // In two teams, with a different role in each
  { email: "multi@newtonite.dev", name: "Maya Multi", teams: { Payments: "MEMBER", Support: "LEAD" } },
  { email: "sre.lead@newtonite.dev", name: "Sam SRE Lead", teams: { SRE: "LEAD" } },
  { email: "sre.member@newtonite.dev", name: "Sid SRE", teams: { SRE: "MEMBER" } },
  { email: "support.member@newtonite.dev", name: "Sara Support", teams: { Support: "MEMBER" } },
  // Shares no team with anyone above
  { email: "compliance.lead@newtonite.dev", name: "Cara Compliance", teams: { Compliance: "LEAD" } },
  // In no team at all: sees nothing, can do nothing
  { email: "outsider@newtonite.dev", name: "Omar Outsider", teams: {} },
];

// Deterministic pseudo-random generator (mulberry32) so every machine gets identical data.
function makeRandom(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = makeRandom(42);
const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
function weighted<T extends string>(weights: Record<T, number>): T {
  const entries = Object.entries(weights) as [T, number][];
  let roll = random() * entries.reduce((sum, [, w]) => sum + w, 0);
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

const TITLES: Record<ItemType, string[]> = {
  PAYMENT: [
    "Refund stuck for order #{n}",
    "Settlement mismatch on batch {n}",
    "Payout failed for merchant M-{n}",
    "Duplicate charge reported on txn {n}",
  ],
  INCIDENT: [
    "API latency spike in {svc}",
    "Checkout 5xx errors above threshold ({n})",
    "Database replica lag on node {n}",
    "TLS certificate expiring for {svc}",
  ],
  CUSTOMER_ISSUE: [
    "Customer cannot log in (ticket {n})",
    "Wrong invoice amount for account {n}",
    "Card declined repeatedly for customer {n}",
    "Missing cashback for user {n}",
  ],
  COMPLIANCE: [
    "KYC review for account {n}",
    "AML alert on transfer {n}",
    "Audit evidence request: {svc}",
    "Data retention check for {svc}",
  ],
  TASK: [
    "Rotate API keys for {svc}",
    "Update runbook for {svc}",
    "Remove stale feature flag F-{n}",
    "Review alert thresholds for {svc}",
  ],
};
const SERVICES = ["ledger-api", "payouts", "auth-gateway", "notifications", "risk-engine", "checkout"];

const TYPE_BY_TEAM: Record<TeamName, Partial<Record<ItemType, number>>> = {
  Payments: { PAYMENT: 70, TASK: 20, CUSTOMER_ISSUE: 10 },
  SRE: { INCIDENT: 75, TASK: 25 },
  Support: { CUSTOMER_ISSUE: 80, TASK: 20 },
  Compliance: { COMPLIANCE: 85, TASK: 15 },
};

// Happy-path order used to build a believable history for each seeded item.
const STATUS_PATH: ItemStatus[] = ["OPEN", "IN_PROGRESS", "AWAITING_APPROVAL", "RESOLVED", "CLOSED"];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function main() {
  if ((await prisma.user.count()) > 0) {
    console.log("Database already seeded, skipping. (Reset with: npx prisma migrate reset)");
    return;
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const teams = TEAM_NAMES.map((name) => ({ id: randomUUID(), name }));
  const teamId = (name: TeamName) => teams.find((t) => t.name === name)!.id;
  const users = USERS.map((u) => ({ id: randomUUID(), email: u.email, name: u.name, passwordHash }));
  const memberships = USERS.flatMap((u, i) =>
    (Object.entries(u.teams) as [TeamName, Role][]).map(([team, role]) => ({
      userId: users[i].id,
      teamId: teamId(team),
      role,
    })),
  );

  // Per team: who can do the work (MEMBER+) and who can approve (LEAD+)
  const workers = (team: TeamName) =>
    memberships.filter((m) => m.teamId === teamId(team) && m.role !== "VIEWER").map((m) => m.userId);
  const approvers = (team: TeamName) =>
    memberships
      .filter((m) => m.teamId === teamId(team) && (m.role === "LEAD" || m.role === "ADMIN"))
      .map((m) => m.userId);

  const items: Prisma.WorkItemCreateManyInput[] = [];
  const events: Prisma.ActivityEventCreateManyInput[] = [];
  const now = Date.now();

  for (let i = 0; i < ITEM_COUNT; i++) {
    const team = weighted<TeamName>({ Payments: 40, SRE: 25, Support: 20, Compliance: 15 });
    const type = weighted(TYPE_BY_TEAM[team] as Record<ItemType, number>);
    const priority = weighted<Priority>({ LOW: 25, MEDIUM: 40, HIGH: 25, URGENT: 10 });
    const status = weighted<ItemStatus>({
      OPEN: 30,
      IN_PROGRESS: 25,
      AWAITING_APPROVAL: 10,
      RESOLVED: 15,
      CLOSED: 20,
    });
    const title = pick(TITLES[type])
      .replace("{n}", String(1000 + Math.floor(random() * 9000)))
      .replace("{svc}", pick(SERVICES));

    const id = randomUUID();
    const createdById = pick(workers(team));
    // Anything past OPEN needs an owner; half of OPEN items are still unassigned.
    const assigneeId = status !== "OPEN" || random() < 0.5 ? pick(workers(team)) : null;
    const createdAt = new Date(now - Math.floor(random() * 90 * DAY));
    const dueDate =
      random() < 0.5 ? new Date(createdAt.getTime() + (1 + Math.floor(random() * 14)) * DAY) : null;
    if (dueDate) dueDate.setUTCHours(0, 0, 0, 0);

    let at = createdAt.getTime();
    const event = (type: ActivityType, actorId: string, from: object | null, to: object) => {
      events.push({
        id: randomUUID(),
        itemId: id,
        actorId,
        type,
        from: from ?? undefined,
        to,
        createdAt: new Date(at),
      });
      at += (5 + Math.floor(random() * 120)) * MINUTE;
    };

    event("CREATED", createdById, null, { title, type, priority, status: "OPEN" });
    let changes = 0;
    if (assigneeId) {
      event("ASSIGNEE_CHANGED", assigneeId, { assigneeId: null }, { assigneeId });
      changes++;
    }
    for (let s = 1; s <= STATUS_PATH.indexOf(status); s++) {
      const from = STATUS_PATH[s - 1];
      const to = STATUS_PATH[s];
      const actor = to === "RESOLVED" ? pick(approvers(team)) : assigneeId!;
      event("STATE_CHANGED", actor, { status: from }, { status: to });
      changes++;
    }

    items.push({
      id,
      title,
      description: `Seeded ${type.toLowerCase().replace("_", " ")} for the ${team} team.`,
      type,
      priority,
      status,
      teamId: teamId(team),
      assigneeId,
      createdById,
      dueDate,
      version: 1 + changes,
      createdAt,
      updatedAt: new Date(at),
    });
  }

  await prisma.$transaction(
    async (tx) => {
      await tx.team.createMany({ data: teams });
      await tx.user.createMany({ data: users });
      await tx.membership.createMany({ data: memberships });
      for (let i = 0; i < items.length; i += 1000) {
        await tx.workItem.createMany({ data: items.slice(i, i + 1000) });
      }
      for (let i = 0; i < events.length; i += 2000) {
        await tx.activityEvent.createMany({ data: events.slice(i, i + 2000) });
      }
    },
    { timeout: 120_000 },
  );

  console.log(
    `Seeded ${teams.length} teams, ${users.length} users, ${items.length} items, ${events.length} activity events.`,
  );
  console.log(`All demo users share the password: ${DEMO_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
