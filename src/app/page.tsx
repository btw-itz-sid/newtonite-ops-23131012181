"use client";
// Dashboard: three "needs attention" views, a create form, and the filterable item list.
// All filtering, search and pagination happen on the server; the browser only holds one page at a time.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRef, useState } from "react";
import { api, errorText, toQuery, type Item, type ItemDetail, type Me, type Notification, type Page } from "@/client/api";
import { Badge, ErrorBanner, Header, ItemTable, useMe } from "@/client/ui";
import { ITEM_TYPES, PRIORITIES, STATUSES, type ItemType, type Priority } from "@/shared/constants";

export default function DashboardPage() {
  const me = useMe();
  if (me.isPending) return <p>Loading...</p>;
  if (!me.data) return <ErrorBanner text={errorText(me.error)} />;
  return (
    <main>
      <Header me={me.data} />
      <div className="grid3">
        <ViewSection title="Assigned to me" view="assigned_to_me" />
        <ViewSection title="Unassigned urgent" view="unassigned_urgent" />
        <ViewSection title="Awaiting my approval" view="awaiting_my_approval" />
      </div>
      <Notifications />
      <CreateItemForm me={me.data} />
      <ItemList me={me.data} />
    </main>
  );
}

function ViewSection({ title, view }: { title: string; view: string }) {
  const query = useQuery({
    queryKey: ["items", "view", view],
    queryFn: () => api<Page<Item>>(`/api/items?${toQuery({ view, limit: "5" })}`),
  });
  return (
    <section className="card">
      <h3>{title}</h3>
      <ErrorBanner text={query.error ? errorText(query.error) : null} />
      <ul>
        {query.data?.items.map((item) => (
          <li key={item.id}>
            <Link href={`/items/${item.id}`}>{item.title}</Link> <Badge value={item.priority} />{" "}
            <Badge value={item.status} />
          </li>
        ))}
      </ul>
      {query.data?.items.length === 0 && <p className="muted">Nothing here.</p>}
    </section>
  );
}

function Notifications() {
  const query = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api<{ notifications: Notification[] }>("/api/notifications").then((r) => r.notifications),
  });
  if (!query.data?.length) return null;
  return (
    <section className="card">
      <h3>Notifications</h3>
      <ul>
        {query.data.slice(0, 5).map((n) => (
          <li key={n.id}>
            <Link href={`/items/${n.itemId}`}>{n.message}</Link>{" "}
            <span className="muted">{new Date(n.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CreateItemForm({ me }: { me: Me }) {
  const qc = useQueryClient();
  const teams = me.memberships.filter((m) => m.role !== "VIEWER");
  const [teamId, setTeamId] = useState(teams[0]?.teamId ?? "");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<ItemType>("TASK");
  const [priority, setPriority] = useState<Priority>("MEDIUM");
  // One key per form submission: a double click or a retry after a timeout sends the same key,
  // so the server creates the item once. A new key is made only after a success.
  const idempotencyKey = useRef(crypto.randomUUID());

  const create = useMutation({
    mutationFn: () =>
      api<ItemDetail>("/api/items", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey.current },
        body: { teamId, title, type, priority },
      }),
    onSuccess: () => {
      idempotencyKey.current = crypto.randomUUID();
      setTitle("");
      qc.invalidateQueries({ queryKey: ["items"] });
    },
  });

  if (teams.length === 0) return null; // VIEWERs and users without a team can't create items
  return (
    <section className="card">
      <h3>New item</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          {teams.map((t) => (
            <option key={t.teamId} value={t.teamId}>
              {t.teamName}
            </option>
          ))}
        </select>
        <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} size={40} />
        <select value={type} onChange={(e) => setType(e.target.value as ItemType)}>
          {ITEM_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
          {PRIORITIES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <button disabled={create.isPending}>Create</button>
      </form>
      <ErrorBanner text={create.error ? errorText(create.error) : null} />
    </section>
  );
}

type Filters = { status?: string; priority?: string; type?: string; team?: string; assignee?: string; q?: string };

function ItemList({ me }: { me: Me }) {
  const [filters, setFilters] = useState<Filters>({});
  const [search, setSearch] = useState("");
  const set = (key: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) =>
    setFilters((f) => ({ ...f, [key]: e.target.value || undefined }));

  const list = useInfiniteQuery({
    queryKey: ["items", "list", filters],
    queryFn: ({ pageParam }) => api<Page<Item>>(`/api/items?${toQuery({ ...filters, cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section className="card">
      <h3>All items</h3>
      <div className="row">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFilters((f) => ({ ...f, q: search.trim() || undefined }));
          }}
        >
          <input placeholder="Search title or description" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button>Search</button>
        </form>
        <select value={filters.status ?? ""} onChange={set("status")}>
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={filters.priority ?? ""} onChange={set("priority")}>
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select value={filters.type ?? ""} onChange={set("type")}>
          <option value="">Any type</option>
          {ITEM_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select value={filters.team ?? ""} onChange={set("team")}>
          <option value="">All my teams</option>
          {me.memberships.map((m) => (
            <option key={m.teamId} value={m.teamId}>
              {m.teamName}
            </option>
          ))}
        </select>
        <select value={filters.assignee ?? ""} onChange={set("assignee")}>
          <option value="">Anyone</option>
          <option value="me">Me</option>
          <option value="none">Unassigned</option>
        </select>
      </div>
      <ErrorBanner text={list.error ? errorText(list.error) : null} />
      {list.isPending ? <p>Loading...</p> : <ItemTable items={items} />}
      {list.hasNextPage && (
        <button onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          {list.isFetchingNextPage ? "Loading..." : "Load more"}
        </button>
      )}
    </section>
  );
}
