import { prisma } from "../db";
import type { AuthUser } from "../auth";

/** Latest notifications created by the worker for the current user. */
export async function listMyNotifications(user: AuthUser) {
  return prisma.notification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}
