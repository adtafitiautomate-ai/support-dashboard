import { connection, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/inbox/auth";
import { requirePlatformAdmin } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** GET /api/admin/emails?status=&q=&page= → the email log (super admins). */
export async function GET(req: NextRequest) {
  await connection();
  try {
    await requirePlatformAdmin();
    const sp = req.nextUrl.searchParams;
    const page = Math.max(0, Number(sp.get("page")) || 0);
    const status = sp.get("status");
    const q = (sp.get("q") ?? "").trim().slice(0, 80).replace(/[%,()]/g, "");
    let query = supabaseAdmin().from("email_log").select("*", { count: "exact" }).order("created_at", { ascending: false });
    if (status === "sent" || status === "failed" || status === "not_sent") query = query.eq("status", status);
    if (q) query = query.ilike("subject", `%${q}%`);
    const { data, count, error } = await query.range(page * 25, page * 25 + 24);
    if (error) throw error;
    return Response.json({ emails: data ?? [], total: count ?? 0, pageSize: 25 });
  } catch (e) {
    return errorResponse(e);
  }
}
