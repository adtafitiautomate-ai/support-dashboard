"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, CheckCircle2, Clock3, Loader2, Megaphone, MessageSquareText, Search, Send, Sparkles, Ticket, X } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { upsertConversation, useStore } from "@/lib/store";
import type { Contact, Conversation, ConversationStatus, Message, Priority } from "@/lib/types";
import { PageHeader } from "./app-shell";
import { useWorkspace } from "./workspace";
import { api, Avatar, Badge, cx, Empty, relTime, useNow } from "./ui";
import { SlaChip } from "./inbox/sla";
import { MessageBubble } from "./inbox/message-bubble";
import { formatPhone } from "@/lib/format";

type Row = Conversation & { contact: Pick<Contact, "name" | "wa_id"> | null };

const STATUS_LABEL: Record<ConversationStatus, string> = { bot: "With bot", open: "Open", pending: "Pending", resolved: "Resolved" };
const statusTone = { bot: "violet", open: "blue", pending: "amber", resolved: "green" } as const;
const prioTone = { low: "neutral", normal: "neutral", high: "amber", urgent: "red" } as const;

const sel = "glass h-9 rounded-full px-3 text-[13px] outline-none";

export function TicketsView() {
  const { onEvent } = useWorkspace();
  const now = useNow(30_000);
  const s = useStore((s) => s);
  const mvnos = [...s.mvnos.values()];
  const [rows, setRows] = useState<Row[] | null>(null);
  const [status, setStatus] = useState<"active" | ConversationStatus | "all">("active");
  const [priority, setPriority] = useState<"all" | Priority>("all");
  const [mvno, setMvno] = useState("all");
  const [assignee, setAssignee] = useState("all");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("t")));

  const load = useCallback(async () => {
    let query = supabaseBrowser()
      .from("conversations")
      .select("*, contact:contacts(name, wa_id)")
      .not("ticket_no", "is", null)
      .order("last_message_at", { ascending: false })
      .limit(500);
    if (status === "active") query = query.neq("status", "resolved");
    else if (status !== "all") query = query.eq("status", status);
    if (priority !== "all") query = query.eq("priority", priority);
    if (mvno !== "all") query = query.eq("mvno_id", mvno);
    if (assignee === "none") query = query.is("assignee_id", null);
    else if (assignee !== "all") query = query.eq("assignee_id", assignee);
    const { data } = await query;
    setRows((data ?? []) as Row[]);
  }, [status, priority, mvno, assignee]);

  useEffect(() => {
    let t = setTimeout(() => void load(), 0);
    const off = onEvent((table) => {
      if (table !== "conversations") return;
      clearTimeout(t);
      t = setTimeout(() => void load(), 400);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [load, onEvent]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/^#/, "");
    if (!rows) return [];
    return rows.filter(
      (r) => !term || `${r.ticket_no} ${r.subject ?? ""} ${r.last_message_preview ?? ""} ${r.contact?.name ?? ""} ${r.contact?.wa_id ?? ""}`.toLowerCase().includes(term),
    );
  }, [rows, q]);

  const open = (id: string | null) => {
    setOpenId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("t", id);
    else url.searchParams.delete("t");
    window.history.replaceState(null, "", url);
  };

  const people = [...s.profiles.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));

  return (
    <div className="flex h-full flex-col px-6 pb-5">
      <PageHeader
        title="Tickets"
        subtitle={
          <>
            <Ticket className="size-3.5" /> Chats that needed a person: handed over by the bot or assigned to an agent. Click one for details, status and history.
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="glass flex w-full max-w-xs items-center gap-2 rounded-full px-3.5 py-2">
          <Search className="size-4 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ticket #, customer, number, subject" className="w-full bg-transparent text-sm outline-none" />
        </label>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={sel}>
          <option value="active">All active</option>
          <option value="open">Open</option>
          <option value="pending">Pending</option>
          <option value="bot">With bot</option>
          <option value="resolved">Resolved</option>
          <option value="all">Everything</option>
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)} className={sel}>
          <option value="all">Any priority</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={sel}>
          <option value="all">Anyone</option>
          <option value="none">Unassigned</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name}
            </option>
          ))}
        </select>
        {mvnos.length > 1 && (
          <select value={mvno} onChange={(e) => setMvno(e.target.value)} className={sel}>
            <option value="all">All tenants</option>
            {mvnos.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        <span className="ml-auto text-xs text-muted">{rows ? `${shown.length} ticket${shown.length === 1 ? "" : "s"}` : ""}</span>
      </div>

      <section className="card min-h-0 flex-1 overflow-hidden">
        {!rows ? (
          <div className="grid h-full place-items-center">
            <Loader2 className="size-5 animate-spin text-muted" />
          </div>
        ) : !shown.length ? (
          <Empty icon={<Ticket className="size-6" />} title="No tickets match" hint="Try another filter." />
        ) : (
          <div className="h-full overflow-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 z-10 bg-white/85 text-left text-muted backdrop-blur">
                <tr>
                  {["Ticket", "Customer", "Subject", "Status", "Priority", "Assignee", "SLA", "Updated"].map((h) => (
                    <th key={h} className="border-b border-line px-4 py-2.5 font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const who = r.assignee_id ? s.profiles.get(r.assignee_id) : null;
                  return (
                    <tr key={r.id} onClick={() => open(r.id)} className={cx("cursor-pointer border-b border-line/60 transition hover:bg-white/60", openId === r.id && "bg-white")}>
                      <td className="px-4 py-2.5 font-medium whitespace-nowrap tabular-nums">#{r.ticket_no}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <Avatar name={r.contact?.name ?? r.contact?.wa_id ?? "?"} size={26} />
                          <div className="min-w-0">
                            <div className="truncate font-medium">{r.contact?.name ?? "Unknown"}</div>
                            <div className="text-[11px] text-muted">{r.contact ? formatPhone(r.contact.wa_id) : ""}</div>
                          </div>
                        </div>
                      </td>
                      <td className="max-w-80 px-4 py-2.5">
                        <div className="truncate">{r.subject ?? <span className="text-muted">{r.last_message_preview ?? "–"}</span>}</div>
                        {mvnos.length > 1 && <div className="text-[11px] text-muted">{s.mvnos.get(r.mvno_id)?.name}</div>}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={statusTone[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={prioTone[r.priority]}>{r.priority}</Badge>
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">{who ? who.full_name : <span className="text-muted">–</span>}</td>
                      <td className="px-4 py-2.5">{r.status === "open" ? <SlaChip conversation={r} now={now} compact /> : <span className="text-muted">–</span>}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-muted">{relTime(r.last_message_at, now)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {openId && <TicketDrawer id={openId} onClose={() => open(null)} onChanged={load} />}
    </div>
  );
}

function TicketDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const now = useNow(30_000);
  const { onEvent } = useWorkspace();
  const s = useStore((s) => s);
  const [t, setT] = useState<Row | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [view, setView] = useState<"activity" | "transcript">("activity");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [escalating, setEscalating] = useState(false);

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const [{ data: conv }, { data: msgs }] = await Promise.all([
      supabase.from("conversations").select("*, contact:contacts(name, wa_id)").eq("id", id).single(),
      supabase.from("messages").select("*").eq("conversation_id", id).order("created_at").limit(1000),
    ]);
    setT(conv as Row);
    setMessages((msgs ?? []) as Message[]);
  }, [id]);

  useEffect(() => {
    let tm = setTimeout(() => void load(), 0);
    const off = onEvent((table, rec) => {
      if ((table === "conversations" && rec.id === id) || (table === "messages" && rec.conversation_id === id)) {
        clearTimeout(tm);
        tm = setTimeout(() => void load(), 250);
      }
    });
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => {
      off();
      clearTimeout(tm);
      window.removeEventListener("keydown", esc);
    };
  }, [id, load, onEvent, onClose]);

  async function act(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    try {
      const { conversation } = await api<{ conversation: Conversation }>(`/api/conversations/${id}/actions`, body);
      upsertConversation(conversation);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(next: ConversationStatus) {
    if (!t || next === t.status) return;
    if (next === "resolved") return act({ action: "resolve", csat: true }, next);
    if (next === "pending") return act({ action: "pending" }, next);
    if (next === "bot") return act({ action: "return_to_bot" }, next);
    return act({ action: "reopen" }, next);
  }

  async function addNote() {
    if (!note.trim()) return;
    setBusy("note");
    try {
      await api(`/api/conversations/${id}/messages`, { text: note, internal: true });
      setNote("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const team = t ? s.memberships.filter((m) => m.mvno_id === t.mvno_id).map((m) => s.profiles.get(m.user_id)).filter((p) => !!p) : [];
  const mins = (a: string | null, b: string | null) => (a && b ? Math.max(0, Math.round((+new Date(b) - +new Date(a)) / 60000)) : null);
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "–");
  const timeline = (messages ?? []).filter((m) => m.type === "event" || m.is_internal);
  const breached = t?.sla_due_at && (t.first_response_at ? +new Date(t.first_response_at) : now) > +new Date(t.sla_due_at);

  // Portal to <body>: the app's main area is its own stacking layer, so a drawer rendered
  // inside it would sit under the top navbar.
  return createPortal(
    <div className="fixed inset-0 z-60 flex justify-end bg-zinc-900/20 backdrop-blur-[2px]" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Ticket details"
        className="relative m-2 flex h-[calc(100%-1rem)] w-full max-w-140 flex-col overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-black/5"
      >
        {!t ? (
          <div className="grid flex-1 place-items-center">
            <Loader2 className="size-5 animate-spin text-muted" />
          </div>
        ) : (
          <>
            <header className="border-b border-line px-6 pt-4 pb-5">
              {/* Toolbar row: identity left, actions right, never overlapping the title */}
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold tabular-nums">{t.ticket_no ? `#${t.ticket_no}` : "Bot chat"}</span>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                  <span className="size-2 rounded-full" style={{ background: s.mvnos.get(t.mvno_id)?.brand_color }} />
                  {s.mvnos.get(t.mvno_id)?.name}
                </span>
                <Badge tone={prioTone[t.priority]} className="capitalize">
                  {t.priority}
                </Badge>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    onClick={() => setEscalating(true)}
                    className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-black/10 transition hover:bg-zinc-100"
                    title="Email this ticket to the team that needs to act on it"
                  >
                    <Megaphone className="size-3.5" /> Escalate
                  </button>
                  <Link
                    href={`/inbox?c=${t.id}`}
                    className="flex items-center gap-1.5 rounded-full bg-zinc-900 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-700"
                  >
                    <MessageSquareText className="size-3.5" /> Reply
                  </Link>
                  <button onClick={onClose} className="grid size-8 place-items-center rounded-full text-muted transition hover:bg-zinc-100 hover:text-ink" aria-label="Close" title="Close (Esc)">
                    <X className="size-4.5" />
                  </button>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-3">
                <Avatar name={t.contact?.name ?? t.contact?.wa_id ?? "?"} size={44} />
                <div className="min-w-0">
                  <h2 className="truncate text-lg leading-tight font-semibold">{t.subject ?? `Chat with ${t.contact?.name ?? "customer"}`}</h2>
                  <p className="truncate text-[13px] text-muted">
                    {t.contact?.name ?? "Unknown"} · {t.contact ? formatPhone(t.contact.wa_id) : ""} · updated {relTime(t.last_message_at, now)} ago
                  </p>
                </div>
              </div>

              {/* Status */}
              <div className="mt-4 grid grid-cols-4 rounded-2xl bg-zinc-100 p-1 text-[13px] font-medium">
                {(["bot", "open", "pending", "resolved"] as const).map((st) => (
                  <button
                    key={st}
                    disabled={!!busy}
                    onClick={() => setStatus(st)}
                    className={cx("flex items-center justify-center gap-1.5 rounded-xl py-1.5 transition", t.status === st ? "bg-white shadow-sm" : "text-muted hover:text-ink")}
                  >
                    {busy === st ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : st === "bot" ? (
                      <Bot className="size-3.5" />
                    ) : st === "resolved" ? (
                      <CheckCircle2 className="size-3.5" />
                    ) : st === "pending" ? (
                      <Clock3 className="size-3.5" />
                    ) : (
                      <Ticket className="size-3.5" />
                    )}
                    {STATUS_LABEL[st]}
                  </button>
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="text-xs text-muted">
                  Priority
                  <select value={t.priority} onChange={(e) => act({ action: "priority", priority: e.target.value }, "priority")} className="mt-1 w-full rounded-xl border border-line bg-white px-2.5 py-1.5 text-sm text-ink">
                    {["low", "normal", "high", "urgent"].map((p) => (
                      <option key={p} value={p}>
                        {p[0].toUpperCase() + p.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-muted">
                  Assignee
                  <select value={t.assignee_id ?? ""} onChange={(e) => act({ action: "assign", userId: e.target.value || null }, "assign")} className="mt-1 w-full rounded-xl border border-line bg-white px-2.5 py-1.5 text-sm text-ink">
                    <option value="">Unassigned</option>
                    {team.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.full_name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {t.escalated_at && (
                <p className="mt-3 flex items-center gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                  <Megaphone className="size-3.5 shrink-0" /> Escalated to <b className="font-semibold">{t.escalated_to}</b> {relTime(t.escalated_at, now)} ago
                  {t.vtiger_ticket_id && (
                    <button
                      type="button"
                      onClick={async () => {
                        const j = (await (await fetch(`/api/conversations/${t.id}/vtiger`)).json()) as VtigerInfo;
                        if (j.existing?.url) window.open(j.existing.url, "_blank", "noopener");
                      }}
                      className="ml-auto shrink-0 font-semibold underline"
                    >
                      Open in vtiger
                    </button>
                  )}
                </p>
              )}
              {error && <p className="mt-2 text-xs text-danger">{error}</p>}
            </header>

            {escalating && (
              <EscalateDialog
                ticket={t}
                onClose={() => setEscalating(false)}
                onDone={async (conv) => {
                  upsertConversation(conv);
                  setEscalating(false);
                  await load();
                  onChanged();
                }}
              />
            )}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {/* Facts */}
              <div className="grid grid-cols-2 gap-2 text-[13px]">
                <Fact label="SLA due" value={fmt(t.sla_due_at)} sub={t.sla_due_at ? (breached ? "Breached" : "First reply target") : "Starts at handover"} tone={breached ? "red" : undefined} />
                <Fact label="Category" value={t.category ?? "–"} sub={t.sentiment ? `Sentiment: ${t.sentiment}` : undefined} />
                <Fact label="Opened" value={fmt(t.created_at)} sub={`${relTime(t.created_at, now)} ago`} />
                <Fact label="Handed to team" value={fmt(t.handoff_at)} sub={t.handoff_at ? undefined : "Bot only so far"} />
                <Fact
                  label="First response"
                  value={mins(t.handoff_at, t.first_response_at) !== null ? `${mins(t.handoff_at, t.first_response_at)} min` : t.handoff_at ? "Waiting" : "–"}
                  sub={t.sla_due_at ? (breached ? "SLA breached" : "Within SLA") : undefined}
                  tone={breached ? "red" : undefined}
                />
                <Fact label="Resolved" value={fmt(t.resolved_at)} sub={t.resolved_at ? `Took ${mins(t.created_at, t.resolved_at)} min` : undefined} />
                <Fact label="CSAT" value={t.csat_score ? `${"★".repeat(t.csat_score)}${"☆".repeat(5 - t.csat_score)}` : "–"} />
                <Fact label="Assigned to" value={t.assignee_id ? (s.profiles.get(t.assignee_id)?.full_name ?? "–") : "Unassigned"} />
              </div>

              {t.ai_summary && (
                <div className="mt-3 rounded-2xl bg-zinc-50 p-3 text-[13px]">
                  <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
                    <Sparkles className="size-3.5 text-violet-500" /> AI summary
                  </div>
                  {t.ai_summary}
                </div>
              )}

              {/* Activity / transcript */}
              <div className="mt-5 mb-2 flex gap-1 rounded-full bg-zinc-100 p-1 text-[12.5px] font-medium">
                {(["activity", "transcript"] as const).map((v) => (
                  <button key={v} onClick={() => setView(v)} className={cx("flex-1 rounded-full py-1.5 capitalize", view === v ? "bg-white shadow-sm" : "text-muted")}>
                    {v === "activity" ? `Activity & notes (${timeline.length})` : `Transcript (${(messages ?? []).filter((m) => !m.is_internal && m.type !== "event").length})`}
                  </button>
                ))}
              </div>

              {view === "activity" ? (
                <ol className="relative mt-3 space-y-3 border-l border-line pl-4">
                  {timeline.length === 0 && <li className="text-xs text-muted">No activity yet.</li>}
                  {timeline.map((m) => (
                    <li key={m.id} className="relative">
                      <span className={cx("absolute top-1.5 -left-5.25 size-2.5 rounded-full ring-4 ring-white", m.type === "event" ? "bg-zinc-400" : "bg-amber-400")} />
                      <div className="text-[11px] text-muted">
                        {fmt(m.created_at)} · {m.type === "event" ? "Event" : `Note by ${m.sender_id ? (s.profiles.get(m.sender_id)?.full_name ?? "Agent") : "Pax (bot)"}`}
                      </div>
                      <div className={cx("mt-0.5 text-[13px] whitespace-pre-wrap", m.type !== "event" && "rounded-xl bg-amber-50 px-3 py-2")}>{m.body}</div>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="rounded-2xl bg-zinc-50 p-3">
                  {(messages ?? [])
                    .filter((m) => !m.is_internal && m.type !== "event")
                    .map((m) => (
                      <MessageBubble key={m.id} m={m} authorName={m.sender_id ? s.profiles.get(m.sender_id)?.full_name : undefined} />
                    ))}
                </div>
              )}
            </div>

            <footer className="border-t border-line p-3">
              <div className="flex items-end gap-2 rounded-2xl border border-line bg-amber-50/50 p-2 focus-within:border-amber-400">
                <textarea
                  rows={1}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void addNote();
                    }
                  }}
                  placeholder="Add an internal note (team only)…"
                  className="max-h-32 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm outline-none"
                />
                <button onClick={addNote} disabled={!note.trim() || busy === "note"} className="grid size-8 place-items-center rounded-full bg-amber-500 text-white disabled:opacity-40">
                  {busy === "note" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                </button>
              </div>
            </footer>
          </>
        )}
      </aside>
    </div>,
    document.body,
  );
}

function Fact({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "red" }) {
  return (
    <div className="rounded-xl bg-zinc-50 px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={cx("font-medium", tone === "red" && "text-danger")}>{value}</div>
      {sub && <div className={cx("text-[11px]", tone === "red" ? "text-danger" : "text-muted")}>{sub}</div>}
    </div>
  );
}

function EscalateDialog({ ticket, onClose, onDone }: { ticket: Row; onClose: () => void; onDone: (c: Conversation) => void }) {
  const mvno = useStore((s) => s.mvnos.get(ticket.mvno_id));
  const canTypeAddress = useStore(
    (s) => !!s.me?.is_platform_admin || s.memberships.some((m) => m.user_id === s.me?.id && m.mvno_id === ticket.mvno_id && m.role !== "agent"),
  );
  const contacts = mvno?.escalation_contacts ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  const [extra, setExtra] = useState("");
  const [note, setNote] = useState("");
  const [transcript, setTranscript] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = (picked.length > 0 || extra.trim().length > 0) && note.trim().length >= 3;
  const [mode, setMode] = useState<"email" | "vtiger">("email");
  const [vt, setVt] = useState<VtigerInfo | null>(null);
  useEffect(() => {
    void fetch(`/api/conversations/${ticket.id}/vtiger`)
      .then((r) => r.json())
      .then((j: VtigerInfo) => setVt(j))
      .catch(() => setVt({ enabled: false }));
  }, [ticket.id]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const { conversation } = await api<{ conversation: Conversation }>(`/api/conversations/${ticket.id}/escalate`, {
        contactIds: picked,
        extraEmail: extra.trim() || undefined,
        note,
        includeTranscript: transcript,
      });
      onDone(conversation);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-0 z-10 grid place-items-center bg-white/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === "email" && ready && !busy) void send();
        }}
        className="max-h-full w-full max-w-md space-y-4 overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl ring-1 ring-black/10"
      >
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200">
            <Megaphone className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">Escalate {ticket.ticket_no ? `ticket #${ticket.ticket_no}` : "this chat"}</h3>
            <p className="text-xs text-muted">
              {mode === "email" ? "Emails the ticket details to the team that needs to act." : "Creates a ticket in vtiger with the details filled in."} The customer is not notified.
            </p>
          </div>
          <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-full text-muted hover:bg-zinc-100" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        {vt?.enabled && (
          <div className="grid grid-cols-2 rounded-2xl bg-zinc-100 p-1 text-[13px] font-medium">
            {(
              [
                ["email", "Email a team"],
                ["vtiger", "vtiger ticket"],
              ] as const
            ).map(([m, label]) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={cx("rounded-xl py-1.5 transition", mode === m ? "bg-white shadow-sm" : "text-muted hover:text-ink")}>
                {label}
              </button>
            ))}
          </div>
        )}

        {mode === "vtiger" && vt?.enabled ? (
          <VtigerForm ticketId={ticket.id} info={vt} onClose={onClose} onDone={onDone} />
        ) : (
        <>
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">Send to</div>
          {contacts.length ? (
            <div className="flex flex-wrap gap-1.5">
              {contacts.map((c) => {
                const on = picked.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setPicked(on ? picked.filter((x) => x !== c.id) : [...picked, c.id])}
                    title={c.emails.join(", ")}
                    className={cx("rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition", on ? "bg-zinc-900 text-white ring-zinc-900" : "ring-black/10 hover:bg-zinc-100")}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="rounded-xl bg-zinc-50 px-3 py-2 text-xs text-muted">
              No escalation contacts set for {mvno?.name}. A tenant admin can add them in Settings → Escalations.
            </p>
          )}
          {canTypeAddress && (
            <input
              type="email"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="Or type an email address"
              className="mt-2 w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-black/30"
            />
          )}
        </div>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">What do you need from them?</span>
          <textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            placeholder="e.g. Customer was debited UGX 20,000 for a bundle they didn't receive. Please confirm and reverse."
            className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-black/30"
            autoFocus
          />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={transcript} onChange={(e) => setTranscript(e.target.checked)} className="size-4 accent-zinc-900" />
          Include the recent chat (last 30 messages)
        </label>

        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm font-medium text-muted hover:bg-zinc-100">
            Cancel
          </button>
          <button
            disabled={!ready || busy}
            className="flex items-center gap-1.5 rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send escalation
          </button>
        </div>
        </>
        )}
      </form>
    </div>
  );
}

type VtigerOption = { id: string; name: string };
type VtigerInfo = {
  enabled: boolean;
  existing?: { no: string | null; url: string | null };
  options?: { organizations: VtigerOption[]; groups: VtigerOption[]; people: VtigerOption[]; priorities: string[]; severities: string[]; categories: string[] };
  defaults?: { title: string; organizationId: string; priority: string; severity: string; category: string };
};

/** "vtiger ticket" tab: creates ONE real HelpDesk ticket in vtiger (production) after a confirm step. */
function VtigerForm({ ticketId, info, onClose, onDone }: { ticketId: string; info: VtigerInfo; onClose: () => void; onDone: (c: Conversation) => void }) {
  const d = info.defaults;
  const o = info.options;
  const [f, setF] = useState({
    title: d?.title ?? "",
    organizationId: d?.organizationId ?? "",
    assignedTo: "",
    priority: d?.priority ?? "Normal",
    severity: d?.severity ?? "",
    category: d?.category ?? "",
    note: "",
  });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ no: string; url: string | null } | null>(null);
  const sel = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-black/30";
  const missing = !f.title.trim() ? "Add a title" : !f.organizationId ? "Choose the organization" : !f.assignedTo ? "Choose who it goes to" : f.note.trim().length < 3 ? "Add a note" : null;

  if (info.existing) {
    return (
      <div className="space-y-3 rounded-2xl bg-zinc-50 p-4 text-sm ring-1 ring-black/5">
        <p>
          This chat is already in vtiger as <b>{info.existing.no}</b>. Add updates there, or as an internal note here.
        </p>
        {info.existing.url && (
          <a href={info.existing.url} target="_blank" rel="noopener noreferrer" className="inline-flex rounded-full bg-zinc-900 px-4 py-2 text-xs font-medium text-white">
            Open {info.existing.no} in vtiger
          </a>
        )}
      </div>
    );
  }
  if (created) {
    return (
      <div className="space-y-3 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-900 ring-1 ring-emerald-200">
        <p>
          Created <b>{created.no}</b> in vtiger.
        </p>
        <div className="flex gap-2">
          {created.url && (
            <a href={created.url} target="_blank" rel="noopener noreferrer" className="rounded-full bg-zinc-900 px-4 py-2 text-xs font-medium text-white">
              Open in vtiger
            </a>
          )}
          <button type="button" onClick={onClose} className="rounded-full px-3 py-2 text-xs font-medium hover:bg-emerald-100">
            Close
          </button>
        </div>
      </div>
    );
  }
  if (!o) return <Loader2 className="size-4 animate-spin text-muted" />;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ conversation: Conversation; ticket: { no: string; url: string | null } }>(`/api/conversations/${ticketId}/vtiger`, {
        ...f,
        severity: f.severity || undefined,
        category: f.category || undefined,
      });
      setCreated(r.ticket);
      onDone(r.conversation);
    } catch (e) {
      setError((e as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Title</span>
        <input className={sel} value={f.title} maxLength={250} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Bought data but didn't receive" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Organization</span>
          <select className={sel} value={f.organizationId} onChange={(e) => setF({ ...f, organizationId: e.target.value })}>
            <option value="">Choose…</option>
            {o.organizations.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Assign to</span>
          <select className={sel} value={f.assignedTo} onChange={(e) => setF({ ...f, assignedTo: e.target.value })}>
            <option value="">Choose…</option>
            {o.people.length > 0 && (
              <optgroup label="People">
                {o.people.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Groups">
              {o.groups.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Category</span>
          <select className={sel} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            <option value="">None</option>
            {o.categories.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Priority</span>
            <select className={sel} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              {o.priorities.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Severity</span>
            <select className={sel} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
              <option value="">None</option>
              {o.severities.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Note for the team</span>
        <textarea
          rows={3}
          className={sel}
          maxLength={2000}
          value={f.note}
          onChange={(e) => setF({ ...f, note: e.target.value })}
          placeholder="What's wrong and what you need, e.g. Customer 0724… bought 10GB (UGX 12,000) yesterday, not received. Please check and credit."
        />
      </label>
      <p className="text-[11.5px] text-muted">The customer, their number, the summary, recent messages and a link back to this chat are added automatically.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {confirming ? (
          <>
            <span className="mr-auto text-sm text-amber-800">This creates a real ticket in vtiger. Continue?</span>
            <button type="button" onClick={() => setConfirming(false)} className="rounded-full px-3 py-2 text-sm font-medium text-muted hover:bg-zinc-100">
              Back
            </button>
            <button type="button" disabled={busy} onClick={create} className="flex items-center gap-1.5 rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy && <Loader2 className="size-4 animate-spin" />} Yes, create it
            </button>
          </>
        ) : (
          <>
            {missing && <span className="mr-auto text-xs text-muted">{missing}</span>}
            <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm font-medium text-muted hover:bg-zinc-100">
              Cancel
            </button>
            <button type="button" disabled={!!missing} onClick={() => setConfirming(true)} className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
              Create vtiger ticket
            </button>
          </>
        )}
      </div>
    </div>
  );
}
