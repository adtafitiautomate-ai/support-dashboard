"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Bot,
  CalendarRange,
  Download,
  FileSpreadsheet,
  HeartHandshake,
  Loader2,
  Package,
  Printer,
  ShieldAlert,
  Tags,
  Ticket,
  Users,
  Wallet,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { PageHeader } from "./app-shell";
import { cx, Empty } from "./ui";

const TYPES = [
  { id: "summary", label: "Executive summary", hint: "Headline KPIs for the period", icon: BarChart3 },
  { id: "conversations", label: "Conversations & tickets", hint: "Every chat with timings, owner, CSAT", icon: Ticket },
  { id: "agents", label: "Agent performance", hint: "Volume, speed, SLA and CSAT per agent", icon: Users },
  { id: "daily", label: "Daily volume & bot", hint: "Per-day chats and bot containment", icon: Bot },
  { id: "reasons", label: "Contact reasons", hint: "Why customers get in touch", icon: Tags },
  { id: "sla", label: "SLA breaches", hint: "Chats answered late or not yet", icon: ShieldAlert },
  { id: "csat", label: "Customer satisfaction", hint: "Every rating customers gave", icon: HeartHandshake },
  { id: "topups", label: "WhatsApp top-ups", hint: "Bundles & airtime sold in chat", icon: Wallet },
  { id: "deliveries", label: "Deliveries", hint: "SIM delivery requests and status", icon: Package },
] as const;
type TypeId = (typeof TYPES)[number]["id"];

const PRESETS = [
  { id: 7, label: "7 days" },
  { id: 30, label: "30 days" },
  { id: 90, label: "90 days" },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

export function ReportsView() {
  const mvnos = useStore((s) => [...s.mvnos.values()]);
  const [type, setType] = useState<TypeId>("summary");
  const [mvno, setMvno] = useState("all");
  const [range, setRange] = useState(() => ({ from: daysAgo(29), to: daysAgo(0), preset: 30 as number | null }));
  const [data, setData] = useState<{ columns: string[]; rows: (string | number | null)[][] } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => new URLSearchParams({ type, mvno, from: range.from, to: range.to }).toString(), [type, mvno, range]);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setState("loading");
      fetch(`/api/reports?${query}`, { signal: ctrl.signal })
        .then(async (r) => {
          const json = await r.json();
          if (!r.ok) throw new Error(json.error ?? "Could not load report");
          if (alive) {
            setData(json);
            setState("ready");
          }
        })
        .catch((e: Error) => {
          if (alive && e.name !== "AbortError") {
            setError(e.message);
            setState("error");
          }
        });
    }, 0);
    return () => {
      alive = false;
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  const current = TYPES.find((t) => t.id === type)!;
  const csvUrl = `/api/reports?${query}&format=csv`;

  function downloadAll() {
    // One CSV per report, staggered so the browser accepts each download.
    TYPES.forEach((t, i) =>
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = `/api/reports?${new URLSearchParams({ type: t.id, mvno, from: range.from, to: range.to })}&format=csv`;
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 400),
    );
  }

  return (
    <div className="h-full overflow-y-auto px-6 pb-6">
      <PageHeader
        title="Reports"
        subtitle={
          <>
            <FileSpreadsheet className="size-3.5" /> Export performance, customer and sales reports. CSV opens in Excel and Google Sheets.
          </>
        }
        actions={
          <div className="no-print flex flex-wrap items-center gap-2">
            <button onClick={() => window.print()} className="glass flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium">
              <Printer className="size-4" /> Print / PDF
            </button>
            <button onClick={downloadAll} className="glass flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium">
              <Download className="size-4" /> Download all
            </button>
            <a href={csvUrl} download className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium shadow-md ring-1 ring-black/10 transition hover:bg-zinc-50">
              <Download className="size-4" /> Download CSV
            </a>
          </div>
        }
      />

      {/* Filters */}
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        {mvnos.length > 1 && (
          <select value={mvno} onChange={(e) => setMvno(e.target.value)} className="glass h-9 rounded-full px-3 text-sm outline-none">
            <option value="all">All MVNOs</option>
            {mvnos.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        <div className="glass flex rounded-full p-1">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => setRange({ from: daysAgo(p.id - 1), to: daysAgo(0), preset: p.id })}
              className={cx("rounded-full px-3 py-1 text-[13px] font-medium transition", range.preset === p.id ? "bg-white shadow-sm" : "text-muted hover:text-ink")}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="glass flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px]">
          <CalendarRange className="size-4 text-muted" />
          <input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value, preset: null })} className="bg-transparent outline-none" />
          <span className="text-muted">→</span>
          <input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value, preset: null })} className="bg-transparent outline-none" />
        </label>
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* Report types */}
        <nav className="card no-print h-fit p-2">
          {TYPES.map(({ id, label, hint, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setType(id)}
              className={cx("flex w-full items-start gap-3 rounded-2xl px-3 py-2.5 text-left transition", type === id ? "bg-white shadow-sm" : "hover:bg-white/50")}
            >
              <span className={cx("mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl", type === id ? "bg-zinc-900 text-white" : "bg-white/70 text-muted")}>
                <Icon className="size-4" />
              </span>
              <span>
                <span className="block text-[13.5px] font-medium">{label}</span>
                <span className="block text-xs text-muted">{hint}</span>
              </span>
            </button>
          ))}
        </nav>

        {/* Preview */}
        <section className="card min-h-[420px] overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3.5">
            <current.icon className="size-4 text-muted" />
            <h2 className="font-semibold">{current.label}</h2>
            <span className="text-xs text-muted">
              {range.from} → {range.to}
              {mvno !== "all" && ` · ${mvnos.find((m) => m.id === mvno)?.name}`}
            </span>
            {state === "ready" && data && type !== "summary" && <span className="ml-auto text-xs text-muted">{data.rows.length.toLocaleString()} rows</span>}
          </div>

          {state === "loading" && (
            <div className="grid h-80 place-items-center text-sm text-muted">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
          {state === "error" && <div className="p-6 text-sm text-danger">{error}</div>}
          {state === "ready" && data && data.rows.length === 0 && (
            <Empty icon={<FileSpreadsheet className="size-6" />} title="No data for this period" hint="Try a wider date range." />
          )}

          {state === "ready" && data && data.rows.length > 0 && type === "summary" && (
            <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
              {data.rows.map(([k, v]) => (
                <div key={String(k)} className="rounded-2xl bg-white/70 p-4 ring-1 ring-black/5">
                  <div className="text-xs text-muted">{k}</div>
                  <div className="mt-1 text-xl font-semibold tabular-nums">{v === null ? "–" : typeof v === "number" ? v.toLocaleString() : v}</div>
                </div>
              ))}
            </div>
          )}

          {state === "ready" && data && data.rows.length > 0 && type !== "summary" && (
            <div className="max-h-[calc(100dvh-300px)] overflow-auto">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-white/90 backdrop-blur">
                  <tr>
                    {data.columns.map((c) => (
                      <th key={c} className="border-b border-line px-4 py-2.5 text-left font-medium whitespace-nowrap text-muted">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.slice(0, 500).map((row, i) => (
                    <tr key={i} className="hover:bg-white/60">
                      {row.map((v, j) => (
                        <td key={j} className={cx("border-b border-line/60 px-4 py-2 whitespace-nowrap", typeof v === "number" && "text-right tabular-nums")}>
                          {v === null || v === "" ? <span className="text-muted">–</span> : typeof v === "number" ? v.toLocaleString() : v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.rows.length > 500 && (
                <p className="px-4 py-3 text-xs text-muted">Showing the first 500 rows. Download the CSV for all {data.rows.length.toLocaleString()}.</p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
