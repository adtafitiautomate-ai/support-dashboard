import { z } from "zod";
import { errorResponse, HttpError, requireAgent } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { forgetMvno } from "@/lib/inbox/service";

// Connects an MVNO to a Meta WhatsApp number (or back to the simulator).
const Body = z.object({
  mvnoId: z.guid(),
  phoneNumberId: z.string().trim().max(40).nullable(), // null → simulator
  displayNumber: z.string().trim().max(40).optional(),
  accessToken: z.string().trim().max(1000).optional(), // optional per-MVNO token; else WHATSAPP_ACCESS_TOKEN
});

export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const { supabase, profile } = await requireAgent();
    const { data: membership } = await supabase
      .from("mvno_members")
      .select("role")
      .eq("mvno_id", body.mvnoId)
      .eq("user_id", profile.id)
      .maybeSingle();
    if (!profile.is_platform_admin && membership?.role !== "admin") throw new HttpError(403, "Only MVNO admins can change the WhatsApp connection");

    const db = supabaseAdmin();
    const { data: mvno } = await db.from("mvnos").select("slug").eq("id", body.mvnoId).single();
    const phoneNumberId = body.phoneNumberId || `SIM-${mvno!.slug.toUpperCase()}`;
    const { error } = await db
      .from("mvnos")
      .update({ wa_phone_number_id: phoneNumberId, ...(body.displayNumber ? { wa_display_number: body.displayNumber } : {}) })
      .eq("id", body.mvnoId);
    if (error?.code === "23505") throw new HttpError(409, "That phone number ID is already connected to another MVNO");
    if (error) throw error;

    if (body.accessToken) {
      const { error: tokenErr } = await db.rpc("set_mvno_wa_token", { p_mvno: body.mvnoId, p_token: body.accessToken });
      if (tokenErr) throw tokenErr;
    }
    forgetMvno(body.mvnoId);
    return Response.json({ ok: true, phoneNumberId });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: "Invalid request" }, { status: 400 });
    return errorResponse(e);
  }
}
