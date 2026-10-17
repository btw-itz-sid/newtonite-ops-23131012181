// Session handling: a signed JWT that only contains the user id.
// Roles are NOT put in the token: memberships are loaded from the DB on every request,
// so removing someone from a team takes effect immediately.
import { SignJWT, jwtVerify } from "jose";
import type { Role } from "@prisma/client";
import { prisma } from "./db";
import { unauthenticated } from "./errors";

export const SESSION_COOKIE = "session";
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60; // one working shift

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  memberships: { teamId: string; teamName: string; role: Role }[];
};

function secretKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("JWT_SECRET must be set and at least 32 characters");
  return new TextEncoder().encode(secret);
}

export async function signSessionToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    return payload.sub ?? null;
  } catch {
    return null; // expired, tampered or malformed: treat as logged out
  }
}

/** Token from `Authorization: Bearer ...` (API clients, tests) or the httpOnly cookie (browser). */
function readToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();

  const cookies = req.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { memberships: { include: { team: true } } },
  });
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    memberships: user.memberships.map((m) => ({ teamId: m.teamId, teamName: m.team.name, role: m.role })),
  };
}

/** Every API route calls this first. Throws 401 if there is no valid session. */
export async function requireUser(req: Request): Promise<AuthUser> {
  const token = readToken(req);
  const userId = token ? await verifySessionToken(token) : null;
  const user = userId ? await loadAuthUser(userId) : null;
  if (!user) throw unauthenticated();
  return user;
}

export function sessionCookie(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true, // not readable from JavaScript, so an XSS bug can't steal it
    sameSite: "lax" as const, // not sent on cross-site POSTs (basic CSRF protection)
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
