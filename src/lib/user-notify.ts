import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { appUrl, renderEmail, sendMail } from "@/lib/mail";
import { contactEmailOf } from "@/lib/credentials-mail";

/**
 * Alerts people in the app (bell + pop-up) and by email when they have an address and SMTP
 * is set up. Each person gets their own email. Never throws: alerts must not break chats.
 */
export async function notifyUsers(
  userIds: string[],
  n: { mvnoId: string; mvnoName: string; conversationId: string; kind: string; title: string; body?: string; link: string; footer?: string },
) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return;
  try {
    const db = supabaseAdmin();
    await db.from("notifications").insert(ids.map((id) => ({ user_id: id, mvno_id: n.mvnoId, conversation_id: n.conversationId, kind: n.kind, title: n.title, body: n.body ?? null })));
    await Promise.all(
      ids.map(async (id) => {
        const { data } = await db.auth.admin.getUserById(id);
        const banned = !!data.user?.banned_until && new Date(data.user.banned_until) > new Date();
        const to = banned ? null : contactEmailOf(data.user);
        if (!to) return;
        await sendMail(
          [to],
          `[${n.mvnoName}] ${n.title}`,
          renderEmail({ title: n.title, intro: n.body, cta: { label: "Open the chat", url: n.link }, footer: n.footer }),
        );
      }),
    );
  } catch (e) {
    console.error("notify users", e);
  }
}

/** "New chat assigned to you" for the person a chat was just assigned to. */
export async function notifyAssigned(o: {
  mvno: { id: string; name: string };
  conv: { id: string; ticket_no: number | null; subject: string | null };
  contact: { name: string | null; wa_id: string };
  assigneeId: string;
  by: string | null; // who assigned it; null = the bot handed it over
  reason?: string;
}) {
  const who = o.contact.name || `+${o.contact.wa_id}`;
  const about = o.conv.subject || o.reason;
  await notifyUsers([o.assigneeId], {
    mvnoId: o.mvno.id,
    mvnoName: o.mvno.name,
    conversationId: o.conv.id,
    kind: "assigned",
    title: `New chat assigned to you: ${who}`,
    body: [o.conv.ticket_no ? `Ticket #${o.conv.ticket_no}` : null, about, o.by ? `assigned by ${o.by}` : "handed over by the bot"].filter(Boolean).join(" · "),
    link: `${appUrl()}/inbox?c=${o.conv.id}`,
    footer: "Sent because a customer chat was assigned to you in Tuongee.",
  });
}
