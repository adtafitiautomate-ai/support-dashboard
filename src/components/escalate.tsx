"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Megaphone, Send, X } from "lucide-react";
import { useStore } from "@/lib/store";
import type { Conversation } from "@/lib/types";
import { api, cx } from "./ui";

/** What the escalate form needs to know about the chat. */
export type EscalateTarget = { id: string; mvno_id: string; ticket_no: number | null };

export function EscalateDialog({ ticket, onClose, onDone }: { ticket: EscalateTarget; onClose: () => void; onDone: (c: Conversation) => void }) {
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
  // Quick check shows the vtiger tab at once; the lists and summary load in the background.
  const [vt, setVt] = useState<VtigerInfo | null>(null);
  const [vtFull, setVtFull] = useState<VtigerInfo | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    void fetch(`/api/conversations/${ticket.id}/vtiger?quick=1`)
      .then((r) => r.json())
      .then((j: VtigerInfo) => {
        if (!live) return;
        setVt(j);
        if (j.enabled && !j.existing) {
          void fetch(`/api/conversations/${ticket.id}/vtiger`)
            .then(async (r) => ((await r.json()) as VtigerInfo & { error?: string }))
            .then((full) => live && setVtFull(full.error ? { error: full.error } : full))
            .catch(() => live && setVtFull({ error: "Couldn't reach vtiger. Try again in a moment." }));
        }
      })
      .catch(() => live && setVt({ enabled: false }));
    return () => {
      live = false;
    };
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

  return createPortal(
    <div className="fixed inset-0 z-70 grid place-items-center bg-black/25 p-4 backdrop-blur-sm" onClick={onClose}>
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
          vt.existing ? (
            <VtigerForm ticketId={ticket.id} info={vt} onClose={onClose} onDone={onDone} />
          ) : !vtFull ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted">
              <Loader2 className="size-4 animate-spin" /> Loading from vtiger…
            </div>
          ) : "error" in vtFull ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{vtFull.error}</p>
          ) : (
            <VtigerForm ticketId={ticket.id} info={vtFull} onClose={onClose} onDone={onDone} />
          )
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
    </div>,
    document.body,
  );
}

type VtigerOption = { id: string; name: string };
export type VtigerInfo = {
  enabled: boolean;
  existing?: { no: string | null; url: string | null };
  options?: { organizations: VtigerOption[]; groups: VtigerOption[]; people: VtigerOption[]; priorities: string[]; severities: string[]; categories: string[] };
  defaults?: { title: string; description: string; organizationId: string; priority: string; severity: string; category: string };
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
    description: d?.description ?? "",
    note: "",
  });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ no: string; url: string | null; conversation: Conversation } | null>(null);
  const sel = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-black/30";
  const missing = !f.title.trim() ? "Add a title" : !f.organizationId ? "Choose the organization" : !f.assignedTo ? "Choose who it goes to" : f.description.trim().length < 10 ? "Add a description" : null;

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
          <button type="button" onClick={() => onDone(created.conversation)} className="rounded-full px-3 py-2 text-xs font-medium hover:bg-emerald-100">
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
        note: f.note.trim() || undefined,
        severity: f.severity || undefined,
        category: f.category || undefined,
      });
      setCreated({ ...r.ticket, conversation: r.conversation }); // stay open so the agent sees the ticket number
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
        <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
          Description {d?.description ? <span className="rounded bg-violet-50 px-1 text-[10px] font-semibold text-violet-700">AI summary · edit if needed</span> : null}
        </span>
        <textarea
          rows={5}
          className={sel}
          maxLength={5000}
          value={f.description}
          onChange={(e) => setF({ ...f, description: e.target.value })}
          placeholder="What happened, e.g. Customer 0724… bought 10GB (UGX 12,000) yesterday but didn't receive it. Transaction ID 1592…"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">Anything else for the team? (optional)</span>
        <textarea rows={2} className={sel} maxLength={2000} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Please check and credit the customer." />
      </label>
      <p className="text-[11.5px] text-muted">Below the description, vtiger also gets the customer, their number, recent messages and a link back to this chat.</p>
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
