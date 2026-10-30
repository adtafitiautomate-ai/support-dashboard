import { connection, type NextRequest } from "next/server";
import { errorResponse, HttpError, requireAgent } from "@/lib/inbox/auth";
import { buildReport, REPORTS, toCsv, type ReportType } from "@/lib/reports";
import { audit, enforce, LIMITS } from "@/lib/security";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { modulesOf, type ModuleKey } from "@/lib/modules";

/** GET /api/reports?type=summary&mvno=<id|all>&from=YYYY-MM-DD&to=YYYY-MM-DD&format=json|csv */
export async function GET(req: NextRequest) {
  await connection(); // per-request data: never prerender
  try {
    const p = req.nextUrl.searchParams;
    const type = p.get("type") as ReportType;
    if (!(type in REPORTS)) throw new HttpError(400, "Unknown report");
    const from = p.get("from");
    const to = p.get("to");
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new HttpError(400, "Pick a date range");

    // Reports are for admins and supervisors only.
    const { supabase, profile } = await requireAgent();
    const { data: memberships } = await supabase.from("mvno_members").select("mvno_id, role").eq("user_id", profile.id);
    const allowed = profile.is_platform_admin
      ? ((await supabase.from("mvnos").select("id")).data ?? []).map((m) => m.id as string)
      : (memberships ?? []).filter((m) => m.role === "admin" || m.role === "supervisor").map((m) => m.mvno_id as string);
    if (!allowed.length) throw new HttpError(403, "Reports are available to admins and supervisors");
    const mvno = p.get("mvno") ?? "all";
    const mvnoIds = mvno === "all" ? allowed : allowed.filter((id) => id === mvno);
    if (!mvnoIds.length) throw new HttpError(403, "You can't run reports for this tenant");
    await enforce(`reports:${profile.id}`, LIMITS.reports);

    const toExclusive = new Date(`${to}T00:00:00Z`);
    toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
    const { data: tenants } = await supabaseAdmin().from("mvnos").select("kind, modules").in("id", mvnoIds);
    const modules = new Set<ModuleKey>((tenants ?? []).flatMap((m) => [...modulesOf(m)]));
    const report = await buildReport(type, { mvnoIds, from: `${from}T00:00:00Z`, to: toExclusive.toISOString(), modules });

    if (p.get("format") === "csv") {
      // Exports contain customer data: record who took what (data-protection accountability).
      await audit(profile, "report.exported", {
        mvnoId: mvnoIds.length === 1 ? mvnoIds[0] : null,
        target: REPORTS[type],
        details: { type, from, to, rows: report.rows.length, mvnos: mvnoIds.length },
      });
      return new Response(toCsv(report), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${type}_${from}_to_${to}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
