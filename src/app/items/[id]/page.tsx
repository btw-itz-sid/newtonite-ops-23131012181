"use client";
import { useInfiniteQuery, useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import {
  api,
  ApiError,
  errorText,
  type ActivityEvent,
  type Item,
  type ItemDetail,
  type Page,
  type TeamMember,
} from "@/client/api";
import { ErrorBanner, Header, useMe } from "@/client/ui";
import { PRIORITIES, type ItemStatus, type Priority } from "@/shared/constants";

/**
 * OPTIMISTIC UPDATE WITH ROLLBACK.
 * onMutate: show the change immediately and keep a copy of what was there before.
 * onError: put the copy back, so the screen never shows a change the server refused.
 * onSuccess: replace the guess with the server's item (new version, server-side fields).
 */
function useItemMutation<V>(
  id: string,
  opts: {
    request: (vars: V) => Promise<ItemDetail>;
    apply: (item: Item, vars: V) => Item;
    onError: (err: unknown) => void;
  },
) {
  const qc = useQueryClient();
  const key = ["item", id];
  return useMutation({
    mutationKey: ["item-action", id],
    mutationFn: opts.request,
    onMutate: async (vars: V) => {
      await qc.cancelQueries({ queryKey: key }); // a poll landing now would overwrite our guess
      const previous = qc.getQueryData<ItemDetail>(key);
      if (previous) qc.setQueryData<ItemDetail>(key, { ...previous, item: opts.apply(previous.item, vars) });
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
      opts.onError(err);
    },
    // After a failure the page keeps showing the old state (header and timeline alike) until the
    // user presses Reload, so it never mixes old and new data.
    onSuccess: (detail) => {
      qc.setQueryData(key, detail);
      qc.invalidateQueries({ queryKey: ["activity", id] });
      qc.invalidateQueries({ queryKey: ["items"] });
    },
  });
}

export default function ItemPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const qc = useQueryClient();
  const [error, setError] = useState<{ text: string; conflict: boolean } | null>(null);
  const busy = useIsMutating({ mutationKey: ["item-action", id] }) > 0;

  const detail = useQuery({ queryKey: ["item", id], queryFn: () => api<ItemDetail>(`/api/items/${id}`) });
  const item = detail.data?.item;
  const can = detail.data?.permissions;

  const members = useQuery({
    queryKey: ["members", item?.teamId],
    queryFn: () => api<{ members: TeamMember[] }>(`/api/teams/${item!.teamId}/members`).then((r) => r.members),
    enabled: !!item && !!can?.canAssign,
  });

  const showError = (err: unknown) =>
    setError({ text: errorText(err), conflict: err instanceof ApiError && err.status === 409 });
  const reload = () => {
    setError(null);
    qc.invalidateQueries({ queryKey: ["item", id] });
    qc.invalidateQueries({ queryKey: ["activity", id] });
  };

  const claim = useItemMutation<{ version: number }>(id, {
    request: () => api(`/api/items/${id}/claim`, { method: "POST" }),
    apply: (item) => ({ ...item, assigneeId: me.data!.id, assignee: { id: me.data!.id, name: me.data!.name } }),
    onError: showError,
  });

  const transition = useItemMutation<{ to: ItemStatus; version: number }>(id, {
    request: (vars) =>
      api(`/api/items/${id}/transition`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: vars,
      }),
    apply: (item, vars) => ({ ...item, status: vars.to }),
    onError: showError,
  });

  const update = useItemMutation<{ version: number } & Partial<Pick<Item, "title" | "description" | "priority" | "assigneeId">>>(
    id,
    {
      request: (vars) => api(`/api/items/${id}`, { method: "PATCH", body: vars }),
      apply: (item, vars) => {
        const next = { ...item, ...vars, version: item.version };
        if (vars.assigneeId !== undefined) {
          const member = members.data?.find((m) => m.id === vars.assigneeId);
          next.assignee = member ? { id: member.id, name: member.name } : null;
        }
        return next;
      },
      onError: showError,
    },
  );

  if (detail.isPending || me.isPending) return <p>Loading...</p>;
  if (!item || !can || !me.data) {
    return (
      <main>
        {me.data && <Header me={me.data} />}
        <ErrorBanner text={errorText(detail.error)} />
      </main>
    );
  }

  const run = (action: () => void) => {
    setError(null);
    action();
  };

  return (
    <main>
      <Header me={me.data} />
      <ErrorBanner text={error?.text ?? null} onReload={error?.conflict ? reload : undefined} />

      <h2>{item.title}</h2>
      <p className="muted">
        {item.team.name} / {item.type} / created by {item.createdBy.name} on{" "}
        {new Date(item.createdAt).toLocaleString()} / version {item.version}
        {item.dueDate && <> / due {item.dueDate.slice(0, 10)}</>}
      </p>
      <p style={{ whiteSpace: "pre-wrap" }}>{item.description || <span className="muted">No description</span>}</p>

      <div className="row">
        <strong>Status:</strong> {item.status}
        {can.transitions.map((to) => (
          <button
            key={to}
            disabled={busy}
            onClick={() => run(() => transition.mutate({ to, version: item.version }))}
          >
            Move to {to}
          </button>
        ))}
      </div>

      <div className="row">
        <strong>Assignee:</strong> {item.assignee?.name ?? <span className="muted">unassigned</span>}
        {can.canClaim && (
          <button disabled={busy} onClick={() => run(() => claim.mutate({ version: item.version }))}>
            Claim
          </button>
        )}
        {can.canAssign && members.data && (
          <select
            value={item.assigneeId ?? ""}
            disabled={busy}
            onChange={(e) => run(() => update.mutate({ version: item.version, assigneeId: e.target.value || null }))}
          >
            <option value="">Unassigned</option>
            {members.data
              .filter((m) => m.role !== "VIEWER")
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.role})
                </option>
              ))}
          </select>
        )}
      </div>

      <div className="row">
        <strong>Priority:</strong>
        {can.canChangePriority ? (
          <select
            value={item.priority}
            disabled={busy}
            onChange={(e) => run(() => update.mutate({ version: item.version, priority: e.target.value as Priority }))}
          >
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        ) : (
          item.priority
        )}
      </div>

      {can.canEdit && (
        <EditForm
          key={item.version}
          item={item}
          busy={busy}
          onSave={(title, description) => run(() => update.mutate({ version: item.version, title, description }))}
        />
      )}

      {can.canComment && <CommentForm itemId={id} onError={showError} />}
      <Timeline itemId={id} />
    </main>
  );
}

function EditForm({
  item,
  busy,
  onSave,
}: {
  item: Item;
  busy: boolean;
  onSave: (title: string, description: string) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const changed = title !== item.title || description !== item.description;
  return (
    <details>
      <summary>Edit</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(title, description);
        }}
      >
        <p>
          <input value={title} onChange={(e) => setTitle(e.target.value)} size={60} />
        </p>
        <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
        <button disabled={busy || !changed}>Save</button>
      </form>
    </details>
  );
}

function CommentForm({ itemId, onError }: { itemId: string; onError: (err: unknown) => void }) {
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const add = useMutation({
    mutationFn: () => api(`/api/items/${itemId}/comments`, { method: "POST", body: { body } }),
    onSuccess: () => {
      setBody("");
      qc.invalidateQueries({ queryKey: ["activity", itemId] });
    },
    onError,
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <h3>Comment</h3>
      <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      <button disabled={add.isPending || !body.trim()}>Add comment</button>
    </form>
  );
}

function describe(event: ActivityEvent): string {
  const from = event.from ?? {};
  const to = event.to ?? {};
  switch (event.type) {
    case "CREATED":
      return "created the item";
    case "STATE_CHANGED":
      return `moved it from ${from.status} to ${to.status}`;
    case "PRIORITY_CHANGED":
      return `changed priority from ${from.priority} to ${to.priority}`;
    case "ASSIGNEE_CHANGED":
      if (!to.assigneeId) return "unassigned the item";
      if (to.assigneeId === event.actor.id && !from.assigneeId) return "claimed the item";
      return from.assigneeId ? "reassigned the item" : "assigned the item";
    case "COMMENT_ADDED":
      return `commented: "${to.body}"`;
    case "EDITED":
      return `edited ${Object.keys(to).join(", ")}`;
  }
}

function Timeline({ itemId }: { itemId: string }) {
  const activity = useInfiniteQuery({
    queryKey: ["activity", itemId],
    queryFn: ({ pageParam }) =>
      api<Page<ActivityEvent>>(`/api/items/${itemId}/activity${pageParam ? `?cursor=${pageParam}` : ""}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const events = activity.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section>
      <h3>Activity</h3>
      <ErrorBanner text={activity.error ? errorText(activity.error) : null} />
      <ul className="timeline">
        {events.map((e) => (
          <li key={e.id}>
            <strong>{e.actor.name}</strong> {describe(e)}{" "}
            <span className="muted">{new Date(e.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>
      {activity.hasNextPage && (
        <button onClick={() => activity.fetchNextPage()} disabled={activity.isFetchingNextPage}>
          Older events
        </button>
      )}
    </section>
  );
}
