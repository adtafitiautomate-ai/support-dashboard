import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, requireMvnoManager, requireMvnoMember } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { audit, enforce, LIMITS } from "@/lib/security";

// People who asked to be told when their National ID card arrives.

const PAGE_SIZE = 50;
const STATUS = { waiting: "waiting", arrived: "needs_template", told: "notified" } as const;

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // never run as a spreadsheet formula
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** GET /api/waiting-list?mvno=<id>&status=all|waiting|arrived|told&q=&page=&format=csv */
export async function GET(req: NextRequest) {
  await connection();
  try {
    const sp = req.nextUrl.searchParams;
    const mvnoId = sp.get("mvno") ?? "";
    const { profile, mvno } = await requireMvnoMember(mvnoId);
    const db = supabaseAdmin();
    const status = sp.get("status") as keyof typeof STATUS | null;
    const q = (sp.get("q") ?? "").trim().slice(0, 60);
    const page = Math.max(0, Number(sp.get("page")) || 0);
    const csv = sp.get("format") === "csv";

    // A number search matches the customer's WhatsApp number.
    const digits = q.replace(/\D/g, "").replace(/^0/, "");
    let contactIds: string[] = [];
    if (digits.length >= 4) {
      const { data } = await db.from("contacts").select("id").eq("mvno_id", mvnoId).like("wa_id", `%${digits}%`).limit(200);
      contactIds = (data ?? []).map((c) => c.id);
    }
    const name = q.replace(/[^\p{L} '-]/gu, "").trim();

    const base = () => {
      let b = db
        .from("id_watch")
        .select("id, full_name, status, created_at, notified_at, conversation_id, contact:contacts(id, name, wa_id), batch:id_batches(label)", { count: "exact" })
        .eq("mvno_id", mvnoId);
      if (status && status in STATUS) b = b.eq("status", STATUS[status]);
      const terms = [name && `full_name.ilike.%${name}%`, contactIds.length && `contact_id.in.(${contactIds.join(",")})`].filter(Boolean);
      if (q && !terms.length) b = b.eq("id", "00000000-0000-0000-0000-000000000000"); // nothing matches
      else if (terms.length) b = b.or(terms.join(","));
      return b.order("created_at", { ascending: false });
    };

    if (csv) {
      await requireMvnoManager(mvnoId); // exports of customer data: supervisors and admins
      await enforce(`reports:${profile.id}`, LIMITS.reports);
      const rows: Record<string, unknown>[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await base().range(from, from + 999);
        if (error) throw error;
        rows.push(...(data ?? []));
        if ((data ?? []).length < 1000) break;
      }
      await audit(profile, "waiting_list.export", { mvnoId, details: { rows: rows.length } });
      type R = { full_name: string; status: string; created_at: string; notified_at: string | null; contact: { name: string | null; wa_id: string } | null; batch: { label: string } | null };
      const label = { waiting: "Waiting", needs_template: "Arrived, not told yet", notified: "Arrived, told" } as Record<string, string>;
      const lines = [
        ["Name on application", "WhatsApp number", "WhatsApp name", "Status", "Added", "Told", "List"].join(","),
        ...(rows as R[]).map((r) => [r.full_name, r.contact ? `+${r.contact.wa_id}` : "", r.contact?.name, label[r.status] ?? r.status, r.created_at.slice(0, 10), r.notified_at?.slice(0, 10), r.batch?.label].map(csvCell).join(",")),
      ];
      return new Response("﻿" + lines.join("\r\n"), {
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${mvno.slug}-waiting-list-${new Date().toISOString().slice(0, 10)}.csv"` },
      });
    }

    const [{ data, count, error }, ...counts] = await Promise.all([
      base().range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1),
      ...Object.values(STATUS).map((s) => db.from("id_watch").select("id", { count: "exact", head: true }).eq("mvno_id", mvnoId).eq("status", s)),
    ]);
    if (error) throw error;
    const [waiting, arrived, told] = counts.map((c) => c.count ?? 0);
    return Response.json({ rows: data ?? [], total: count ?? 0, pageSize: PAGE_SIZE, counts: { waiting, arrived, told } });
  } catch (e) {
    return errorResponse(e);
  }
}

const Body = z.object({ action: z.literal("remove"), mvnoId: z.guid(), ids: z.array(z.guid()).min(1).max(500) });

/** POST { action: "remove", mvnoId, ids } (supervisors/admins): takes people off the list. */
export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const { profile } = await requireMvnoManager(body.mvnoId);
    const { error } = await supabaseAdmin().from("id_watch").delete().eq("mvno_id", body.mvnoId).in("id", body.ids);
    if (error) throw error;
    await audit(profile, "waiting_list.remove", { mvnoId: body.mvnoId, details: { count: body.ids.length } });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
