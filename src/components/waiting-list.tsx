"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BellRing, Download, Loader2, MessageSquareText, Search, Send, Trash2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { hasModule } from "@/lib/modules";
import { formatPhone } from "@/lib/format";
import { PageHeader, useAccess } from "./app-shell";
import { api, Badge, cx, Pager, relTime, useNow } from "./ui";

type Row = {
  id: string;
  full_name: string;
  status: "waiting" | "notified" | "needs_template";
  created_at: string;
  notified_at: string | null;
  conversation_id: string | null;
  contact: { id: string; name: string | null; wa_id: string } | null;
  batch: { label: string } | null;
};
type Data = { rows: Row[]; total: number; pageSize: number; counts: { waiting: number; arrived: number; told: number } };
type Filter = "all" | "waiting" | "arrived" | "told";

const day = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Everyone who asked to be told when their National ID card arrives, with what happened since. */
export function WaitingListView() {
  const now = useNow(60_000);
  const { isManager } = useAccess();
  const tenants = useStore((s) => [...s.mvnos.values()].filter((m) => hasModule(m, "waiting_list")));
  const isAdminOf = useStore((s) => new Set(s.memberships.filter((m) => m.user_id === s.me?.id && m.role === "admin").map((m) => m.mvno_id)));
  const isSuper = useStore((s) => !!s.me?.is_platform_admin);
  const [mvnoId, setMvnoId] = useState(tenants[0]?.id ?? "");
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const mvno = tenants.find((m) => m.id === mvnoId);
  const canCampaign = !!mvno && hasModule(mvno, "campaigns") && (isSuper || isAdminOf.has(mvnoId));

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!mvnoId) return;
      try {
        const r = await fetch(`/api/waiting-list?${new URLSearchParams({ mvno: mvnoId, status: filter, q, page: String(page) })}`, { signal });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Could not load the waiting list");
        setData(j);
        setError(null);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      }
    },
    [mvnoId, filter, q, page],
  );
  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => void load(ctl.signal), 250);
    return () => (clearTimeout(t), ctl.abort());
  }, [load]);

  if (!tenants.length) return <div className="grid h-full place-items-center p-6 text-sm text-muted">The waiting list isn&apos;t switched on for your organisation.</div>;

  async function remove(ids: string[]) {
    if (!confirm(`Take ${ids.length === 1 ? "this person" : `${ids.length} people`} off the waiting list? They won't be told when their card arrives.`)) return;
    setBusy(true);
    try {
      await api("/api/waiting-list", { action: "remove", mvnoId, ids });
      setPicked(new Set());
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const counts = data?.counts ?? { waiting: 0, arrived: 0, told: 0 };
  const filters: [Filter, string, number][] = [
    ["all", "Everyone", counts.waiting + counts.arrived + counts.told],
    ["waiting", "Waiting", counts.waiting],
    ["arrived", "Arrived, not told yet", counts.arrived],
    ["told", "Told", counts.told],
  ];
  const rows = data?.rows ?? [];

  return (
    <div className="h-full overflow-y-auto px-3 pb-6 sm:px-6">
      <div className="mx-auto max-w-5xl">
        <PageHeader
          title="Waiting list"
          subtitle={
            <>
              <BellRing className="size-3.5" /> People who asked to be told when their National ID card arrives. Each new list upload is checked against it.
            </>
          }
          actions={
            <>
              {tenants.length > 1 && (
                <select
                  value={mvnoId}
                  onChange={(e) => (setMvnoId(e.target.value), setPage(0), setPicked(new Set()))}
                  className="h-9 rounded-full bg-surface px-3 text-sm shadow-sm ring-1 ring-black/5 outline-none"
                >
                  {tenants.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              )}
              {isManager && (
                <a
                  href={`/api/waiting-list?${new URLSearchParams({ mvno: mvnoId, status: filter, q, format: "csv" })}`}
                  className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium shadow-md ring-1 ring-black/10 transition hover:bg-zinc-50"
                >
                  <Download className="size-4" /> Export CSV
                </a>
              )}
            </>
          }
        />
        {error && <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {/* WhatsApp only lets a plain message reach people who wrote in the last 24 hours, so those not told yet usually need a template. */}
        {canCampaign && (
          <div className="mb-4 flex flex-wrap gap-2">
            <Link
              href={`/audience?${new URLSearchParams({ mvno: mvnoId, campaign: "id_untold" })}`}
              className={cx("flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-medium", counts.arrived ? "bg-zinc-900 text-white" : "pointer-events-none bg-zinc-100 text-muted")}
            >
              <Send className="size-3.5" /> Message the {counts.arrived} whose ID arrived
            </Link>
            <Link
              href={`/audience?${new URLSearchParams({ mvno: mvnoId, campaign: "waiting" })}`}
              className={cx("flex items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-[13px] font-medium ring-1 ring-black/10 hover:bg-zinc-50", !counts.waiting && "pointer-events-none opacity-50")}
            >
              <Send className="size-3.5" /> Message everyone still waiting
            </Link>
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex flex-wrap rounded-full bg-white/70 p-1 text-[13px] font-medium ring-1 ring-black/5">
            {filters.map(([id, label, n]) => (
              <button
                key={id}
                onClick={() => (setFilter(id), setPage(0), setPicked(new Set()))}
                className={cx("rounded-full px-3 py-1.5", filter === id ? "bg-zinc-900 text-white" : "text-muted hover:text-ink")}
              >
                {label} <span className="tabular-nums opacity-70">{n}</span>
              </button>
            ))}
          </div>
          <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-full bg-white px-3 ring-1 ring-black/10">
            <Search className="size-4 text-muted" />
            <input value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} placeholder="Search a name or number" className="h-9 flex-1 bg-transparent text-sm outline-none" />
          </div>
          {isManager && picked.size > 0 && (
            <button onClick={() => remove([...picked])} disabled={busy} className="flex items-center gap-1.5 rounded-full px-3 py-2 text-[13px] font-medium text-danger hover:bg-red-50">
              <Trash2 className="size-3.5" /> Remove {picked.size}
            </button>
          )}
        </div>

        <section className="card overflow-hidden">
          {!data ? (
            <div className="flex items-center gap-2 p-6 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr className="border-b border-line">
                    {isManager && (
                      <th className="w-8 py-2.5 pl-4">
                        <input
                          type="checkbox"
                          aria-label="Select this page"
                          className="size-4 accent-zinc-900"
                          checked={rows.length > 0 && rows.every((r) => picked.has(r.id))}
                          onChange={(e) => {
                            const next = new Set(picked);
                            for (const r of rows) {
                              if (e.target.checked) next.add(r.id);
                              else next.delete(r.id);
                            }
                            setPicked(next);
                          }}
                        />
                      </th>
                    )}
                    <th className="px-3 py-2.5 font-medium">Name on application</th>
                    <th className="px-3 py-2.5 font-medium">WhatsApp</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 font-medium">Added</th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={cx("border-b border-line/60 last:border-0", picked.has(r.id) && "bg-zinc-50")}>
                      {isManager && (
                        <td className="py-2.5 pl-4">
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.full_name}`}
                            className="size-4 accent-zinc-900"
                            checked={picked.has(r.id)}
                            onChange={() => {
                              const next = new Set(picked);
                              if (next.has(r.id)) next.delete(r.id);
                              else next.add(r.id);
                              setPicked(next);
                            }}
                          />
                        </td>
                      )}
                      <td className="px-3 py-2.5 font-medium">{r.full_name}</td>
                      <td className="px-3 py-2.5">
                        {r.contact ? (
                          <>
                            <span className="tabular-nums">{formatPhone(r.contact.wa_id)}</span>
                            {r.contact.name && <span className="block text-xs text-muted">{r.contact.name}</span>}
                          </>
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.status === "waiting" ? (
                          <Badge tone="amber">Waiting</Badge>
                        ) : r.status === "notified" ? (
                          <Badge tone="green">Told{r.notified_at ? ` · ${day(r.notified_at)}` : ""}</Badge>
                        ) : (
                          <Badge tone="red">Arrived, not told yet</Badge>
                        )}
                        {r.batch && r.status !== "waiting" && <span className="block text-xs text-muted">{r.batch.label}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-muted">
                        {day(r.created_at)}
                        <span className="block text-xs">{relTime(r.created_at, now)} ago</span>
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        {r.conversation_id && (
                          <Link href={`/inbox?c=${r.conversation_id}`} title="Open the chat" className="inline-grid size-8 place-items-center rounded-full text-muted hover:bg-zinc-100 hover:text-ink">
                            <MessageSquareText className="size-4" />
                          </Link>
                        )}
                        {isManager && (
                          <button onClick={() => remove([r.id])} disabled={busy} title="Remove from the list" className="inline-grid size-8 place-items-center rounded-full text-muted hover:bg-red-50 hover:text-red-700">
                            <Trash2 className="size-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={6} className="px-3 py-12 text-center text-muted">
                        {q ? "Nobody matches your search." : filter === "all" ? "Nobody is waiting yet. Customers join from the bot's “Notify me” button." : "Nobody here."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} label="people" />}
      </div>
    </div>
  );
}
