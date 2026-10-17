import { after } from "next/server";
import { errorResponse, HttpError, requireAgent } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ingestSource } from "@/lib/kb/ingest";

export const maxDuration = 300;

/** Re-syncs a link source (e.g. after the MVNO updates its website). */
export async function POST(_req: Request, ctx: RouteContext<"/api/kb/sources/[id]">) {
  try {
    const { id } = await ctx.params;
    const { supabase, profile } = await requireAgent();
    const { data: source } = await supabase.from("kb_sources").select("*").eq("id", id).maybeSingle();
    if (!source) throw new HttpError(404, "Source not found");
    const { data: membership } = await supabase.from("mvno_members").select("role").eq("mvno_id", source.mvno_id).eq("user_id", profile.id).maybeSingle();
    if (!profile.is_platform_admin && !["admin", "supervisor"].includes(membership?.role ?? "")) throw new HttpError(403, "Not allowed");
    if (source.kind !== "url") throw new HttpError(400, "Re-upload the file to refresh it");

    await supabaseAdmin().from("kb_sources").update({ status: "processing", error: null }).eq("id", id);
    after(() => ingestSource(id, source.mvno_id, { kind: "url", url: source.url! }));
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
