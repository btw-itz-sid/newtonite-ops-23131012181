import bcrypt from "bcryptjs";
import { prisma } from "../db";
import { AppError } from "../errors";
import { loadAuthUser, signSessionToken, type AuthUser } from "../auth";

// Compared against when the email doesn't exist, so "unknown email" and "wrong password"
// take about the same time and return the same error (no account enumeration).
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export async function login(email: string, password: string): Promise<{ user: AuthUser; token: string }> {
  const record = await prisma.user.findUnique({ where: { email } });
  const ok = await bcrypt.compare(password, record?.passwordHash ?? DUMMY_HASH);
  if (!record || !ok) throw new AppError(401, "INVALID_CREDENTIALS", "Wrong email or password");

  const user = (await loadAuthUser(record.id))!;
  return { user, token: await signSessionToken(record.id) };
}
