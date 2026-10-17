"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useStore } from "@/lib/store";
import { Avatar, Badge } from "./ui";

interface Entry {
  id: number;
  at: string;
  actor_name: string | null;
  mvno_id: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
}

const LABEL: Record<string, [string, "neutral" | "green" | "amber" | "red" | "blue" | "violet"]> = {
  "user.created": ["Created user", "green"],
  "user.role_set": ["Changed role", "blue"],
  "user.access_removed": ["Removed access", "amber"],
  "user.password_reset": ["Reset password", "amber"],
  "user.disabled": ["Disabled user", "red"],
  "user.enabled": ["Enabled user", "green"],
  "user.super_admin_granted": ["Granted super admin", "violet"],
  "user.super_admin_removed": ["Removed super admin", "amber"],
  "user.renamed": ["Renamed user", "neutral"],
  "mvno.created": ["Created MVNO", "green"],
  "mvno.updated": ["Updated MVNO", "neutral"],
  "whatsapp.token_renewed": ["Renewed WhatsApp token", "blue"],
  "whatsapp.number_connected": ["Connected WhatsApp number", "blue"],
  "whatsapp.switched_to_simulator": ["Switched to simulator", "amber"],
  "locations.imported": ["Imported locations", "neutral"],
  "locations.deleted": ["Deleted location", "amber"],
  "knowledge.source_added": ["Added knowledge source", "neutral"],
  "report.exported": ["Exported report", "blue"],
  "customer.erased": ["Erased customer data", "red"],
  "retention.purged": ["Retention clean-up", "neutral"],
  "email.smtp_updated": ["Updated email settings", "blue"],
  "email.test_sent": ["Sent test email", "neutral"],
};

function summary(e: Entry) {
  const d = e.details ?? {};
  if (e.action === "user.created") return `${d.login ?? ""} · ${d.super_admin ? "super admin" : (d.role ?? "")}`;
  if (e.action === "user.role_set") return `role: ${d.role}`;
  if (e.action === "report.exported") return `${d.from} → ${d.to} · ${d.rows} rows`;
  if (e.action === "whatsapp.token_renewed") return d.expires_at ? `valid until ${new Date(String(d.expires_at)).toLocaleDateString("en-GB")}` : "never expires";
  if (e.action === "locations.imported") return `${d.imported} imported${d.removed ? `, ${d.removed} replaced` : ""} (${d.mode})`;
  if (e.action === "customer.erased") return `${d.conversations} chats, ${d.media} files`;
  if (e.action === "mvno.updated") return Array.isArray(d.fields) ? `changed: ${(d.fields as string[]).join(", ")}` : "";
  if (e.action === "retention.purged" && Array.isArray(d.results))
    return (d.results as { mvno: string; conversations: number }[]).filter((r) => r.conversations).map((r) => `${r.mvno}: ${r.conversations} chats`).join(", ");
  return "";
}

/** Read-only audit trail of administrative actions (super admins: all; MVNO admins: their MVNO). */
export function ActivityLog() {
  const mvnos = useStore((s) => s.mvnos);
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    void supabaseBrowser()
      .from("audit_log")
      .select("*")
      .order("at", { ascending: false })
      .limit(300)
      .then(({ data }) => setRows((data ?? []) as Entry[]));
  }, []);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (rows ?? []).filter((e) => !t || `${e.actor_name} ${e.action} ${LABEL[e.action]?.[0] ?? ""} ${e.target ?? ""} ${summary(e)}`.toLowerCase().includes(t));
  }, [rows, q]);

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <label className="flex w-full max-w-xs items-center gap-2 rounded-full bg-white/70 px-3 py-1.5 ring-1 ring-black/5">
          <Search className="size-3.5 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search who, what, target" className="w-full bg-transparent text-xs outline-none" />
        </label>
        <span className="ml-auto text-xs text-muted">Last {rows?.length ?? 0} actions · kept permanently</span>
      </div>
      {!rows ? (
        <div className="grid h-40 place-items-center">
          <Loader2 className="size-5 animate-spin text-muted" />
        </div>
      ) : !shown.length ? (
        <p className="p-8 text-center text-sm text-muted">No activity yet. Admin actions appear here as they happen.</p>
      ) : (
        <div className="max-h-[calc(100dvh-280px)] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-white/90 text-left text-muted backdrop-blur">
              <tr>
                {["When", "Who", "Action", "Target", "MVNO", "Details"].map((h) => (
                  <th key={h} className="px-4 py-2.5 font-medium whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => {
                const [label, tone] = LABEL[e.action] ?? [e.action, "neutral" as const];
                return (
                  <tr key={e.id} className="border-t border-line/60 align-top">
                    <td className="px-4 py-2 whitespace-nowrap text-muted">{new Date(e.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <span className="flex items-center gap-1.5">
                        <Avatar name={e.actor_name ?? "System"} size={20} /> {e.actor_name ?? "System"}
                      </span>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <Badge tone={tone}>{label}</Badge>
                    </td>
                    <td className="px-4 py-2">{e.target ?? "–"}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-muted">{e.mvno_id ? (mvnos.get(e.mvno_id)?.name ?? "–") : "All"}</td>
                    <td className="px-4 py-2 text-muted">{summary(e) || "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
