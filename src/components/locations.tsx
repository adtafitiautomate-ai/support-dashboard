"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, MapPin, Search, Store, Trash2, UploadCloud, UserRound } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Outlet } from "@/lib/types";
import { cx } from "./ui";

const TEMPLATE =
  "name,type,address,district,latitude,longitude,phone,hours,services\n" +
  'PaxSente Agent – Katete,agent,Katete trading centre,Mbarara,-0.6230,30.6490,+256700000000,"Daily 8:00 AM – 8:00 PM",airtime;bundles;mobile_money\n' +
  'PaxTel Service Centre – Wandegeya,service centre,Wandegeya Traffic Lights,Kampala,0.3317,32.5711,+256724000100,"Daily 8:00 AM – 8:00 PM",sim_swap;esim;mobile_money\n';

/** Agent & service-centre directory: CSV import, search, delete. Powers "nearest agent" in the bot. */
export function LocationsPanel({ mvnoId }: { mvnoId: string }) {
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"add" | "replace">("add");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; skipped?: { line: number; reason: string }[] } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(
    () =>
      supabaseBrowser()
        .from("outlets")
        .select("*")
        .eq("mvno_id", mvnoId)
        .order("kind", { ascending: false })
        .order("name")
        .limit(5000)
        .then(({ data }) => setOutlets((data ?? []) as Outlet[])),
    [mvnoId],
  );
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return outlets.filter((o) => !term || `${o.name} ${o.address} ${o.phone ?? ""}`.toLowerCase().includes(term));
  }, [outlets, q]);
  const counts = { agents: outlets.filter((o) => o.kind !== "store").length, centres: outlets.filter((o) => o.kind === "store").length };

  async function upload(file: File) {
    setBusy(true);
    setResult(null);
    const form = new FormData();
    form.set("file", file);
    form.set("mvnoId", mvnoId);
    form.set("mode", mode);
    try {
      const res = await fetch("/api/outlets", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Import failed");
      setResult({
        ok: true,
        text: `Imported ${json.imported} location${json.imported === 1 ? "" : "s"}${json.removed ? `, replaced ${json.removed}` : ""}${json.skipped.length ? `, skipped ${json.skipped.length}` : ""}.`,
        skipped: json.skipped,
      });
      await load();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob(["﻿" + TEMPLATE], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "agent-locations-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="card mt-4 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <MapPin className="size-4 text-muted" />
        <h2 className="text-sm font-semibold">Agent & service centre locations</h2>
        <span className="text-xs text-muted">
          {counts.agents} agents · {counts.centres} service centres
        </span>
        <p className="w-full text-xs text-muted">
          When a customer asks for an agent, the bot asks them to share their WhatsApp location and recommends the 3 nearest. Agents handle top-ups and mobile money;
          service centres handle SIM replacement, eSIM and devices.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* Import */}
        <div className="space-y-3">
          <div
            onClick={() => !busy && fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) void upload(f);
            }}
            className="grid cursor-pointer place-items-center rounded-2xl border-2 border-dashed border-line bg-white/50 px-4 py-6 text-center transition hover:border-black/20"
          >
            {busy ? <Loader2 className="size-6 animate-spin text-muted" /> : <UploadCloud className="size-6 text-muted" />}
            <div className="mt-2 text-sm font-medium">Upload locations CSV</div>
            <div className="text-xs text-muted">Columns: name, type, address, district, latitude, longitude, phone, hours, services</div>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = "";
              }}
            />
          </div>
          <div className="flex rounded-full bg-white/60 p-1 text-[12.5px] font-medium ring-1 ring-black/5">
            {(
              [
                ["add", "Add / update by name"],
                ["replace", "Replace list"],
              ] as const
            ).map(([m, label]) => (
              <button key={m} onClick={() => setMode(m)} className={cx("flex-1 rounded-full py-1.5 transition", mode === m ? "bg-white shadow-sm" : "text-muted hover:text-ink")}>
                {label}
              </button>
            ))}
          </div>
          <p className="text-[11.5px] text-muted">
            {mode === "replace"
              ? "Replace removes existing locations of the types in your file (e.g. an agents-only file keeps your service centres)."
              : "Rows with a name that already exists update that location; new names are added."}
          </p>
          <button onClick={downloadTemplate} className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-ink">
            <Download className="size-3.5" /> Download CSV template
          </button>
          {result && (
            <div className={cx("rounded-xl px-3 py-2 text-xs", result.ok ? "bg-white/70 text-ink" : "bg-red-50 text-red-700")}>
              {result.text}
              {!!result.skipped?.length && (
                <ul className="mt-1 max-h-24 list-disc overflow-y-auto pl-4 text-muted">
                  {result.skipped.slice(0, 20).map((s) => (
                    <li key={s.line}>
                      Line {s.line}: {s.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Directory */}
        <div className="min-w-0">
          <label className="mb-2 flex items-center gap-1.5 rounded-full border border-line bg-white/60 px-3 py-1.5">
            <Search className="size-3.5 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, area, phone" className="w-full bg-transparent text-xs outline-none" />
          </label>
          <div className="max-h-80 overflow-auto rounded-2xl bg-white/50 ring-1 ring-black/5">
            <table className="w-full text-[12.5px]">
              <thead className="sticky top-0 bg-white/90 text-left text-muted backdrop-blur">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Area</th>
                  <th className="px-3 py-2 font-medium">Phone</th>
                  <th className="px-3 py-2 font-medium">Hours</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 300).map((o) => (
                  <tr key={o.id} className="group border-t border-line/60">
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-1.5">
                        {o.kind === "store" ? <Store className="size-3.5 shrink-0 text-muted" /> : <UserRound className="size-3.5 shrink-0 text-muted" />}
                        <a href={`https://www.google.com/maps?q=${o.lat},${o.lng}`} target="_blank" rel="noreferrer" className="hover:underline">
                          {o.name}
                        </a>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-muted">{o.address}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-muted">{o.phone ?? "–"}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-muted">{o.hours ?? "–"}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        title="Remove"
                        onClick={async () => {
                          const r = await fetch(`/api/outlets?id=${o.id}`, { method: "DELETE" });
                          if (r.ok) setOutlets((list) => list.filter((x) => x.id !== o.id));
                        }}
                        className="rounded-md p-1 text-muted opacity-0 transition group-hover:opacity-100 hover:text-danger"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {!shown.length && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-muted">
                      No locations yet. Upload a CSV.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
