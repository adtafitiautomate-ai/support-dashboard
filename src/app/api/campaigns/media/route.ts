import { z } from "zod";
import { errorResponse, HttpError, requireMvnoAdmin } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { MEDIA_BUCKET } from "@/lib/whatsapp/media";
import { classifyMedia } from "@/lib/whatsapp/outbound-media";

const Body = z.object({ mvnoId: z.guid(), filename: z.string().trim().min(1).max(200), mime: z.string().max(120), size: z.number().int().positive() });

/** POST → signed upload URL for a campaign's header image/video/document. */
export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    await requireMvnoAdmin(body.mvnoId);
    const c = classifyMedia(body.mime, body.size);
    if ("error" in c) throw new HttpError(400, c.error);
    const ext = (body.filename.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
    const path = `${body.mvnoId}/campaigns/${crypto.randomUUID()}.${ext}`;
    const { data, error } = await supabaseAdmin().storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw error ?? new Error("Could not prepare the upload");
    return Response.json({ path, token: data.token, kind: c.kind });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
