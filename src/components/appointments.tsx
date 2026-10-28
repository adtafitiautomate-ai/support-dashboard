"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, Check, Loader2, MessageSquareText, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { formatPhone } from "@/lib/format";
import { zonedToUtc } from "@/lib/hours";
import { PageHeader } from "./app-shell";
import { api, Badge, cx, relTime, useNow } from "./ui";

type Appt = {
  id: string;
  conversation_id: string | null;
  service: string;
  preferred: string | null;
  full_name: string | null;
  status: "requested" | "confirmed" | "completed" | "no_show" | "cancelled";
  scheduled_at: string | null;
  office: string | null;
  staff_note: string | null;
  created_at: string;
  updated_at: string;
  contact: { name: string | null; wa_id: string } | null;
  handler: { full_name: string } | null;
};
type View = "requested" | "upcoming" | "past";

const field = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-black/30";
const STATUS: Record<Appt["status"], { label: string; tone: "amber" | "green" | "blue" | "red" | "neutral" }> = {
  requested: { label: "Requested", tone: "amber" },
  confirmed: { label: "Confirmed", tone: "blue" },
  completed: { label: "Attended", tone: "green" },
  no_show: { label: "No-show", tone: "red" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/** Appointment requests from the bot (general-business tenants), confirmed by staff. */
export function AppointmentsView() {
  const now = useNow(60_000);
  const tenants = useStore((s) => [...s.mvnos.values()].filter((m) => m.kind === "general"));
  const [mvnoId, setMvnoId] = useState(tenants[0]?.id ?? "");
  const [view, setView] = useState<View>("requested");
  const [data, setData] = useState<{ appointments: Appt[]; counts: { requested: number; upcoming: number }; offices: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const tz = tenants.find((t) => t.id === mvnoId)?.business_hours?.tz ?? "Africa/Kampala";

  const load = useCallback(async () => {
    if (!mvnoId) return;
    const r = await fetch(`/api/appointments?mvno=${mvnoId}&view=${view}`);
    const j = await r.json();
    if (!r.ok) return setError(j.error ?? "Could not load appointments");
    setError(null);
    setData(j);
  }, [mvnoId, view]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    const iv = setInterval(() => void load(), 30_000);
    return () => (clearTimeout(t), clearInterval(iv));
  }, [load]);

  async function act(id: string, body: Record<string, unknown>, done: string) {
    setFlash(null);
    try {
      const r = await api<{ messaged: boolean | null; warning: string | null }>(`/api/appointments/${id}`, body);
      setFlash(r.warning ? { ok: false, text: r.warning } : { ok: true, text: r.messaged ? `${done} The customer was messaged on WhatsApp.` : done });
      await load();
      return true;
    } catch (e) {
      setFlash({ ok: false, text: (e as Error).message });
      return false;
    }
  }

  const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  if (!tenants.length) {
    return (
      <div className="grid h-full place-items-center p-6 text-sm text-muted">Appointments are for general-business tenants (e.g. an embassy).</div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 pb-6 sm:px-6">
      <div className="mx-auto max-w-5xl">
        <PageHeader
          title="Appointments"
          subtitle={
            <>
              <CalendarCheck className="size-3.5" /> Requests from WhatsApp. Confirm a slot and the customer is told automatically.
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

        <div className="mb-4 inline-flex rounded-full bg-white/70 p-1 text-[13px] font-medium ring-1 ring-black/5">
          {(
            [
              ["requested", "Requests", data?.counts.requested],
              ["upcoming", "Upcoming", data?.counts.upcoming],
              ["past", "Past", undefined],
            ] as const
          ).map(([v, label, n]) => (
            <button key={v} onClick={() => setView(v)} className={cx("flex items-center gap-1.5 rounded-full px-3.5 py-1.5", view === v ? "bg-zinc-900 text-white" : "text-muted hover:text-ink")}>
              {label}
              {!!n && <span className={cx("rounded-full px-1.5 text-[11px]", view === v ? "bg-white/20" : "bg-zinc-100")}>{n}</span>}
            </button>
          ))}
        </div>

        {error && <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {flash && <p className={cx("mb-3 rounded-xl px-3 py-2 text-sm", flash.ok ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800")}>{flash.text}</p>}

        {!data ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : !data.appointments.length ? (
          <p className="card py-12 text-center text-sm text-muted">
            {view === "requested" ? "No requests waiting. New ones arrive here when customers book through WhatsApp." : view === "upcoming" ? "No confirmed appointments coming up." : "Nothing here yet."}
          </p>
        ) : (
          <ul className="space-y-3">
            {data.appointments.map((a) => (
              <ApptCard key={a.id} a={a} now={now} fmt={fmt} offices={data.offices} onAct={act} tz={tz} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ApptCard({
  a,
  now,
  fmt,
  offices,
  tz,
  onAct,
}: {
  a: Appt;
  now: number;
  fmt: (iso: string) => string;
  offices: string[];
  tz: string;
  onAct: (id: string, body: Record<string, unknown>, done: string) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<null | "confirm" | "cancel">(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ date: "", time: "09:00", office: offices[0] ?? "", note: "", notify: true });
  const who = a.full_name || a.contact?.name || (a.contact ? formatPhone(a.contact.wa_id) : "Customer");
  const s = STATUS[a.status];

  async function run(body: Record<string, unknown>, done: string) {
    setBusy(true);
    const ok = await onAct(a.id, body, done);
    setBusy(false);
    if (ok) setMode(null);
  }
  // The slot is in the tenant's time zone, whatever the browser's own clock is.
  const iso = () => zonedToUtc(f.date, f.time, tz).toISOString();

  return (
    <li className="card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{who}</span>
            <Badge tone={s.tone}>{s.label}</Badge>
            {a.contact && <span className="text-xs text-muted">{formatPhone(a.contact.wa_id)}</span>}
          </div>
          <div className="mt-1 text-sm">
            <b className="font-medium">{a.service}</b>
            {a.scheduled_at && a.status !== "requested" ? (
              <span className="text-muted">
                {" "}
                · {fmt(a.scheduled_at)}
                {a.office ? ` · ${a.office}` : ""}
              </span>
            ) : (
              a.preferred && <span className="text-muted"> · prefers: “{a.preferred}”</span>
            )}
          </div>
          <div className="mt-1 text-xs text-muted">
            Requested {relTime(a.created_at, now)} ago{a.handler ? ` · handled by ${a.handler.full_name}` : ""}
            {a.staff_note ? ` · note: ${a.staff_note}` : ""}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {a.conversation_id && (
            <Link href={`/inbox?c=${a.conversation_id}`} className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-black/10 hover:bg-zinc-50">
              <MessageSquareText className="size-3.5" /> Chat
            </Link>
          )}
          {a.status === "requested" && (
            <>
              <button onClick={() => setMode(mode === "confirm" ? null : "confirm")} className="flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white">
                <Check className="size-3.5" /> Confirm
              </button>
              <button onClick={() => setMode(mode === "cancel" ? null : "cancel")} className="rounded-full px-3 py-1.5 text-xs font-medium text-muted hover:bg-zinc-100">
                Decline
              </button>
            </>
          )}
          {a.status === "confirmed" && (
            <>
              <button disabled={busy} onClick={() => run({ action: "complete" }, "Marked as attended.")} className="rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white">
                Attended
              </button>
              <button disabled={busy} onClick={() => run({ action: "no_show" }, "Marked as no-show.")} className="rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-black/10 hover:bg-zinc-50">
                No-show
              </button>
              <button onClick={() => setMode(mode === "cancel" ? null : "cancel")} className="rounded-full px-3 py-1.5 text-xs font-medium text-muted hover:bg-zinc-100">
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {mode === "confirm" && (
        <form
          className="mt-3 grid gap-2 rounded-2xl bg-zinc-50 p-3 ring-1 ring-black/5 sm:grid-cols-[1fr_120px_1fr]"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ action: "confirm", scheduled_at: iso(), office: f.office || undefined, note: f.note || undefined }, "Appointment confirmed.");
          }}
        >
          <input required type="date" className={field} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} aria-label="Date" />
          <input required type="time" className={field} value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} aria-label="Time" />
          {offices.length ? (
            <select className={field} value={f.office} onChange={(e) => setF({ ...f, office: e.target.value })} aria-label="Office">
              {offices.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : (
            <input className={field} value={f.office} onChange={(e) => setF({ ...f, office: e.target.value })} placeholder="Where (office)" />
          )}
          <input className={cx(field, "sm:col-span-3")} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Note for the customer (optional), e.g. Bring your old passport and 2 photos" />
          <div className="flex items-center justify-end gap-2 sm:col-span-3">
            <button type="button" onClick={() => setMode(null)} className="rounded-full px-3 py-1.5 text-xs font-medium text-muted hover:bg-zinc-100">
              <X className="inline size-3.5" /> Close
            </button>
            <button disabled={busy} className="flex items-center gap-1 rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50">
              {busy && <Loader2 className="size-3.5 animate-spin" />} Confirm & message customer
            </button>
          </div>
        </form>
      )}

      {mode === "cancel" && (
        <form
          className="mt-3 space-y-2 rounded-2xl bg-zinc-50 p-3 ring-1 ring-black/5"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ action: "cancel", note: f.note || undefined, notify: f.notify }, a.status === "requested" ? "Request declined." : "Appointment cancelled.");
          }}
        >
          <input className={field} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Reason for the customer (optional), e.g. This service is only offered online" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={f.notify} onChange={(e) => setF({ ...f, notify: e.target.checked })} /> Message the customer on WhatsApp
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setMode(null)} className="rounded-full px-3 py-1.5 text-xs font-medium text-muted hover:bg-zinc-100">
              Back
            </button>
            <button disabled={busy} className="flex items-center gap-1 rounded-full bg-red-600 px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50">
              {busy && <Loader2 className="size-3.5 animate-spin" />} {a.status === "requested" ? "Decline request" : "Cancel appointment"}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
