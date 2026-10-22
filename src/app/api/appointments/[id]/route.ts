import { z } from "zod";
import { errorResponse, HttpError, requireMvnoMember } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { logEvent, sendMessage } from "@/lib/inbox/service";
import { audit } from "@/lib/security";
import type { Contact, Conversation } from "@/lib/types";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("confirm"),
    scheduled_at: z.iso.datetime({ offset: true }),
    office: z.string().trim().max(200).optional(),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({ action: z.literal("cancel"), note: z.string().trim().max(500).optional(), notify: z.boolean().default(true) }),
  z.object({ action: z.literal("complete") }),
  z.object({ action: z.literal("no_show") }),
]);

const WINDOW_MS = 24 * 3_600_000;

/** POST /api/appointments/:id → confirm (messages the customer), cancel, or mark attended / no-show. */
export async function POST(req: Request, ctx: RouteContext<"/api/appointments/[id]">) {
  try {
    const { id } = await ctx.params;
    const db = supabaseAdmin();
    const { data: appt } = await db.from("appointments").select("*").eq("id", id).maybeSingle();
    if (!appt) throw new HttpError(404, "Appointment not found");
    const { profile, mvno } = await requireMvnoMember(appt.mvno_id);
    const body = Body.parse(await req.json());

    const status = { confirm: "confirmed", cancel: "cancelled", complete: "completed", no_show: "no_show" }[body.action];
    const patch: Record<string, unknown> = { status, handled_by: profile.id, updated_at: new Date().toISOString() };
    if (body.action === "confirm") Object.assign(patch, { scheduled_at: body.scheduled_at, office: body.office || null, staff_note: body.note || null });
    if (body.action === "cancel" && body.note) patch.staff_note = body.note;
    const { error } = await db.from("appointments").update(patch).eq("id", id);
    if (error) throw error;

    // Tell the customer on WhatsApp (confirmations always; cancellations if asked).
    let messaged: boolean | null = null;
    let warning: string | null = null;
    const tz = mvno.business_hours?.tz ?? "Africa/Kampala";
    const when =
      body.action === "confirm"
        ? new Date(body.scheduled_at).toLocaleString("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
        : "";
    const text =
      body.action === "confirm"
        ? `✅ Your appointment is confirmed\n\n• Service: *${appt.service}*\n• When: *${when}*${body.office ? `\n• Where: ${body.office}` : ""}${body.note ? `\n\n${body.note}` : ""}\n\nPlease arrive 10 minutes early with your documents. Reply here if you need to change it.`
        : body.action === "cancel" && body.notify
          ? `Your appointment request for *${appt.service}* has been cancelled.${body.note ? `\n\n${body.note}` : ""}\n\nYou can request a new one anytime from the menu.`
          : null;

    if (appt.conversation_id) {
      const { data: conv } = await db.from("conversations").select("*").eq("id", appt.conversation_id).maybeSingle();
      if (conv) {
        await logEvent(conv as Conversation, `${profile.full_name} ${body.action === "confirm" ? `confirmed the appointment for ${when}` : body.action === "cancel" ? "cancelled the appointment" : body.action === "complete" ? "marked the appointment attended" : "marked the appointment a no-show"}`, profile.id);
        if (text) {
          const open = conv.last_inbound_at && Date.now() - new Date(conv.last_inbound_at).getTime() < WINDOW_MS;
          if (open) {
            const { data: contact } = await db.from("contacts").select("*").eq("id", conv.contact_id).single();
            const m = await sendMessage(mvno, conv as Conversation, contact as Contact, { type: "text", text }, { senderType: "agent", senderId: profile.id });
            messaged = m.status !== "failed";
            if (!messaged) warning = `Saved, but WhatsApp didn't deliver the message: ${m.error ?? "unknown error"}`;
          } else {
            messaged = false;
            warning = "Saved. The customer's 24-hour WhatsApp window has closed, so they weren't messaged: send them an approved template from the chat.";
          }
        }
      }
    }
    await audit(profile, `appointment.${body.action}`, { mvnoId: appt.mvno_id, target: appt.full_name ?? appt.service, details: { when: when || null } });
    return Response.json({ ok: true, messaged, warning });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
