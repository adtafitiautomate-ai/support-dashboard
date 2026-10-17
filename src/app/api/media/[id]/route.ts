import { connection } from "next/server";
import { errorResponse, HttpError, requireAgent } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { MEDIA_BUCKET, storeInboundMedia } from "@/lib/whatsapp/media";

/** Serves a message's media to signed-in agents via a short-lived signed URL. */
export async function GET(req: Request, ctx: RouteContext<"/api/media/[id]">) {
  await connection();
  try {
    const { id } = await ctx.params;
    const { supabase } = await requireAgent();
    // RLS: only members of the message's MVNO can read it.
    const { data: message } = await supabase.from("messages").select("id, mvno_id, payload").eq("id", id).maybeSingle();
    if (!message) throw new HttpError(404, "Not found");

    // Older messages, or a failed background download: fetch from Meta now.
    const path = (message.payload?.mediaPath as string | undefined) ?? (await storeInboundMedia(message));
    if (!path) throw new HttpError(404, "No media on this message");

    const download = new URL(req.url).searchParams.has("download");
    const { data, error } = await supabaseAdmin()
      .storage.from(MEDIA_BUCKET)
      .createSignedUrl(path, 300, download ? { download: (message.payload?.filename as string) || true } : undefined);
    if (error || !data) throw error ?? new Error("Could not sign media URL");
    return Response.redirect(data.signedUrl, 302);
  } catch (e) {
    if (e instanceof Error && /Media (lookup|download) failed|expired|Session has expired/i.test(e.message)) {
      return Response.json({ error: "WhatsApp no longer has this file, or the access token expired." }, { status: 410 });
    }
    return errorResponse(e);
  }
}
