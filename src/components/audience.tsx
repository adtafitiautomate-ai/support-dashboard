"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, Megaphone, Plus, Search, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { toIntlPrefix, toLocalPrefix } from "@/lib/audience";
import { formatPhone } from "@/lib/format";
import { PageHeader } from "./app-shell";
import { api, Badge, Button, cx, Pager, relTime, useNow } from "./ui";

type Row = { id: string; wa_id: string; name: string | null; created_at: string; last_seen_at: string | null; opted_out_at: string | null };
type Data = { prefixes: string[]; contacts: Row[]; total: number; optedOut: number; pageSize: number };

const field = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-black/30";

/** Customers who messaged from a number in the MVNO's own ranges: the campaign audience. */
export function AudienceView() {
  const now = useNow(60_000);
  const isSuper = useStore((s) => !!s.me?.is_platform_admin);
  const mvnos = useStore((s) =>
    [...s.mvnos.values()].filter((m) => s.me?.is_platform_admin || s.memberships.some((x) => x.user_id === s.me?.id && x.mvno_id === m.id && x.role !== "agent")),
  );
  const adminOf = useStore((s) => new Set(s.memberships.filter((x) => x.user_id === s.me?.id && x.role === "admin").map((x) => x.mvno_id)));
  const [mvnoId, setMvnoId] = useState(mvnos[0]?.id ?? "");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState({ key: "", page: 0 });
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const mvno = mvnos.find((m) => m.id === mvnoId);
  const canEdit = isSuper || adminOf.has(mvnoId);

  const key = `${mvnoId}|${q}`;
  const page = query.key === key ? query.page : 0;

  useEffect(() => {
    if (!mvnoId) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/audience?mvno=${mvnoId}&q=${encodeURIComponent(q)}&page=${page}`, { signal: ctl.signal });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Could not load audience");
        setData(j);
        setError(null);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      }
    }, 250);
    return () => (clearTimeout(t), ctl.abort());
  }, [mvnoId, q, page, reload]);

  return (
    <div className="h-full overflow-y-auto px-6 pb-6">
      <div className="mx-auto max-w-5xl">
        <PageHeader
          title="Audience"
          subtitle="Customers who messaged you from your own number ranges, saved for campaigns"
          actions={
            <div className="flex items-center gap-2">
              {mvnos.length > 1 && (
                <select value={mvnoId} onChange={(e) => setMvnoId(e.target.value)} className="h-9 rounded-full bg-surface px-3 text-sm shadow-sm ring-1 ring-black/5 outline-none">
                  {mvnos.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              )}
              {!!data?.prefixes.length && (
                <a
                  href={`/api/audience?mvno=${mvnoId}&format=csv`}
                  className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium shadow-md ring-1 ring-black/10 transition hover:bg-zinc-50"
                >
                  <Download className="size-4" /> Export CSV
                </a>
              )}
            </div>
          }
        />

        {error && <div className="mb-4 rounded-xl bg-red-50 px-4 py-2 text-sm text-danger ring-1 ring-red-200">{error}</div>}

        {mvno && data && (
          <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
            <div className="space-y-4">
              <div className="card p-5">
                <div className="text-xs font-medium text-muted">Customers in range</div>
                <div className="mt-1 text-3xl font-semibold tabular-nums">{(q ? "–" : data.total).toLocaleString()}</div>
                <div className="mt-1 text-xs text-muted">
                  {data.optedOut} opted out (replied STOP), excluded from exports
                </div>
              </div>
              <Ranges key={mvnoId} mvnoId={mvnoId} prefixes={data.prefixes} canEdit={canEdit} onSaved={() => setReload((n) => n + 1)} />
              <p className="px-1 text-xs leading-relaxed text-muted">
                Every customer who messages {mvno.name} is kept for support; only numbers in these ranges appear here. WhatsApp only allows promotional
                messages through approved templates, to people who agreed to receive them. Customers can reply STOP to opt out.
              </p>
            </div>

            <section className="card min-w-0 p-5">
              <div className="mb-3 flex items-center gap-2 rounded-xl bg-white px-3 ring-1 ring-black/10">
                <Search className="size-4 text-muted" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or number" className="h-10 flex-1 bg-transparent text-sm outline-none" />
              </div>
              {!data.prefixes.length ? (
                <div className="grid place-items-center py-14 text-center text-sm text-muted">
                  <Megaphone className="mb-2 size-6" />
                  No number ranges set yet.
                  <br />
                  {canEdit ? "Add your tenant's ranges on the left to build the audience." : "Ask a tenant admin to add the number ranges."}
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto rounded-2xl bg-white/50 ring-1 ring-black/5">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs text-muted">
                        <tr className="border-b border-line">
                          <th className="px-3 py-2 font-medium">Customer</th>
                          <th className="px-3 py-2 font-medium">Number</th>
                          <th className="px-3 py-2 font-medium">First contact</th>
                          <th className="px-3 py-2 font-medium">Last contact</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.contacts.map((c) => (
                          <tr key={c.id} className="border-b border-line/60 last:border-0">
                            <td className="px-3 py-2">
                              <span className="font-medium">{c.name || "Unknown"}</span>
                              {c.opted_out_at && (
                                <Badge tone="red" className="ml-2">
                                  Opted out
                                </Badge>
                              )}
                            </td>
                            <td className="px-3 py-2 tabular-nums">{formatPhone(c.wa_id)}</td>
                            <td className="px-3 py-2 text-muted">{new Date(c.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</td>
                            <td className="px-3 py-2 text-muted">{c.last_seen_at ? relTime(c.last_seen_at, now) : "–"}</td>
                          </tr>
                        ))}
                        {!data.contacts.length && (
                          <tr>
                            <td colSpan={4} className="px-3 py-10 text-center text-muted">
                              {q ? "No customers match your search." : "No customers from these ranges have messaged yet."}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={(n) => setQuery({ key, page: n })} label="customers" />
                </>
              )}
            </section>
          </div>
        )}
        {!data && !error && (
          <div className="flex items-center gap-2 py-10 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Loading audience…
          </div>
        )}
      </div>
    </div>
  );
}

function Ranges({ mvnoId, prefixes, canEdit, onSaved }: { mvnoId: string; prefixes: string[]; canEdit: boolean; onSaved: () => void }) {
  const [list, setList] = useState(prefixes);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = list.join() !== prefixes.join();

  function add() {
    const p = toIntlPrefix(draft);
    if (p.length < 5) return setMsg({ ok: false, text: "Enter at least 4 digits, e.g. 07243" });
    if (!list.includes(p)) setList([...list, p]);
    setDraft("");
    setMsg(null);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ prefixes: string[] }>("/api/audience", { mvnoId, prefixes: list });
      setList(r.prefixes);
      setMsg({ ok: true, text: "Saved" });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <div className="text-sm font-medium">Number ranges</div>
      <p className="mt-0.5 text-xs text-muted">Numbers starting with any of these are saved to the audience.</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {list.map((p) => (
          <span key={p} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 font-mono text-xs">
            {toLocalPrefix(p)}…
            {canEdit && (
              <button onClick={() => setList(list.filter((x) => x !== p))} className="text-muted hover:text-ink" aria-label={`Remove ${toLocalPrefix(p)}`}>
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {!list.length && <span className="text-xs text-muted">None yet</span>}
      </div>
      {canEdit && (
        <>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input className={cx(field, "font-mono")} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. 07243" inputMode="tel" />
            <Button type="submit" aria-label="Add range">
              <Plus className="size-4" />
            </Button>
          </form>
          <div className="mt-3 flex items-center gap-3">
            <Button variant="primary" disabled={!dirty || busy} onClick={save}>
              {busy && <Loader2 className="size-4 animate-spin" />} Save ranges
            </Button>
            {msg && <span className={cx("text-sm", msg.ok ? "text-accent" : "text-danger")}>{msg.text}</span>}
          </div>
        </>
      )}
    </div>
  );
}
