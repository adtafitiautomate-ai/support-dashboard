"use client";

import { useState } from "react";
import { KeyRound, Loader2, X } from "lucide-react";
import { api, Badge, useNow } from "./ui";

export type TokenInfo = { source: "mvno" | "environment" | "none"; valid: boolean; expires_at: string | null; app: string | null; error?: string };

/** "Token: 59 days left" pill with a Renew action, shown on each connected MVNO. */
export function TokenCountdown({ token, onRenew }: { token: TokenInfo | null; onRenew: () => void }) {
  const now = useNow(60_000);
  if (!token) return null;
  let label: string;
  let tone: "green" | "amber" | "red";
  if (token.source === "none") [label, tone] = ["No access token", "red"];
  else if (!token.valid) [label, tone] = ["Token expired", "red"];
  else if (!token.expires_at) [label, tone] = ["Never expires", "green"];
  else {
    const ms = new Date(token.expires_at).getTime() - now;
    const days = Math.floor(ms / 86_400_000);
    const hours = Math.max(0, Math.floor(ms / 3_600_000));
    label = ms <= 0 ? "Token expired" : days >= 1 ? `${days} day${days === 1 ? "" : "s"} left` : `${hours}h left`;
    tone = ms <= 0 || days < 3 ? "red" : days < 14 ? "amber" : "green";
  }
  return (
    <div className="mt-2 flex w-full items-center gap-2 rounded-xl bg-white/60 px-3 py-2 text-xs">
      <KeyRound className="size-3.5 shrink-0 text-muted" />
      <span className="text-muted">WhatsApp token</span>
      <Badge tone={tone}>{label}</Badge>
      {token.valid && token.expires_at && (
        <span className="hidden text-muted sm:inline">until {new Date(token.expires_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
      )}
      {token.source === "environment" && <span className="text-muted">· shared</span>}
      <button onClick={onRenew} className="ml-auto font-medium text-ink/70 hover:text-ink">
        Renew
      </button>
    </div>
  );
}

export function RenewToken({ mvnoId, mvnoName, onClose, onSaved }: { mvnoId: string; mvnoName: string; onClose: () => void; onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ expires_at: string | null; exchanged: boolean } | null>(null);

  async function save(e: { preventDefault(): void }) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDone(await api<{ expires_at: string | null; exchanged: boolean }>("/api/admin/mvnos", { action: "set_token", id: mvnoId, token }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const close = done ? onSaved : onClose;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 backdrop-blur-sm" onClick={close}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center">
          <h2 className="text-lg font-semibold">Renew WhatsApp token · {mvnoName}</h2>
          <button onClick={close} className="ml-auto text-muted hover:text-ink" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        {done ? (
          <div className="space-y-3">
            <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              Saved{done.exchanged ? " and converted to a long-lived token" : ""}.{" "}
              {done.expires_at
                ? `Valid until ${new Date(done.expires_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.`
                : "It never expires."}
            </p>
            <button onClick={onSaved} className="w-full rounded-xl bg-zinc-900 py-2.5 text-sm font-medium text-white">
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={save} className="space-y-3">
            <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted">
              <li>developers.facebook.com → the Meta app for {mvnoName} → WhatsApp → Step 1 (API Setup).</li>
              <li>
                Click <b>Generate access token</b> and allow the {mvnoName} WhatsApp account.
              </li>
              <li>Paste it here. 24-hour tokens are converted to ~60-day tokens automatically.</li>
            </ol>
            <textarea
              required
              rows={4}
              value={token}
              onChange={(e) => setToken(e.target.value.trim())}
              placeholder="EAA…"
              className="w-full rounded-xl border border-line bg-white px-3 py-2 font-mono text-xs outline-none focus:border-black/30"
            />
            {error && <p className="text-sm text-danger">{error}</p>}
            <button
              disabled={busy || token.length < 20}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 py-2.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {busy && <Loader2 className="size-4 animate-spin" />} Save token
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
