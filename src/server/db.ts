import { PrismaClient, type Prisma } from "@prisma/client";

// One PrismaClient per process. In `next dev` modules are reloaded on every change,
// so we park the client on globalThis to avoid opening a new connection pool each time.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** The client you get inside prisma.$transaction(async (tx) => ...). */
export type Tx = Prisma.TransactionClient;
