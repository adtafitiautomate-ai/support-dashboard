import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { formatMinutes } from "@/lib/format";

export const REPORTS = {
  summary: "Executive summary",
  conversations: "Conversations & tickets",
  agents: "Agent performance",
  daily: "Daily volume & bot containment",
  reasons: "Contact reasons",
  sla: "SLA breaches",
  csat: "Customer satisfaction (CSAT)",
  topups: "WhatsApp top-ups",
  deliveries: "Deliveries",
} as const;
export type ReportType = keyof typeof REPORTS;

export interface ReportResult {
  columns: string[];
  rows: (string | number | null)[][];
}

interface Range {
  mvnoIds: string[];
  from: string; // ISO
  to: string; // ISO (exclusive)
}

type Conv = {
  id: string;
  ticket_no: number | null;
  mvno_id: string;
  status: string;
  priority: string;
  category: string | null;
  subject: string | null;
  sentiment: string | null;
  created_at: string;
  handoff_at: string | null;
  first_response_at: string | null;
  sla_due_at: string | null;
  resolved_at: string | null;
  csat_score: number | null;
  assignee_id: string | null;
  contact: { name: string | null; wa_id: string } | null;
  assignee: { full_name: string } | null;
  mvno: { name: string } | null;
};

const mins = (a: string | null, b: string | null) =>
  a && b ? Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000)) : null;
const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null;
};
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const day = (iso: string) => iso.slice(0, 10);
/** Summary tiles: "3h 44m (224 min)" so the unit is never ambiguous. */
const withMinutes = (m: number | null) => (m === null ? null : `${formatMinutes(m)} (${Math.round(m)} min)`);
const when = (iso: string | null) => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) : null);

/** Ticket resolution: from when the team got it (handover, or creation for agent-started chats). */
const ticketMins = (c: Conv) => mins(c.handoff_at ?? c.created_at, c.resolved_at);

function breached(c: Conv) {
  if (!c.sla_due_at) return false;
  const answeredAt = c.first_response_at ? new Date(c.first_response_at).getTime() : Date.now();
  return answeredAt > new Date(c.sla_due_at).getTime();
}

async function conversations(r: Range): Promise<Conv[]> {
  const { data, error } = await supabaseAdmin()
    .from("conversations")
    .select(
      "id,ticket_no,mvno_id,status,priority,category,subject,sentiment,created_at,handoff_at,first_response_at,sla_due_at,resolved_at,csat_score,assignee_id," +
        "contact:contacts(name,wa_id),assignee:profiles(full_name),mvno:mvnos(name)",
    )
    .in("mvno_id", r.mvnoIds)
    .gte("created_at", r.from)
    .lt("created_at", r.to)
    .order("created_at", { ascending: true })
    .limit(50_000);
  if (error) throw error;
  return (data ?? []) as unknown as Conv[];
}

export async function buildReport(type: ReportType, r: Range): Promise<ReportResult> {
  const db = supabaseAdmin();
  switch (type) {
    case "summary": {
      const cs = await conversations(r);
      const human = cs.filter((c) => c.handoff_at);
      const { data: rech } = await db.from("recharges").select("amount,status").in("mvno_id", r.mvnoIds).gte("created_at", r.from).lt("created_at", r.to);
      const ok = (rech ?? []).filter((x) => x.status === "success");
      const rated = cs.filter((c) => c.csat_score);
      return {
        columns: ["Metric", "Value"],
        rows: [
          ["Conversations", cs.length],
          ["Handled fully by the bot", cs.length - human.length],
          ["Bot containment %", pct(cs.length - human.length, cs.length)],
          ["Tickets (needed a person)", cs.filter((c) => c.ticket_no).length],
          ["Handed to agents by the bot", human.length],
          ["Resolved", cs.filter((c) => c.status === "resolved").length],
          ["Still open / pending", cs.filter((c) => c.status === "open" || c.status === "pending").length],
          ["Avg first response", withMinutes(avg(human.map((c) => mins(c.handoff_at, c.first_response_at))))],
          ["Avg ticket resolution (from handover)", withMinutes(avg(cs.filter((c) => c.ticket_no).map(ticketMins)))],
          ["SLA breaches", human.filter(breached).length],
          ["SLA met %", pct(human.length - human.filter(breached).length, human.length)],
          ["CSAT average (1–5)", avg(rated.map((c) => c.csat_score))],
          ["CSAT responses", rated.length],
          ["Negative-sentiment chats", cs.filter((c) => c.sentiment === "negative").length],
          ["WhatsApp top-ups (successful)", ok.length],
          ["WhatsApp top-up value", ok.reduce((s, x) => s + Number(x.amount), 0)],
          ["Failed top-ups", (rech ?? []).filter((x) => x.status === "failed").length],
        ],
      };
    }

    case "conversations": {
      const cs = await conversations(r);
      return {
        columns: ["Ticket", "Created", "MVNO", "Customer", "WhatsApp", "Status", "Priority", "Category", "Subject", "Assigned to", "Handled by", "First response (min)", "Resolution (min)", "SLA breached", "Sentiment", "CSAT"],
        rows: cs.map((c) => [
          c.ticket_no ?? "",
          when(c.created_at),
          c.mvno?.name ?? "",
          c.contact?.name ?? "",
          c.contact ? `+${c.contact.wa_id}` : "",
          c.status,
          c.priority,
          c.category ?? "",
          c.subject ?? "",
          c.assignee?.full_name ?? "",
          c.handoff_at ? "Agent" : "Bot",
          mins(c.handoff_at, c.first_response_at),
          c.ticket_no ? ticketMins(c) : mins(c.created_at, c.resolved_at),
          c.handoff_at ? (breached(c) ? "Yes" : "No") : "",
          c.sentiment ?? "",
          c.csat_score,
        ]),
      };
    }

    case "agents": {
      const cs = (await conversations(r)).filter((c) => c.assignee_id);
      const by = new Map<string, Conv[]>();
      for (const c of cs) by.set(c.assignee?.full_name ?? c.assignee_id!, [...(by.get(c.assignee?.full_name ?? c.assignee_id!) ?? []), c]);
      return {
        columns: ["Agent", "Assigned", "Resolved", "Resolution rate %", "Avg first response (min)", "Avg resolution (min)", "SLA breaches", "CSAT avg", "CSAT responses"],
        rows: [...by.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([name, list]) => {
            const resolved = list.filter((c) => c.status === "resolved");
            const rated = list.filter((c) => c.csat_score);
            return [
              name,
              list.length,
              resolved.length,
              pct(resolved.length, list.length),
              avg(list.map((c) => mins(c.handoff_at, c.first_response_at))),
              avg(resolved.map(ticketMins)),
              list.filter(breached).length,
              avg(rated.map((c) => c.csat_score)),
              rated.length,
            ];
          }),
      };
    }

    case "daily": {
      const cs = await conversations(r);
      const by = new Map<string, Conv[]>();
      for (const c of cs) by.set(day(c.created_at), [...(by.get(day(c.created_at)) ?? []), c]);
      return {
        columns: ["Date", "Conversations", "Bot only", "Handed to agents", "Bot containment %", "Resolved", "SLA breaches", "CSAT avg"],
        rows: [...by.entries()].map(([d, list]) => {
          const human = list.filter((c) => c.handoff_at);
          return [
            d,
            list.length,
            list.length - human.length,
            human.length,
            pct(list.length - human.length, list.length),
            list.filter((c) => c.status === "resolved").length,
            human.filter(breached).length,
            avg(list.map((c) => c.csat_score)),
          ];
        }),
      };
    }

    case "reasons": {
      const cs = await conversations(r);
      const by = new Map<string, Conv[]>();
      for (const c of cs) by.set(c.category ?? "uncategorised", [...(by.get(c.category ?? "uncategorised") ?? []), c]);
      return {
        columns: ["Reason", "Conversations", "Share %", "Tickets", "Negative sentiment", "Avg ticket resolution (min)", "CSAT avg"],
        rows: [...by.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([k, list]) => [
            k,
            list.length,
            pct(list.length, cs.length),
            list.filter((c) => c.ticket_no).length,
            list.filter((c) => c.sentiment === "negative").length,
            avg(list.filter((c) => c.ticket_no).map(ticketMins)),
            avg(list.map((c) => c.csat_score)),
          ]),
      };
    }

    case "sla": {
      const cs = (await conversations(r)).filter((c) => c.handoff_at && breached(c));
      return {
        columns: ["Ticket", "Handed over", "SLA due", "First response", "Minutes late", "Customer", "Assigned to", "Priority", "Subject"],
        rows: cs.map((c) => [
          c.ticket_no,
          when(c.handoff_at),
          when(c.sla_due_at),
          when(c.first_response_at) ?? "Not yet answered",
          mins(c.sla_due_at, c.first_response_at ?? new Date().toISOString()),
          c.contact?.name ?? (c.contact ? `+${c.contact.wa_id}` : ""),
          c.assignee?.full_name ?? "Unassigned",
          c.priority,
          c.subject ?? "",
        ]),
      };
    }

    case "csat": {
      const cs = (await conversations(r)).filter((c) => c.csat_score);
      return {
        columns: ["Ticket", "Resolved", "Customer", "Agent", "Category", "Score (1–5)", "Subject"],
        rows: cs.map((c) => [c.ticket_no ?? "Bot chat", when(c.resolved_at), c.contact?.name ?? "", c.assignee?.full_name ?? "Bot", c.category ?? "", c.csat_score, c.subject ?? ""]),
      };
    }

    case "topups": {
      const { data, error } = await db
        .from("recharges")
        .select("created_at,msisdn,kind,amount,method,status,reference,bundle:bundles(name),contact:contacts(name),mvno:mvnos(name,currency)")
        .in("mvno_id", r.mvnoIds)
        .gte("created_at", r.from)
        .lt("created_at", r.to)
        .order("created_at")
        .limit(50_000);
      if (error) throw error;
      type T = { created_at: string; msisdn: string; kind: string; amount: number; method: string; status: string; reference: string; bundle: { name: string } | null; contact: { name: string | null } | null; mvno: { name: string; currency: string } | null };
      return {
        columns: ["Date", "MVNO", "Customer", "Number topped up", "Type", "Bundle", "Amount", "Currency", "Paid with", "Status", "Reference"],
        rows: ((data ?? []) as unknown as T[]).map((x) => [when(x.created_at), x.mvno?.name ?? "", x.contact?.name ?? "", `+${x.msisdn}`, x.kind, x.bundle?.name ?? "", Number(x.amount), x.mvno?.currency ?? "", x.method, x.status, x.reference]),
      };
    }

    case "deliveries": {
      const { data, error } = await db
        .from("deliveries")
        .select("created_at,item,status,address,tracking_code,rider_name,scheduled_for,contact:contacts(name,wa_id)")
        .in("mvno_id", r.mvnoIds)
        .gte("created_at", r.from)
        .lt("created_at", r.to)
        .order("created_at")
        .limit(50_000);
      if (error) throw error;
      type D = { created_at: string; item: string; status: string; address: string | null; tracking_code: string; rider_name: string | null; scheduled_for: string | null; contact: { name: string | null; wa_id: string } | null };
      return {
        columns: ["Requested", "Tracking", "Item", "Status", "Customer", "WhatsApp", "Address", "Scheduled for", "Rider"],
        rows: ((data ?? []) as unknown as D[]).map((x) => [when(x.created_at), x.tracking_code, x.item, x.status, x.contact?.name ?? "", x.contact ? `+${x.contact.wa_id}` : "", x.address ?? "", when(x.scheduled_for), x.rider_name ?? ""]),
      };
    }
  }
}

export function toCsv(r: ReportResult) {
  const esc = (v: string | number | null) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    // Guard against spreadsheet formula injection from customer-supplied text.
    const safe = /^[=+\-@]/.test(s) && typeof v === "string" ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return "﻿" + [r.columns, ...r.rows].map((row) => row.map(esc).join(",")).join("\r\n"); // BOM so Excel reads UTF-8
}
