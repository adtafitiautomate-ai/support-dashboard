import { z } from "zod";
import { errorResponse, HttpError, requireMvnoMember } from "@/lib/inbox/auth";
import { enforce, LIMITS } from "@/lib/security";
import { getActiveConversation, logEvent, sendMessage, updateConversation, upsertContact } from "@/lib/inbox/service";

// Business-initiated outreach: WhatsApp requires an approved template to open the chat.
const Body = z.object({
  mvnoId: z.guid(),
  to: z.string().regex(/^\d{8,15}$/),
  name: z.string().max(80).optional(),
  template: z.string().min(1).max(512),
  language: z.string().min(2).max(10),
  params: z.array(z.string().max(1024)).max(10).optional(),
});

export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const { profile, mvno } = await requireMvnoMember(body.mvnoId);
    await enforce(`outreach:${profile.id}`, LIMITS.outreach);

    const contact = await upsertContact(mvno, body.to, body.name);
    let conv = await getActiveConversation(mvno, contact);
    conv = await updateConversation(conv.id, {
      status: "open",
      assignee_id: conv.assignee_id ?? profile.id,
      handoff_at: conv.handoff_at ?? new Date().toISOString(),
      subject: conv.subject ?? `Outreach: ${body.template}`,
    });
    await logEvent(conv, `${profile.full_name} started an outbound conversation`, profile.id);
    const msg = await sendMessage(
      mvno,
      conv,
      contact,
      { type: "template", name: body.template, language: body.language, params: body.params },
      { senderType: "agent", senderId: profile.id },
    );
    if (msg.status === "failed") throw new HttpError(502, msg.error ?? "WhatsApp rejected the template");
    return Response.json({ conversationId: conv.id });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: "Check the number (digits only, with country code) and template" }, { status: 400 });
    return errorResponse(e);
  }
}
