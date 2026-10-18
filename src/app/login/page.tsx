"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/client/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("lead@newtonite.dev");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: { email, password } });
      router.push("/");
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 360, margin: "80px auto" }}>
      <h1>Newtonite Ops</h1>
      <form onSubmit={submit}>
        <p>
          <label>
            Email
            <br />
            <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </label>
        </p>
        <p>
          <label>
            Password
            <br />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
        </p>
        {error && <div className="error">{error}</div>}
        <button disabled={busy}>{busy ? "Logging in..." : "Log in"}</button>
      </form>
      <p className="muted">
        Demo users (password <code>password123</code>): admin@, lead@, member@, viewer@, multi@, outsider@
        newtonite.dev
      </p>
    </main>
  );
}
