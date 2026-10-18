import { z } from "zod";
import { errorResponse, HttpError, requireConversation } from "@/lib/inbox/auth";
import { logEvent, sendMessage, updateConversation } from "@/lib/inbox/service";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { OutboundMessage } from "@/lib/whatsapp/types";

const Body = z.object({
  text: z.string().max(4096).optional(),
  internal: z.boolean().optional(),
  out: z.custom<OutboundMessage>((v) => typeof v === "object" && v !== null && "type" in v).optional(),
});

const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(req: Request, ctx: RouteContext<"/api/conversations/[id]/messages">) {
  try {
    const { id } = await ctx.params;
    const { profile, conv, contact, mvno } = await requireConversation(id);
    const body = Body.parse(await req.json());

    // Internal note: visible to the team only.
    if (body.internal) {
      if (!body.text?.trim()) throw new HttpError(400, "Empty note");
      const { data, error } = await supabaseAdmin()
        .from("messages")
        .insert({
          conversation_id: conv.id,
          mvno_id: conv.mvno_id,
          direction: "out",
          sender_type: "agent",
          sender_id: profile.id,
          type: "note",
          body: body.text.trim(),
          is_internal: true,
          status: "sent",
        })
        .select()
        .single();
      if (error) throw error;
      return Response.json({ message: data });
    }

    const out: OutboundMessage | undefined = body.out ?? (body.text?.trim() ? { type: "text", text: body.text.trim() } : undefined);
    if (!out) throw new HttpError(400, "Empty message");
    // Attachments must be files uploaded for this conversation (see /attachments).
    if (out.type === "media" && !out.path.startsWith(`${conv.mvno_id}/out/${conv.id}/`)) throw new HttpError(400, "Invalid attachment");
    if (out.type === "media") delete out.link;

    // WhatsApp only allows free-form messages within 24h of the customer's last message.
    const windowOpen = conv.last_inbound_at && Date.now() - new Date(conv.last_inbound_at).getTime() < WINDOW_MS;
    if (!windowOpen && out.type !== "template") {
      throw new HttpError(409, "The 24-hour window is closed. Send an approved template to re-open the conversation.");
    }

    // An agent replying takes ownership of the conversation.
    if (conv.status !== "open" || !conv.assignee_id) {
      const now = new Date().toISOString();
      const taken = await updateConversation(conv.id, {
        status: "open",
        assignee_id: conv.assignee_id ?? profile.id,
        handoff_at: conv.handoff_at ?? now,
        bot_state: {},
      });
      if (!conv.assignee_id) await logEvent(taken, `${profile.full_name} took over the conversation`, profile.id);
    }

    const message = await sendMessage(mvno, conv, contact, out, { senderType: "agent", senderId: profile.id });
    if (message.status === "failed") throw new HttpError(502, message.error ?? "WhatsApp rejected the message");
    if (conv.unread_count) await updateConversation(conv.id, { unread_count: 0 });
    return Response.json({ message });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: "Invalid request" }, { status: 400 });
    return errorResponse(e);
  }
}
