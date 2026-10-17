import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, HttpError, requireMvnoAdmin, requireMvnoManager } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { audit, enforce, LIMITS } from "@/lib/security";
import { SIMULATOR_TAG } from "@/lib/inbox/simulation";
import { toIntlPrefix } from "@/lib/audience";

// Campaign audience: customers who messaged the MVNO from a number in its own ranges.

const PAGE_SIZE = 25;

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  // Leading = + - @ would run as a formula in Excel.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** GET /api/audience?mvno=<id>&q=&page=&format=csv */
export async function GET(req: NextRequest) {
  await connection();
  try {
    const sp = req.nextUrl.searchParams;
    const mvnoId = sp.get("mvno") ?? "";
    const { profile, mvno } = await requireMvnoManager(mvnoId);
    const db = supabaseAdmin();
    // Read fresh (getMvno is cached) so a just-saved range applies immediately.
    const { data: row } = await db.from("mvnos").select("number_prefixes").eq("id", mvnoId).single();
    const prefixes: string[] = row?.number_prefixes ?? [];
    const csv = sp.get("format") === "csv";
    if (!prefixes.length) return csv ? new Response("No number ranges set", { status: 400 }) : Response.json({ prefixes, contacts: [], total: 0, optedOut: 0 });

    const q = (sp.get("q") ?? "").trim().slice(0, 60);
    const page = Math.max(0, Number(sp.get("page")) || 0);
    const inRange = prefixes.map((p) => `wa_id.like.${p}%`).join(","); // digits only (DB check)
    const base = () => {
      let b = db
        .from("contacts")
        .select("id, wa_id, name, created_at, last_seen_at, opted_out_at", { count: "exact" })
        .eq("mvno_id", mvnoId)
        .or(inRange)
        .not("tags", "cs", `{${SIMULATOR_TAG}}`);
      if (q) {
        const digits = q.replace(/\D/g, "");
        const name = q.replace(/[^\p{L}\p{N} ]/gu, "");
        const terms = [name && `name.ilike.%${name}%`, digits && `wa_id.like.%${digits.replace(/^0/, "")}%`].filter(Boolean);
        if (terms.length) b = b.or(terms.join(","));
      }
      return b.order("last_seen_at", { ascending: false, nullsFirst: false });
    };

    if (csv) {
      await enforce(`reports:${profile.id}`, LIMITS.reports);
      const rows: { wa_id: string; name: string | null; created_at: string; last_seen_at: string | null }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await base().is("opted_out_at", null).range(from, from + 999);
        if (error) throw error;
        rows.push(...(data ?? []));
        if ((data ?? []).length < 1000) break;
      }
      await audit(profile, "audience.export", { mvnoId, details: { rows: rows.length } });
      const lines = [
        ["WhatsApp number", "Local number", "Name", "First contact", "Last contact"].join(","),
        ...rows.map((r) => [`+${r.wa_id}`, r.wa_id.startsWith("256") ? `0${r.wa_id.slice(3)}` : "", r.name, r.created_at, r.last_seen_at].map(csvCell).join(",")),
      ];
      return new Response("﻿" + lines.join("\r\n"), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${mvno.slug}-audience-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    const { data, count, error } = await base().range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw error;
    const { count: optedOut } = await db
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("mvno_id", mvnoId)
      .or(inRange)
      .not("opted_out_at", "is", null);
    return Response.json({ prefixes, contacts: data ?? [], total: count ?? 0, optedOut: optedOut ?? 0, pageSize: PAGE_SIZE });
  } catch (e) {
    return errorResponse(e);
  }
}

const Body = z.object({ mvnoId: z.guid(), prefixes: z.array(z.string().trim().max(20)).max(30) });

/** POST /api/audience { mvnoId, prefixes } (MVNO admins): sets the MVNO's number ranges. */
export async function POST(req: NextRequest) {
  try {
    const body = Body.parse(await req.json());
    const { profile } = await requireMvnoAdmin(body.mvnoId);
    await enforce(`admin:${profile.id}`, LIMITS.admin);
    const prefixes = [...new Set(body.prefixes.filter(Boolean).map(toIntlPrefix))];
    const bad = prefixes.find((p) => !p || p.length < 5);
    if (bad !== undefined) throw new HttpError(400, "Each range needs at least 4 digits, e.g. 07243");
    const { error } = await supabaseAdmin().from("mvnos").update({ number_prefixes: prefixes }).eq("id", body.mvnoId);
    if (error) throw error;
    await audit(profile, "audience.ranges", { mvnoId: body.mvnoId, details: { prefixes } });
    return Response.json({ prefixes });
  } catch (e) {
    return errorResponse(e);
  }
}
