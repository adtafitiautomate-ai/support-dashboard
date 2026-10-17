"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Bot, Clock, Inbox, Package, Smile, Users, Wallet } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useStore } from "@/lib/store";
import { useWorkspace } from "./workspace";
import { Avatar, cx } from "./ui";
import { formatMinutes, formatMoney } from "@/lib/format";

interface Stats {
  open: number;
  unassigned: number;
  pending: number;
  with_bot: number;
  sla_breached: number;
  conversations: number;
  bot_contained: number;
  avg_first_response_secs: number;
  avg_resolution_mins: number;
  csat_avg: number | null;
  csat_count: number;
  recharge_total: number;
  recharge_count: number;
  deliveries_active: number;
  by_category: Record<string, number>;
  by_day: { day: string; total: number; handoffs: number }[];
  agents: { id: string; name: string; status: string; open: number; resolved: number; csat: number | null }[];
}

const RANGES = [
  { id: "1", label: "24h" },
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
];

// Validated categorical slots 1–2 (light/dark): blue = bot, orange = human.
const SERIES = {
  bot: "light-dark(#2a78d6, #3987e5)",
  human: "light-dark(#eb6834, #d95926)",
};

export function Insights() {
  const { onEvent } = useWorkspace();
  const mvnos = useStore((s) => [...s.mvnos.values()]);
  const [mvno, setMvno] = useState("all");
  const [days, setDays] = useState("7");
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const load = () =>
      void supabaseBrowser()
        .rpc("dashboard_stats", {
          p_mvno: mvno === "all" ? null : mvno,
          p_since: new Date(Date.now() - Number(days) * 86_400_000).toISOString(),
        })
        .then(({ data }) => data && setStats(data as Stats));
    load();
    // Live: refetch (debounced) whenever conversations or recharges change.
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent((table) => {
      if (table === "conversations" || table === "recharges" || table === "deliveries") {
        clearTimeout(t);
        t = setTimeout(load, 1500);
      }
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [mvno, days, onEvent]);

  const currency = (mvno !== "all" && mvnos.find((m) => m.id === mvno)?.currency) || mvnos[0]?.currency || "";
  const containment = stats && stats.conversations ? Math.round((stats.bot_contained / stats.conversations) * 100) : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 px-6 pb-6">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-[28px] leading-tight font-semibold tracking-tight">Insights</h1>
            <p className="mt-1 text-[13px] text-muted">Live: updates as conversations move.</p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {mvnos.length > 1 && (
              <select value={mvno} onChange={(e) => setMvno(e.target.value)} className="h-9 rounded-full bg-surface px-3 text-sm shadow-sm ring-1 ring-black/5 outline-none">
                <option value="all">All MVNOs</option>
                {mvnos.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
            <div className="flex glass rounded-full p-1">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setDays(r.id)}
                  className={cx("rounded-full px-3 py-1 text-xs font-medium", days === r.id ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink")}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {!stats ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="card h-24 animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Tile icon={<Inbox />} label="Open now" value={stats.open} sub={`${stats.unassigned} waiting in queue · ${stats.pending} pending`} />
              <Tile
                icon={<AlertTriangle />}
                label="SLA breached"
                value={stats.sla_breached}
                sub="No first response in time"
                status={stats.sla_breached > 0 ? "critical" : "good"}
              />
              <Tile icon={<Clock />} label="Avg first response" value={fmtDuration(stats.avg_first_response_secs)} sub={`Avg resolution ${formatMinutes(stats.avg_resolution_mins)}`} />
              <Tile icon={<Bot />} label="Bot containment" value={`${containment}%`} sub={`${stats.bot_contained} of ${stats.conversations} without an agent`} />
              <Tile icon={<Smile />} label="CSAT" value={stats.csat_avg ? `${stats.csat_avg}/5` : "–"} sub={`${stats.csat_count} ratings`} />
              <Tile icon={<Wallet />} label="WhatsApp top-ups" value={formatMoney(stats.recharge_total, currency)} sub={`${stats.recharge_count} successful`} />
              <Tile icon={<Package />} label="Active deliveries" value={stats.deliveries_active} sub="SIM / eSIM / devices" />
              <Tile icon={<Users />} label="With bot now" value={stats.with_bot} sub="Self-serving customers" />
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              <Card title="Conversations per day" className="lg:col-span-2">
                <DayChart data={stats.by_day} />
              </Card>
              <Card title="Top contact reasons">
                <Categories data={stats.by_category} />
              </Card>
            </div>

            <Card title="Team">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted">
                      <th className="py-2 font-medium">Agent</th>
                      <th className="py-2 font-medium">Status</th>
                      <th className="py-2 text-right font-medium">Open</th>
                      <th className="py-2 text-right font-medium">Resolved</th>
                      <th className="py-2 text-right font-medium">CSAT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.agents.map((a) => (
                      <tr key={a.id} className="border-t border-line">
                        <td className="py-2">
                          <span className="flex items-center gap-2">
                            <Avatar name={a.name} size={24} /> {a.name}
                          </span>
                        </td>
                        <td className="py-2 text-muted capitalize">
                          <span className="inline-flex items-center gap-1.5">
                            <span className={cx("size-2 rounded-full", a.status === "online" ? "bg-emerald-500" : a.status === "away" ? "bg-amber-500" : "bg-zinc-400")} />
                            {a.status}
                          </span>
                        </td>
                        <td className="py-2 text-right tabular-nums">{a.open}</td>
                        <td className="py-2 text-right tabular-nums">{a.resolved}</td>
                        <td className="py-2 text-right tabular-nums">{a.csat ?? "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function fmtDuration(secs: number) {
  if (!secs) return "–";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}

function Tile({
  icon,
  label,
  value,
  sub,
  status,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub: string;
  status?: "good" | "critical";
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted [&_svg]:size-3.5">
        {icon} {label}
        {status === "critical" && <span className="ml-auto rounded bg-red-500/12 px-1 text-[10px] text-danger">Needs attention</span>}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>
    </div>
  );
}

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cx("card p-4", className)}>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function DayChart({ data }: { data: Stats["by_day"] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <div className="py-12 text-center text-sm text-muted">No conversations in this period</div>;
  const max = Math.max(...data.map((d) => d.total), 1);
  return (
    <div>
      <div className="mb-3 flex gap-4 text-xs text-muted">
        <Legend color={SERIES.bot} label="Solved by bot" />
        <Legend color={SERIES.human} label="Handed to agents" />
      </div>
      <div className="relative flex h-48 items-end gap-1.5 border-b border-line">
        {data.map((d, i) => {
          const bot = d.total - d.handoffs;
          return (
            <div
              key={d.day}
              className="relative flex h-full flex-1 flex-col justify-end"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {/* Stacked: bot at base, handoffs on top, 2px surface gap between */}
              <div className="flex flex-col justify-end gap-[2px]" style={{ height: `${(d.total / max) * 100}%` }}>
                {d.handoffs > 0 && <div className="rounded-t-[4px]" style={{ flex: d.handoffs, background: SERIES.human }} />}
                {bot > 0 && <div className={cx(d.handoffs === 0 && "rounded-t-[4px]")} style={{ flex: bot, background: SERIES.bot }} />}
              </div>
              {hover === i && (
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-40 -translate-x-1/2 rounded-lg border border-line bg-surface p-2 text-xs shadow-lg">
                  <div className="mb-1 font-medium">{new Date(d.day).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</div>
                  <Row color={SERIES.bot} label="Solved by bot" value={bot} />
                  <Row color={SERIES.human} label="Handed to agents" value={d.handoffs} />
                  <div className="mt-1 flex justify-between border-t border-line pt-1 text-muted">
                    <span>Total</span>
                    <span className="tabular-nums">{d.total}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {data.map((d) => (
          <div key={d.day} className="flex-1 text-center text-[10px] text-muted">
            {new Date(d.day).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function Row({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="inline-flex items-center gap-1.5 text-muted">
        <span className="size-2 rounded-sm" style={{ background: color }} />
        {label}
      </span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function Categories({ data }: { data: Record<string, number> }) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 7);
  const max = Math.max(...rows.map((r) => r[1]), 1);
  if (!rows.length) return <div className="py-12 text-center text-sm text-muted">No data yet</div>;
  return (
    <ul className="space-y-2.5">
      {rows.map(([k, v]) => (
        <li key={k} title={`${k}: ${v}`}>
          <div className="mb-1 flex justify-between text-xs">
            <span className="capitalize">{k}</span>
            <span className="text-muted tabular-nums">{v}</span>
          </div>
          <div className="h-2 rounded-full bg-surface-2">
            <div className="h-full rounded-full" style={{ width: `${(v / max) * 100}%`, background: SERIES.bot }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
