import { connection } from "next/server";
import { errorResponse, HttpError, requireMvnoAdmin, requireMvnoManager } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { audit } from "@/lib/security";

async function load(id: string) {
  const { data } = await supabaseAdmin().from("campaigns").select("id, mvno_id, name, status").eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "Campaign not found");
  return data;
}

/** GET → failed recipients with WhatsApp's reason. */
export async function GET(_req: Request, ctx: RouteContext<"/api/campaigns/[id]">) {
  await connection();
  try {
    const c = await load((await ctx.params).id);
    await requireMvnoManager(c.mvno_id);
    const { data } = await supabaseAdmin().from("campaign_recipients").select("wa_id, name, error").eq("campaign_id", c.id).eq("status", "failed").limit(200);
    return Response.json({ failed: data ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST { action: "cancel" } → stops a campaign; anything not yet sent is skipped. */
export async function POST(req: Request, ctx: RouteContext<"/api/campaigns/[id]">) {
  try {
    const c = await load((await ctx.params).id);
    const { profile } = await requireMvnoAdmin(c.mvno_id);
    const { action } = (await req.json()) as { action?: string };
    if (action !== "cancel") throw new HttpError(400, "Unknown action");
    if (c.status !== "sending") throw new HttpError(400, "This campaign has already finished");
    const db = supabaseAdmin();
    await db.from("campaigns").update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("id", c.id);
    await db.from("campaign_recipients").update({ status: "skipped" }).eq("campaign_id", c.id).eq("status", "queued");
    await audit(profile, "campaign.cancelled", { mvnoId: c.mvno_id, target: c.name });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
