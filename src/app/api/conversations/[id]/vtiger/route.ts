import { connection } from "next/server";
import { z } from "zod";
import { errorResponse, HttpError, requireConversation } from "@/lib/inbox/auth";
import { addBotNote, logEvent, updateConversation } from "@/lib/inbox/service";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { appUrl } from "@/lib/mail";
import { formatPhone } from "@/lib/format";
import { audit, enforce, LIMITS } from "@/lib/security";
import { createVtigerTicket, suggestCategory, vtigerEnabled, vtigerOptions, vtigerRecordUrl } from "@/lib/vtiger";

/** GET → options and suggested values for the "Send to vtiger" form (read-only on vtiger). */
export async function GET(_req: Request, ctx: RouteContext<"/api/conversations/[id]/vtiger">) {
  await connection();
  try {
    if (!vtigerEnabled()) return Response.json({ enabled: false });
    const { conv, mvno } = await requireConversation((await ctx.params).id);
    if (conv.vtiger_ticket_id) {
      return Response.json({ enabled: true, existing: { no: conv.vtiger_ticket_no, url: vtigerRecordUrl(conv.vtiger_ticket_id) } });
    }
    const o = await vtigerOptions();
    // PaxTel → "Paxtel Mobile": match the tenant's name to an organization.
    const org = o.organizations.find((x) => x.name.toLowerCase().startsWith(mvno.name.toLowerCase())) ?? null;
    const text = [conv.subject, conv.ai_summary, conv.category].filter(Boolean).join(" ");
    return Response.json({
      enabled: true,
      options: o,
      defaults: {
        title: conv.subject ?? "",
        organizationId: org?.id ?? "",
        priority: o.priorities.find((p) => p.toLowerCase() === conv.priority) ?? "Normal",
        severity: conv.priority === "urgent" ? "Critical" : conv.priority === "high" || conv.category === "payment" ? "Major" : "Minor",
        category: suggestCategory(o.categories, text, org?.name ?? mvno.name),
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

const Body = z.object({
  title: z.string().trim().min(3).max(250),
  organizationId: z.string().regex(/^\d+x\d+$/),
  assignedTo: z.string().regex(/^(19|20)x\d+$/),
  priority: z.string().min(1).max(40),
  severity: z.string().max(40).optional(),
  category: z.string().max(60).optional(),
  note: z.string().trim().min(3).max(2000),
});

/** POST → creates ONE real vtiger ticket for this chat (never a second). */
export async function POST(req: Request, ctx: RouteContext<"/api/conversations/[id]/vtiger">) {
  try {
    if (!vtigerEnabled()) throw new HttpError(400, "vtiger isn't set up");
    const { profile, conv, contact, mvno } = await requireConversation((await ctx.params).id);
    if (conv.vtiger_ticket_id) throw new HttpError(409, `This chat already has vtiger ticket ${conv.vtiger_ticket_no}`);
    const body = Body.parse(await req.json());
    await enforce(`escalate:${profile.id}`, LIMITS.escalate);

    // Only values vtiger offers (guards against stale or tampered forms).
    const o = await vtigerOptions();
    if (!o.organizations.some((x) => x.id === body.organizationId)) throw new HttpError(400, "Choose an organization from the list");
    if (![...o.groups, ...o.people].some((x) => x.id === body.assignedTo)) throw new HttpError(400, "Choose who to assign it to from the list");
    if (!o.priorities.includes(body.priority)) throw new HttpError(400, "Choose a valid priority");
    if (body.severity && !o.severities.includes(body.severity)) throw new HttpError(400, "Choose a valid severity");
    if (body.category && !o.categories.includes(body.category)) throw new HttpError(400, "Choose a valid category");

    const { data: msgs } = await supabaseAdmin()
      .from("messages")
      .select("direction, sender_type, body, type, created_at")
      .eq("conversation_id", conv.id)
      .eq("is_internal", false)
      .order("created_at", { ascending: false })
      .limit(20);
    const chat = (msgs ?? [])
      .reverse()
      .map((m) => {
        const who = m.direction === "in" ? (contact.name ?? "Customer") : m.sender_type === "bot" ? "Bot" : "Agent";
        const at = new Date(m.created_at).toLocaleString("en-GB", { timeZone: "Africa/Kampala", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
        return `[${at}] ${who}: ${(m.body ?? `(${m.type})`).slice(0, 400)}`;
      })
      .join("\n");
    const customer = `${contact.name ?? "Unknown"} (${formatPhone(contact.wa_id)})`;
    const description = [
      `Escalated from Tuongee (WhatsApp) by ${profile.full_name}`,
      `Tenant: ${mvno.name}`,
      `Customer: ${customer}`,
      conv.ticket_no ? `Tuongee ticket: #${conv.ticket_no}` : null,
      ``,
      `Note from agent:`,
      body.note,
      conv.ai_summary ? `\nSummary:\n${conv.ai_summary}` : null,
      chat ? `\nRecent chat:\n${chat}` : null,
      `\nOpen in Tuongee: ${appUrl()}/inbox?c=${conv.id}`,
    ]
      .filter((x) => x !== null)
      .join("\n");

    const t = await createVtigerTicket({
      title: body.title,
      organizationId: body.organizationId,
      assignedTo: body.assignedTo,
      priority: body.priority,
      severity: body.severity || undefined,
      category: body.category || undefined,
      description,
      requestor: customer,
    });
    const assignee = [...o.groups, ...o.people].find((x) => x.id === body.assignedTo)?.name ?? body.assignedTo;
    const updated = await updateConversation(conv.id, { vtiger_ticket_id: t.id, vtiger_ticket_no: t.ticket_no, escalated_at: new Date().toISOString(), escalated_to: `vtiger ${t.ticket_no} · ${assignee}` });
    await logEvent(updated, `${profile.full_name} created vtiger ticket ${t.ticket_no} for ${assignee}`, profile.id);
    await addBotNote(updated, `🎫 vtiger ticket ${t.ticket_no} (${assignee})\nReason: ${body.note}`);
    await audit(profile, "vtiger.ticket_created", { mvnoId: conv.mvno_id, target: t.ticket_no, details: { conversation: conv.id, assignee } });
    return Response.json({ conversation: updated, ticket: { no: t.ticket_no, url: vtigerRecordUrl(t.id) } });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
