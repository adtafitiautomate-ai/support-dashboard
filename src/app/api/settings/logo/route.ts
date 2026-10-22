import { z } from "zod";
import { errorResponse, HttpError, requireMvnoAdmin } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { forgetMvno } from "@/lib/inbox/service";
import { audit } from "@/lib/security";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("upload"), mvnoId: z.guid(), mime: z.enum(["image/png", "image/jpeg"]), size: z.number().int().positive().max(1024 * 1024, "Logo must be under 1 MB") }),
  z.object({ action: z.literal("save"), mvnoId: z.guid(), path: z.string().max(200) }),
  z.object({ action: z.literal("remove"), mvnoId: z.guid() }),
]);

/** Tenant logo for emails: get an upload URL, save it, or remove it (tenant admins). */
export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const { profile } = await requireMvnoAdmin(body.mvnoId);
    const db = supabaseAdmin();
    if (body.action === "upload") {
      const path = `${body.mvnoId}/logo-${crypto.randomUUID().slice(0, 8)}.${body.mime === "image/png" ? "png" : "jpg"}`;
      const { data, error } = await db.storage.from("branding").createSignedUploadUrl(path);
      if (error || !data) throw error ?? new Error("Could not prepare the upload");
      return Response.json({ path, token: data.token });
    }
    if (body.action === "save") {
      if (!body.path.startsWith(`${body.mvnoId}/`)) throw new HttpError(400, "Invalid file");
      const url = db.storage.from("branding").getPublicUrl(body.path).data.publicUrl;
      const { error } = await db.from("mvnos").update({ logo_url: url }).eq("id", body.mvnoId);
      if (error) throw error;
      forgetMvno(body.mvnoId);
      await audit(profile, "branding.logo_set", { mvnoId: body.mvnoId });
      return Response.json({ logo_url: url });
    }
    await db.from("mvnos").update({ logo_url: null }).eq("id", body.mvnoId);
    forgetMvno(body.mvnoId);
    await audit(profile, "branding.logo_removed", { mvnoId: body.mvnoId });
    return Response.json({ logo_url: null });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
