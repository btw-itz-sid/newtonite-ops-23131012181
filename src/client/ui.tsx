"use client";
// Small pieces shared by the pages.
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api, type Item, type Me } from "./api";

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api<{ user: Me }>("/api/me").then((r) => r.user) });
}

export function Header({ me }: { me: Me }) {
  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    // Full page load so the next user starts with an empty query cache.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  }
  const roles = me.memberships.map((m) => `${m.teamName}: ${m.role}`).join(", ") || "no teams";
  return (
    <header className="header">
      <Link href="/">
        <strong>Newtonite Ops</strong>
      </Link>
      <span className="muted">
        {me.name} ({roles})
      </span>
      <button onClick={logout}>Log out</button>
    </header>
  );
}

export function ErrorBanner({ text, onReload }: { text: string | null; onReload?: () => void }) {
  if (!text) return null;
  return (
    <div className="error" role="alert">
      {text} {onReload && <button onClick={onReload}>Reload</button>}
    </div>
  );
}

export function ItemTable({ items }: { items: Item[] }) {
  if (items.length === 0) return <p className="muted">Nothing here.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>Team</th>
          <th>Type</th>
          <th>Priority</th>
          <th>Status</th>
          <th>Assignee</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>
              <Link href={`/items/${item.id}`}>{item.title}</Link>
            </td>
            <td>{item.team.name}</td>
            <td>{item.type}</td>
            <td className={item.priority === "URGENT" ? "urgent" : undefined}>{item.priority}</td>
            <td>{item.status}</td>
            <td>{item.assignee?.name ?? <span className="muted">unassigned</span>}</td>
            <td>{new Date(item.createdAt).toLocaleDateString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
