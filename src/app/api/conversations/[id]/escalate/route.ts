import { z } from "zod";
import { errorResponse, HttpError, requireConversation } from "@/lib/inbox/auth";
import { addBotNote, logEvent, updateConversation } from "@/lib/inbox/service";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { appUrl, renderEmail, sendMail } from "@/lib/mail";
import { formatPhone } from "@/lib/format";
import { audit, enforce, LIMITS } from "@/lib/security";
import type { EscalationContact } from "@/lib/types";

const Body = z.object({
  contactIds: z.array(z.string().max(64)).max(10).default([]),
  // One-off address, supervisors and admins only (agents use the configured contacts).
  extraEmail: z.email().max(200).optional(),
  note: z.string().trim().min(3).max(2000),
  includeTranscript: z.boolean().default(true),
});

const kampala = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Kampala", dateStyle: "medium", timeStyle: "short" });

/** POST /api/conversations/:id/escalate → emails the ticket to the chosen concerned parties. */
export async function POST(req: Request, ctx: RouteContext<"/api/conversations/[id]/escalate">) {
  try {
    const { id } = await ctx.params;
    const { profile, conv, contact, mvno } = await requireConversation(id);
    const body = Body.parse(await req.json());
    await enforce(`escalate:${profile.id}`, LIMITS.escalate);
    const db = supabaseAdmin();

    // Fresh read: getMvno is cached and contacts may have just been edited.
    const { data: row } = await db.from("mvnos").select("escalation_contacts").eq("id", conv.mvno_id).single();
    const configured = (row?.escalation_contacts ?? []) as EscalationContact[];
    const chosen = configured.filter((c) => body.contactIds.includes(c.id));
    const to = chosen.flatMap((c) => c.emails);

    if (body.extraEmail) {
      if (!profile.is_platform_admin) {
        const { data: m } = await db.from("mvno_members").select("role").eq("mvno_id", conv.mvno_id).eq("user_id", profile.id).maybeSingle();
        if (m?.role !== "admin" && m?.role !== "supervisor") throw new HttpError(403, "Only supervisors and admins can escalate to an address that isn't in the list");
      }
      to.push(body.extraEmail);
    }
    if (!to.length) throw new HttpError(400, "Choose who to escalate to");

    const label = [...chosen.map((c) => c.name), ...(body.extraEmail ? [body.extraEmail] : [])].join(", ");
    const ref = conv.ticket_no ? `#${conv.ticket_no}` : "(bot chat)";

    let transcript = "";
    if (body.includeTranscript) {
      const { data: msgs } = await db
        .from("messages")
        .select("direction, sender_type, body, type, created_at")
        .eq("conversation_id", conv.id)
        .eq("is_internal", false)
        .order("created_at", { ascending: false })
        .limit(30);
      transcript = (msgs ?? [])
        .reverse()
        .map((m) => {
          const who = m.direction === "in" ? (contact.name ?? "Customer") : m.sender_type === "bot" ? "Bot" : "Agent";
          const time = new Date(m.created_at).toLocaleTimeString("en-GB", { timeZone: "Africa/Kampala", hour: "2-digit", minute: "2-digit" });
          return `[${time}] ${who}: ${(m.body ?? `(${m.type})`).slice(0, 500)}`;
        })
        .join("\n");
    }

    const rows: [string, string][] = [
      ["Ticket", `${ref} · ${mvno.name}`],
      ["Customer", `${contact.name ?? "Unknown"} (${formatPhone(contact.wa_id)})`],
      ["Subject", conv.subject ?? "–"],
      ["Priority", conv.priority],
      ["Status", conv.status],
      ["Category", conv.category ?? "–"],
      ["Opened", `${kampala(conv.created_at)} (Kampala)`],
      ["Escalated by", profile.full_name],
      ["Reason", body.note],
    ];
    if (conv.ai_summary) rows.push(["Summary", conv.ai_summary]);
    if (transcript) rows.push(["Recent chat", transcript]);

    const err = await sendMail(
      to,
      `[${mvno.name}] Escalation: ticket ${ref}${conv.subject ? ` · ${conv.subject.slice(0, 60)}` : ""}`,
      renderEmail({
        brand: mvno,
        title: `Ticket ${ref} escalated to you`,
        intro: `${profile.full_name} needs your help with this customer case. Please reply to them or update the ticket once it's handled.`,
        rows,
        cta: { label: "Open ticket", url: `${appUrl()}/tickets?t=${conv.id}` },
        footer: "You receive this because a Tuongee user escalated a customer ticket to you.",
      }),
    );
    if (err) throw new HttpError(400, `Email not sent: ${err}`);

    const updated = await updateConversation(conv.id, { escalated_at: new Date().toISOString(), escalated_to: label.slice(0, 300) });
    await logEvent(updated, `${profile.full_name} escalated to ${label}`, profile.id);
    await addBotNote(updated, `📣 Escalated to ${label}\nReason: ${body.note}`);
    await audit(profile, "ticket.escalate", { mvnoId: conv.mvno_id, target: conv.id, details: { to: label, recipients: to.length } });
    return Response.json({ conversation: updated });
  } catch (e) {
    return errorResponse(e);
  }
}
