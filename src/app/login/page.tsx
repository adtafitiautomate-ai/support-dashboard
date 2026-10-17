"use client";

import { useState } from "react";
import { ArrowRight, Headphones, Loader2, Lock, Mail } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";

const DEMO = [
  { email: "admin@demo.test", label: "Platform admin" },
  { email: "sarah@paxtel.test", label: "PaxTel supervisor" },
  { email: "david@paxtel.test", label: "PaxTel agent" },
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
      setError(error.message === "Invalid login credentials" ? "Wrong email or password." : error.message);
      setBusy(false);
      return;
    }
    // Full load so the realtime store starts clean for this user.
    window.location.assign(new URL("/inbox", window.location.origin));
  }

  return (
    <main className="grid min-h-full bg-white lg:grid-cols-[minmax(420px,1fr)_1.2fr] dark:bg-surface">
      {/* Form */}
      <section className="flex flex-col px-6 py-8 sm:px-12">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-xl bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
            <Headphones className="size-4.5" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Relay</span>
        </div>

        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight">Welcome back</h1>
          <p className="mt-1.5 text-sm text-muted">Sign in to the PaxTel customer care workspace.</p>

          <form onSubmit={signIn} className="mt-8 space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium">Email</span>
              <span className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 transition focus-within:border-zinc-900 focus-within:ring-4 focus-within:ring-zinc-900/5 dark:border-line dark:bg-surface-2">
                <Mail className="size-4 text-zinc-400" />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@paxtel.com"
                  className="w-full bg-transparent py-2.5 text-sm outline-none placeholder:text-zinc-400"
                />
              </span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium">Password</span>
              <span className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 transition focus-within:border-zinc-900 focus-within:ring-4 focus-within:ring-zinc-900/5 dark:border-line dark:bg-surface-2">
                <Lock className="size-4 text-zinc-400" />
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-transparent py-2.5 text-sm outline-none placeholder:text-zinc-400"
                />
              </span>
            </label>
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</p>}
            <button
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:opacity-60 dark:bg-white dark:text-zinc-900"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <>Sign in <ArrowRight className="size-4" /></>}
            </button>
          </form>

          {process.env.NODE_ENV !== "production" && (
            <div className="mt-8">
              <div className="mb-2 text-[11px] font-medium tracking-wider text-zinc-400 uppercase">Demo accounts</div>
              <div className="flex flex-wrap gap-1.5">
                {DEMO.map((d) => (
                  <button
                    key={d.email}
                    onClick={() => signIn(undefined, { email: d.email, password: "Password123!" })}
                    title={d.email}
                    className="rounded-full border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:border-zinc-900 hover:text-zinc-900 dark:border-line dark:text-muted"
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <p className="text-xs text-zinc-400">PaxTel · Better with us</p>
      </section>

      {/* Photo */}
      <aside className="relative m-3 hidden overflow-hidden rounded-[1.75rem] lg:block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/backdrop.webp" alt="" className="absolute inset-0 size-full object-cover" />
        <div className="absolute inset-0 bg-linear-to-t from-black/70 via-black/10 to-transparent" />
        <div className="absolute inset-x-10 bottom-10 text-white">
          <p className="max-w-md text-[26px] leading-snug font-semibold tracking-tight">“Connectivity built around people.”</p>
          <p className="mt-3 max-w-md text-sm text-white/75">
            Every WhatsApp conversation, bot answer and handover in one live workspace for the PaxTel care team.
          </p>
        </div>
      </aside>
    </main>
  );
}
