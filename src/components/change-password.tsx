"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, X } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";

const field = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-black/30";

/** Lets any signed-in user replace their password (e.g. after a starter password). */
export function ChangePassword({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function save(e: { preventDefault(): void }) {
    e.preventDefault();
    if (pw.length < 10) return setError("Use at least 10 characters.");
    if (pw !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setError(error.message);
    setDone(true);
  }

  return createPortal(
    <div className="fixed inset-0 z-60 grid place-items-center bg-black/25 p-4 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center">
          <h2 className="text-lg font-semibold">Change password</h2>
          <button onClick={onClose} className="ml-auto text-muted hover:text-ink" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        {done ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              <Check className="size-4" /> Password updated. Use it next time you sign in.
            </p>
            <button onClick={onClose} className="w-full rounded-xl bg-zinc-900 py-2.5 text-sm font-medium text-white">
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={save} className="space-y-3">
            <input type="password" autoComplete="new-password" placeholder="New password (10+ characters)" value={pw} onChange={(e) => setPw(e.target.value)} className={field} required />
            <input type="password" autoComplete="new-password" placeholder="Repeat new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} required />
            {error && <p className="text-sm text-danger">{error}</p>}
            <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 py-2.5 text-sm font-medium text-white disabled:opacity-60">
              {busy && <Loader2 className="size-4 animate-spin" />} Update password
            </button>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
