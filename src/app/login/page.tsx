"use client";

import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";

const DEMO = [
  { email: "admin@demo.test", label: "Platform admin · all MVNOs" },
  { email: "amina@nova.test", label: "Supervisor · Nova Mobile" },
  { email: "brian@nova.test", label: "Agent · Nova + Zuri" },
  { email: "chen@zuri.test", label: "Admin · Zuri Telecom" },
  { email: "dana@pulse.test", label: "Admin · Pulse Connect" },
];

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn(e?: { preventDefault(): void }, creds?: { email: string; password: string }) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.signInWithPassword(creds ?? { email, password });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    // Full load so the realtime store starts clean for this user.
    window.location.assign(new URL("/inbox", window.location.origin));
  }

  return (
    <main className="grid min-h-full place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-xl bg-surface text-ink ring-1 ring-black/10">
            <MessageCircle className="size-5" />
          </div>
          <div>
            <div className="text-base font-semibold">Relay</div>
            <div className="text-xs text-muted">WhatsApp customer care for MVNOs</div>
          </div>
        </div>

        <form onSubmit={signIn} className="space-y-3 rounded-2xl border border-line bg-surface p-5 shadow-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 outline-none focus:border-ink/30"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 outline-none focus:border-ink/30"
            />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button
            disabled={busy}
            className="w-full rounded-lg bg-surface py-2 font-medium text-ink shadow-sm ring-1 ring-black/15 transition hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {process.env.NODE_ENV !== "production" && <div className="mt-6">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Demo accounts</div>
          <div className="space-y-1.5">
            {DEMO.map((d) => (
              <button
                key={d.email}
                onClick={() => signIn(undefined, { email: d.email, password: "Password123!" })}
                className="flex w-full items-center justify-between rounded-lg border border-line bg-surface px-3 py-2 text-left text-sm transition hover:border-ink/30"
              >
                <span className="font-medium">{d.email}</span>
                <span className="text-xs text-muted">{d.label}</span>
              </button>
            ))}
          </div>
        </div>}
      </div>
    </main>
  );
}
