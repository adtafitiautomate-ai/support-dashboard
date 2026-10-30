"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { BellRing, FileUp, IdCard, Loader2, Search, Trash2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { hasModule } from "@/lib/modules";
import { supabaseBrowser } from "@/lib/supabase/client";
import { PageHeader, useAccess } from "./app-shell";
import { api, Badge, Button, cx, relTime, useNow } from "./ui";

type Batch = {
  id: string;
  label: string;
  batch_date: string | null;
  source_name: string | null;
  status: "processing" | "ready" | "failed" | "superseded";
  error: string | null;
  row_count: number;
  notified_count: number;
  created_at: string;
  uploader: { full_name: string } | null;
};
type Watch = {
  id: string;
  full_name: string;
  status: "waiting" | "notified" | "needs_template";
  created_at: string;
  notified_at: string | null;
  contact: { name: string | null; wa_id: string } | null;
  batch: { label: string } | null;
};
type Hit = { id: number; full_name: string; extra: Record<string, string>; batch: { label: string; batch_date: string | null } };

const field = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-black/30";
const day = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** National ID cards received (uploaded registers), staff search, and the "tell me when it arrives" list. */
export function IdRegisterView() {
  const now = useNow(60_000);
  const { isManager } = useAccess();
  const tenants = useStore((s) => [...s.mvnos.values()].filter((m) => hasModule(m, "id_register")));
  const [mvnoId, setMvnoId] = useState(tenants[0]?.id ?? "");
  const [data, setData] = useState<{ batches: Batch[]; watch: Watch[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!mvnoId) return;
    const r = await fetch(`/api/id-register?mvno=${mvnoId}`);
    const j = await r.json();
    if (!r.ok) return setError(j.error ?? "Could not load the register");
    setError(null);
    setData(j);
  }, [mvnoId]);
  const processing = data?.batches.some((b) => b.status === "processing");
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    const iv = setInterval(() => void load(), processing ? 5_000 : 60_000);
    return () => (clearTimeout(t), clearInterval(iv));
  }, [load, processing]);

  if (!tenants.length) return <div className="grid h-full place-items-center p-6 text-sm text-muted">The ID register isn&apos;t switched on for your organisation.</div>;

  const ready = (data?.batches ?? []).filter((b) => b.status === "ready");
  const total = ready.reduce((n, b) => n + b.row_count, 0);
  const oldest = ready.map((b) => b.batch_date ?? b.created_at).sort()[0];
  const waiting = (data?.watch ?? []).filter((w) => w.status !== "notified").length;

  return (
    <div className="h-full overflow-y-auto px-3 pb-6 sm:px-6">
      <div className="mx-auto max-w-5xl">
        <PageHeader
          title="ID register"
          subtitle={
            <>
              <IdCard className="size-3.5" /> National ID cards received. Customers check their name on WhatsApp; the bot never shows anyone else&apos;s.
            </>
          }
          actions={
            tenants.length > 1 && (
              <select value={mvnoId} onChange={(e) => setMvnoId(e.target.value)} className="h-9 rounded-full bg-surface px-3 text-sm shadow-sm ring-1 ring-black/5 outline-none">
                {tenants.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )
          }
        />
        {error && <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Cards held" value={total.toLocaleString()} />
          <Stat label="Batches" value={String(ready.length)} />
          <Stat label="Oldest batch" value={oldest ? day(oldest) : "–"} hint={oldest ? `${relTime(oldest, now)} ago` : undefined} />
          <Stat label="Waiting to be told" value={String(waiting)} />
        </div>

        {isManager && <Upload mvnoId={mvnoId} onDone={load} />}
        <StaffSearch mvnoId={mvnoId} />

        <h2 className="mt-6 mb-2 text-sm font-semibold">Batches</h2>
        {!data ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : !data.batches.length ? (
          <p className="card py-10 text-center text-sm text-muted">No registers uploaded yet. Upload the PDF of received cards and the bot can answer “has my ID arrived?”.</p>
        ) : (
          <ul className="space-y-2">
            {data.batches.map((b) => (
              <BatchRow key={b.id} b={b} mvnoId={mvnoId} canEdit={isManager} now={now} onChange={load} />
            ))}
          </ul>
        )}

        <Link href="/waiting-list" className="card mt-6 flex items-center gap-3 px-4 py-3 text-sm transition hover:bg-white/80">
          <BellRing className="size-4 text-muted" />
          <span className="flex-1">
            <span className="font-medium">Waiting list</span>
            <span className="block text-xs text-muted">{waiting} waiting or not yet told. Each new batch is checked against the list automatically.</span>
          </span>
          <span className="text-muted">→</span>
        </Link>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

function Upload({ mvnoId, onDone }: { mvnoId: string; onDone: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [date, setDate] = useState("");
  const [replaces, setReplaces] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function send() {
    if (!file) return;
    const mime = file.name.toLowerCase().endsWith(".csv") ? "text/csv" : file.type;
    if (!["application/pdf", "text/csv"].includes(mime)) return setMsg({ ok: false, text: "Upload a PDF (or a CSV with a name column)." });
    setBusy(true);
    setMsg(null);
    try {
      const up = await api<{ batchId: string; path: string; token: string }>("/api/id-register", {
        action: "upload",
        mvnoId,
        fileName: file.name,
        mime,
        size: file.size,
        label: label.trim() || undefined,
        batchDate: date || undefined,
        replaces,
      });
      const { error } = await supabaseBrowser().storage.from("registers").uploadToSignedUrl(up.path, up.token, file, { contentType: mime });
      if (error) throw new Error(error.message);
      await api("/api/id-register", { action: "process", mvnoId, batchId: up.batchId });
      setMsg({ ok: true, text: "Uploaded. Reading the names now: this can take a few minutes for a long PDF." });
      setFile(null);
      setLabel("");
      setDate("");
      if (input.current) input.current.value = "";
      await onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mb-4 p-4">
      <div className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
        <FileUp className="size-4" /> Upload a batch
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_180px_160px_auto]">
        <input ref={input} type="file" accept="application/pdf,.csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className={cx(field, "py-1.5")} />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Batch name (optional)" maxLength={80} className={field} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} title="Date the cards arrived (optional)" className={field} />
        <Button onClick={send} disabled={!file || busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : "Upload"}
        </Button>
      </div>
      <label className="mt-2 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={replaces} onChange={(e) => setReplaces(e.target.checked)} className="mt-0.5" />
        <span>
          This file is the full, updated list and <b className="font-medium">replaces earlier uploads</b>
          <span className="block text-xs text-muted">Untick only if it adds a separate batch to the current list.</span>
        </span>
      </label>
      <p className="mt-2 text-xs text-muted">
        PDF of received cards (up to 25 MB; scanned is fine, the AI reads it 5 pages at a time), or a spreadsheet saved as CSV with “surname” and “given names” (or “name”) columns. A CSV is the most
        accurate: scans can misread names. Leave the name and date empty to use what the file says.
      </p>
      {msg && <p className={cx("mt-2 rounded-xl px-3 py-2 text-sm", msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700")}>{msg.text}</p>}
    </div>
  );
}

function StaffSearch({ mvnoId }: { mvnoId: string }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  useEffect(() => {
    if (q.trim().length < 3) return;
    const t = setTimeout(async () => {
      const r = await fetch(`/api/id-register?mvno=${mvnoId}&q=${encodeURIComponent(q)}`);
      const j = await r.json();
      setHits(r.ok ? j.results : []);
    }, 300);
    return () => clearTimeout(t);
  }, [q, mvnoId]);
  const shown = q.trim().length >= 3 ? hits : null;

  return (
    <div className="card p-4">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name (staff only)" className={cx(field, "pl-9")} />
      </div>
      {shown && (
        <ul className="mt-2 divide-y divide-line text-sm">
          {!shown.length && <li className="py-2 text-muted">No match in the uploaded batches.</li>}
          {shown.map((h) => (
            <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 py-2">
              <span className="font-medium">{h.full_name}</span>
              <span className="text-xs text-muted">
                {h.batch.label}
                {h.batch.batch_date ? ` · ${day(h.batch.batch_date)}` : ""}
              </span>
              {Object.entries(h.extra ?? {}).length > 0 && (
                <span className="w-full text-xs text-muted">
                  {Object.entries(h.extra)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(" · ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BatchRow({ b, mvnoId, canEdit, now, onChange }: { b: Batch; mvnoId: string; canEdit: boolean; now: number; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  async function run(action: "process" | "delete") {
    if (action === "delete" && !confirm(`Delete "${b.label}" and its ${b.row_count} names? The bot will stop finding them.`)) return;
    setBusy(true);
    try {
      await api("/api/id-register", { action, mvnoId, batchId: b.id });
      await onChange();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="card flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{b.label}</span>
          {b.status === "ready" ? (
            <Badge tone="green">{b.row_count.toLocaleString()} names</Badge>
          ) : b.status === "processing" ? (
            <Badge tone="blue">
              <Loader2 className="mr-1 inline size-3 animate-spin" />
              Reading…
            </Badge>
          ) : b.status === "superseded" ? (
            <Badge tone="neutral">Replaced · {b.row_count.toLocaleString()} names</Badge>
          ) : (
            <Badge tone="red">Failed</Badge>
          )}
          {b.notified_count > 0 && <Badge tone="neutral">{b.notified_count} told</Badge>}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {b.batch_date ? `Arrived ${day(b.batch_date)} · ` : ""}
          {b.source_name ?? "file"} · uploaded {relTime(b.created_at, now)} ago{b.uploader ? ` by ${b.uploader.full_name}` : ""}
        </div>
        {b.status === "failed" && b.error && <div className="mt-1 text-xs text-red-700">{b.error}</div>}
      </div>
      {canEdit && (
        <div className="flex items-center gap-1.5">
          {b.status === "failed" && (
            <Button variant="ghost" onClick={() => run("process")} disabled={busy}>
              Try again
            </Button>
          )}
          <button title="Delete batch" onClick={() => run("delete")} disabled={busy} className="rounded-full p-1.5 text-muted hover:bg-red-50 hover:text-red-700">
            <Trash2 className="size-4" />
          </button>
        </div>
      )}
    </li>
  );
}
