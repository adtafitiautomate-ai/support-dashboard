import { z } from "zod";
import { errorResponse, HttpError, requireConversation } from "@/lib/inbox/auth";
import { logEvent, recentMessages, resolveConversation, sendMessage, updateConversation } from "@/lib/inbox/service";
import { suggestReply, triage } from "@/lib/bot/ai";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { enforce, LIMITS } from "@/lib/security";
import { notifyAssigned } from "@/lib/user-notify";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), userId: z.guid().nullable() }),
  z.object({ action: z.literal("resolve"), csat: z.boolean().default(true) }),
  z.object({ action: z.literal("reopen") }),
  z.object({ action: z.literal("pending") }),
  z.object({ action: z.literal("return_to_bot") }),
  z.object({ action: z.literal("priority"), priority: z.enum(["low", "normal", "high", "urgent"]) }),
  z.object({ action: z.literal("summarize") }),
  z.object({ action: z.literal("suggest"), instruction: z.string().max(500).optional() }),
  z.object({ action: z.literal("read") }),
]);

export async function POST(req: Request, ctx: RouteContext<"/api/conversations/[id]/actions">) {
  try {
    const { id } = await ctx.params;
    const { profile, conv, contact, mvno } = await requireConversation(id);
    const body = Body.parse(await req.json());
    const who = profile.full_name;

    switch (body.action) {
      case "assign": {
        if (body.userId) {
          const { data: member } = await supabaseAdmin()
            .from("mvno_members")
            .select("user_id, profiles(full_name)")
            .eq("mvno_id", conv.mvno_id)
            .eq("user_id", body.userId)
            .maybeSingle();
          if (!member) throw new HttpError(400, "That agent is not on this tenant's team");
          const name = (member.profiles as unknown as { full_name: string }).full_name;
          const updated = await updateConversation(conv.id, {
            assignee_id: body.userId,
            status: conv.status === "bot" || conv.status === "resolved" ? "open" : conv.status,
            handoff_at: conv.handoff_at ?? new Date().toISOString(),
          });
          await logEvent(updated, body.userId === profile.id ? `${who} took the conversation` : `${who} assigned to ${name}`, profile.id);
          if (body.userId !== profile.id && body.userId !== conv.assignee_id) {
            await notifyAssigned({ mvno, conv: updated, contact, assigneeId: body.userId, by: who });
          }
          return Response.json({ conversation: updated });
        }
        const updated = await updateConversation(conv.id, { assignee_id: null });
        await logEvent(updated, `${who} unassigned the conversation`, profile.id);
        return Response.json({ conversation: updated });
      }
      case "resolve":
        return Response.json({ conversation: await resolveConversation(mvno, conv, contact, profile.id, body.csat) });
      case "reopen": {
        const { data: other } = await supabaseAdmin()
          .from("conversations")
          .select("id")
          .eq("contact_id", contact.id)
          .neq("status", "resolved")
          .neq("id", conv.id)
          .maybeSingle();
        if (other) throw new HttpError(409, "This customer already has an active conversation");
        const updated = await updateConversation(conv.id, { status: "open", resolved_at: null, bot_state: {} });
        await logEvent(updated, `${who} reopened the conversation`, profile.id);
        return Response.json({ conversation: updated });
      }
      case "pending": {
        const updated = await updateConversation(conv.id, { status: "pending" });
        await logEvent(updated, `${who} marked as waiting on customer`, profile.id);
        return Response.json({ conversation: updated });
      }
      case "return_to_bot": {
        const updated = await updateConversation(conv.id, { status: "bot", assignee_id: null, bot_state: {} });
        await logEvent(updated, `${who} handed the conversation back to the bot`, profile.id);
        await sendMessage(
          mvno,
          updated,
          contact,
          {
            type: "buttons",
            body: `You're back with ${mvno.bot_name}, our assistant. Anything else I can help with?`,
            buttons: [
              { id: "menu:main", title: "Main menu" },
              { id: "menu:human", title: "Talk to an agent" },
            ],
          },
          { senderType: "bot" },
        );
        return Response.json({ conversation: updated });
      }
      case "priority": {
        const updated = await updateConversation(conv.id, { priority: body.priority });
        await logEvent(updated, `${who} set priority to ${body.priority}`, profile.id);
        return Response.json({ conversation: updated });
      }
      case "read":
        return Response.json({ conversation: await updateConversation(conv.id, { unread_count: 0 }) });
      case "summarize": {
        await enforce(`ai:summary:${profile.id}`, LIMITS.aiSummary);
        const t = await triage(await recentMessages(conv.id, 60), "summary");
        if (!t) throw new HttpError(503, "AI is not configured (set ANTHROPIC_API_KEY)");
        const updated = await updateConversation(conv.id, {
          subject: t.subject,
          ai_summary: t.summary,
          sentiment: t.sentiment,
          category: conv.category ?? t.category,
        });
        return Response.json({ conversation: updated });
      }
      case "suggest": {
        await enforce(`ai:draft:${profile.id}`, LIMITS.aiDraft);
        const draft = await suggestReply(mvno, contact, await recentMessages(conv.id, 40), who, body.instruction);
        if (draft === null) throw new HttpError(503, "AI is not configured (set ANTHROPIC_API_KEY)");
        return Response.json({ draft });
      }
    }
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: "Invalid request" }, { status: 400 });
    return errorResponse(e);
  }
}
