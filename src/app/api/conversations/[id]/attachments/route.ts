import { z } from "zod";
import { errorResponse, HttpError, requireConversation } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { MEDIA_BUCKET } from "@/lib/whatsapp/media";
import { classifyMedia } from "@/lib/whatsapp/outbound-media";

const Body = z.object({
  filename: z.string().trim().min(1).max(200),
  mime: z.string().trim().max(120),
  size: z.number().int().positive(),
});

/**
 * POST /api/conversations/:id/attachments → a one-time signed upload URL for an agent's
 * attachment. The browser uploads straight to Storage (no server size limit), then sends
 * the message with the returned path.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/conversations/[id]/attachments">) {
  try {
    const { id } = await ctx.params;
    const { conv } = await requireConversation(id);
    const body = Body.parse(await req.json());
    const c = classifyMedia(body.mime, body.size);
    if ("error" in c) throw new HttpError(400, c.error);

    const ext = (body.filename.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
    const path = `${conv.mvno_id}/out/${conv.id}/${crypto.randomUUID()}.${ext}`;
    const { data, error } = await supabaseAdmin().storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw error ?? new Error("Could not prepare the upload");
    return Response.json({ path, token: data.token, kind: c.kind });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
