"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { cx } from "./ui";

type Group = { key: string; calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost: number | null };
type Data = { days: number; priced: boolean; total: Group; byMvno: Group[]; byKind: Group[]; byModel: Group[]; byDay: Group[] };

const KIND_LABEL: Record<string, string> = {
  bot_reply: "Bot replies to customers",
  triage: "Ticket triage at handover",
  summary: "AI summaries (agent button)",
  draft: "AI reply drafts (agent button)",
  knowledge: "Knowledge base training",
};

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const usd = (n: number | null) => (n === null ? "–" : `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`);
const tokens = (g: Group) => g.input_tokens + g.output_tokens + g.cache_read_tokens + g.cache_write_tokens;

/** Admin → AI usage: Claude tokens by day, MVNO and purpose. */
export function AiUsage() {
  const mvnos = useStore((s) => s.mvnos);
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`/api/admin/ai-usage?days=${days}`)
      .then(async (r) => {
        const j = await r.json();
        if (!live) return;
        if (!r.ok) setError(j.error ?? "Could not load usage");
        else {
          setData(j);
          setError(null);
        }
      })
      .catch(() => live && setError("Could not load usage"));
    return () => {
      live = false;
    };
  }, [days]);

  if (error) return <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  if (!data)
    return (
      <div className="card grid h-40 place-items-center">
        <Loader2 className="size-5 animate-spin text-muted" />
      </div>
    );

  const max = Math.max(1, ...data.byDay.map(tokens));
  const t = data.total;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-full bg-white/70 p-1 text-[13px] font-medium ring-1 ring-black/5">
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={cx("rounded-full px-3 py-1", days === d ? "bg-zinc-900 text-white" : "text-muted hover:text-ink")}>
              {d} days
            </button>
          ))}
        </div>
        <span className="text-xs text-muted">Counted from every Claude call since tracking started.</span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="AI calls" value={fmt(t.calls)} />
        <Tile label="Input tokens" value={fmt(t.input_tokens + t.cache_read_tokens + t.cache_write_tokens)} sub={t.cache_read_tokens ? `${fmt(t.cache_read_tokens)} from cache (cheaper)` : undefined} />
        <Tile label="Output tokens" value={fmt(t.output_tokens)} />
        <Tile label="Estimated cost" value={data.priced ? usd(t.cost) : "–"} sub={data.priced ? "From the configured prices" : "Set AI_PRICE_INPUT_PER_MTOK / AI_PRICE_OUTPUT_PER_MTOK"} />
      </div>

      <section className="card p-5">
        <h3 className="mb-3 text-sm font-semibold">Tokens per day</h3>
        {data.byDay.length ? (
          <div className="flex h-36 items-end gap-1 overflow-x-auto">
            {data.byDay.map((d) => (
              <div key={d.key} className="group flex min-w-3 flex-1 flex-col items-center gap-1" title={`${d.key}: ${fmt(tokens(d))} tokens, ${d.calls} calls${d.cost !== null ? `, ${usd(d.cost)}` : ""}`}>
                <div className="w-full rounded-t-md bg-zinc-800 transition group-hover:bg-zinc-600" style={{ height: `${Math.max(3, (tokens(d) / max) * 120)}px` }} />
                <span className="text-[10px] text-muted tabular-nums">{d.key.slice(8)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted">No AI calls in this period yet.</p>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <UsageTable title="By MVNO" rows={data.byMvno} label={(k) => (k === "none" ? "Not linked to an MVNO" : (mvnos.get(k)?.name ?? "Deleted MVNO"))} priced={data.priced} />
        <UsageTable title="By purpose" rows={data.byKind} label={(k) => KIND_LABEL[k] ?? k} priced={data.priced} />
      </div>
      {data.byModel.length > 0 && (
        <p className="text-xs text-muted">Models used: {data.byModel.map((m) => `${m.key} (${fmt(m.calls)} calls)`).join(", ")}</p>
      )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function UsageTable({ title, rows, label, priced }: { title: string; rows: Group[]; label: (k: string) => string; priced: boolean }) {
  return (
    <section className="card p-5">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="py-2 font-medium">Name</th>
              <th className="py-2 text-right font-medium">Calls</th>
              <th className="py-2 text-right font-medium">Input</th>
              <th className="py-2 text-right font-medium">Output</th>
              {priced && <th className="py-2 text-right font-medium">Cost</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-line/60 last:border-0">
                <td className="py-2">{label(r.key)}</td>
                <td className="py-2 text-right tabular-nums">{fmt(r.calls)}</td>
                <td className="py-2 text-right tabular-nums">{fmt(r.input_tokens + r.cache_read_tokens + r.cache_write_tokens)}</td>
                <td className="py-2 text-right tabular-nums">{fmt(r.output_tokens)}</td>
                {priced && <td className="py-2 text-right tabular-nums">{usd(r.cost)}</td>}
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-muted">
                  Nothing yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
