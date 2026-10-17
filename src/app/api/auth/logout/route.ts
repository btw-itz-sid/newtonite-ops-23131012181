import { json, route } from "@/server/http";
import { sessionCookie } from "@/server/auth";

export const POST = route(async () => {
  const res = json({ ok: true });
  res.cookies.set({ ...sessionCookie(""), maxAge: 0 });
  return res;
});
