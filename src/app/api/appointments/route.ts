import { connection, type NextRequest } from "next/server";
import { errorResponse, requireMvnoMember } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** GET /api/appointments?mvno=<id>&view=requested|upcoming|past → appointments for the tenant's team. */
export async function GET(req: NextRequest) {
  await connection();
  try {
    const sp = req.nextUrl.searchParams;
    const mvnoId = sp.get("mvno") ?? "";
    await requireMvnoMember(mvnoId);
    const view = sp.get("view") ?? "requested";
    let q = supabaseAdmin()
      .from("appointments")
      .select("*, contact:contacts(name, wa_id), handler:profiles(full_name)")
      .eq("mvno_id", mvnoId);
    if (view === "requested") q = q.eq("status", "requested").order("created_at", { ascending: true });
    else if (view === "upcoming") q = q.eq("status", "confirmed").order("scheduled_at", { ascending: true });
    else q = q.in("status", ["completed", "no_show", "cancelled"]).order("updated_at", { ascending: false });
    const [{ data, error }, { data: counts }] = await Promise.all([
      q.limit(200),
      supabaseAdmin().from("appointments").select("status").eq("mvno_id", mvnoId).in("status", ["requested", "confirmed"]),
    ]);
    if (error) throw error;
    const { data: offices } = await supabaseAdmin().from("outlets").select("name").eq("mvno_id", mvnoId).limit(20);
    return Response.json({
      appointments: data ?? [],
      counts: { requested: (counts ?? []).filter((c) => c.status === "requested").length, upcoming: (counts ?? []).filter((c) => c.status === "confirmed").length },
      offices: (offices ?? []).map((o) => o.name),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
