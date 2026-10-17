"use client";

import { useState } from "react";
import { Loader2, Send, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { api } from "@/components/ui";

const field = "w-full rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-ink/30";

export function NewConversation({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const mvnos = useStore((s) => [...s.mvnos.values()]);
  const [mvnoId, setMvnoId] = useState(mvnos[0]?.id ?? "");
  const [to, setTo] = useState("");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("hello_world");
  const [language, setLanguage] = useState("en_US");
  const [params, setParams] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { conversationId } = await api<{ conversationId: string }>("/api/conversations/start", {
        mvnoId,
        to: to.replace(/\D/g, ""),
        name: name || undefined,
        template,
        language,
        params: params ? params.split("|").map((p) => p.trim()) : undefined,
      });
      onCreated(conversationId);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4 backdrop-blur-sm" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="card w-full max-w-md space-y-3 p-5">
        <div className="flex items-center">
          <h2 className="text-base font-semibold">New WhatsApp message</h2>
          <button type="button" onClick={onClose} className="ml-auto text-muted hover:text-ink" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <p className="text-xs text-muted">
          WhatsApp requires an approved message template to start a conversation. Once the customer replies, you can chat freely for 24 hours.
        </p>
        <select value={mvnoId} onChange={(e) => setMvnoId(e.target.value)} className={field}>
          {mvnos.map((m) => (
            <option key={m.id} value={m.id}>
              From {m.name} · {m.wa_display_number}
            </option>
          ))}
        </select>
        <div className="grid grid-cols-2 gap-2">
          <input required value={to} onChange={(e) => setTo(e.target.value)} placeholder="2547XXXXXXXX" className={field} />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className={field} />
        </div>
        <div className="grid grid-cols-[1fr_96px] gap-2">
          <input required value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="Template name" className={field} />
          <input required value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en_US" className={field} />
        </div>
        <input value={params} onChange={(e) => setParams(e.target.value)} placeholder="Template variables, separated by |  (optional)" className={field} />
        {error && <p className="text-sm text-danger">{error}</p>}
        <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-full bg-surface py-2.5 text-sm font-medium text-ink shadow-sm ring-1 ring-black/15 hover:bg-surface-2 disabled:opacity-60">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send template
        </button>
      </form>
    </div>
  );
}
