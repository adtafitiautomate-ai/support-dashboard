"use client";

import { clsx } from "clsx";
import { useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import { initials } from "@/lib/format";

export const cx = clsx;

export function Avatar({ name, color, size = 32, online }: { name: string | null; color?: string; size?: number; online?: boolean }) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="grid size-full place-items-center rounded-full font-semibold text-white"
        style={{ background: color ?? hashColor(name ?? "?"), fontSize: size * 0.38 }}
      >
        {initials(name)}
      </div>
      {online !== undefined && (
        <span
          className={cx(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-surface",
            online ? "bg-emerald-500" : "bg-zinc-400",
          )}
        />
      )}
    </div>
  );
}

export function hashColor(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 48%)`;
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium", toneClass[tone], className)}>
      {children}
    </span>
  );
}

type Tone = "neutral" | "green" | "red" | "amber" | "blue" | "violet";
const toneClass: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted ring-1 ring-line",
  green: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  red: "bg-red-500/12 text-red-700 dark:text-red-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  blue: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  violet: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
};

export function MvnoTag({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted">
      <span className="size-2 rounded-full" style={{ background: color }} />
      {name}
    </span>
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-3 text-sm",
        variant === "primary" && "bg-surface text-ink shadow-sm ring-1 ring-black/15 hover:bg-surface-2",
        variant === "secondary" && "border border-line bg-surface hover:bg-surface-2",
        variant === "ghost" && "text-muted hover:bg-surface-2 hover:text-ink",
        variant === "danger" && "border border-line bg-surface text-danger hover:bg-red-500/10",
        className,
      )}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-[10px] text-muted">{children}</kbd>;
}

// One shared 1s clock for every live timestamp / SLA timer on the page.
let clock = 0;
const clockSubs = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;

function subscribeClock(cb: () => void) {
  clockSubs.add(cb);
  if (!clockTimer) {
    clock = Date.now();
    clockTimer = setInterval(() => {
      clock = Date.now();
      clockSubs.forEach((f) => f());
    }, 1000);
  }
  return () => {
    clockSubs.delete(cb);
    if (!clockSubs.size) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

/** Current time, re-rendering every `ms` so relative times and SLA timers stay live. */
export function useNow(ms = 15_000) {
  return useSyncExternalStore(
    subscribeClock,
    () => Math.floor(clock / ms) * ms,
    () => 0,
  );
}

export function relTime(iso: string | null | undefined, now: number) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function Empty({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div>
        <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-surface-2 text-muted">{icon}</div>
        <div className="font-medium">{title}</div>
        {hint && <div className="mt-1 text-sm text-muted">{hint}</div>}
      </div>
    </div>
  );
}

export async function api<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json as T;
}
