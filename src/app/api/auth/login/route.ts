import { json, parseBody, route } from "@/server/http";
import { sessionCookie } from "@/server/auth";
import { login } from "@/server/services/auth.service";
import { loginSchema } from "@/shared/schemas";

export const POST = route(async (req) => {
  const { email, password } = await parseBody(req, loginSchema);
  const { user, token } = await login(email, password);

  // Browser uses the httpOnly cookie; the token in the body is for API clients (Authorization: Bearer).
  const res = json({ user, token });
  res.cookies.set(sessionCookie(token));
  return res;
});
