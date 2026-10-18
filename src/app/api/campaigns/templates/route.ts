import { connection, type NextRequest } from "next/server";
import { errorResponse, requireMvnoManager } from "@/lib/inbox/auth";
import { fetchTemplates } from "@/lib/campaigns";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Mvno } from "@/lib/types";

/** GET /api/campaigns/templates?mvno=<id> → the tenant's approved WhatsApp templates. */
export async function GET(req: NextRequest) {
  await connection();
  try {
    const mvnoId = req.nextUrl.searchParams.get("mvno") ?? "";
    await requireMvnoManager(mvnoId);
    // Fresh row (getMvno is cached and may predate the WABA id).
    const { data: mvno } = await supabaseAdmin().from("mvnos").select("*").eq("id", mvnoId).single();
    return Response.json({ templates: await fetchTemplates(mvno as Mvno) });
  } catch (e) {
    return errorResponse(e);
  }
}
