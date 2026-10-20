import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isOpen } from "@/lib/hours";
import { appUrl } from "@/lib/mail";
import { notifyUsers } from "@/lib/user-notify";
import { contactEmailOf } from "@/lib/credentials-mail";
import { formatMinutes, formatPhone } from "@/lib/format";
import type { Mvno } from "@/lib/types";

type Conv = {
  id: string;
  mvno_id: string;
  ticket_no: number | null;
  assignee_id: string | null;
  subject: string | null;
  last_inbound_at: string | null;
  reminder_wait_since: string | null;
  reminder_level: number;
  contact: { name: string | null; wa_id: string } | null;
};

/**
 * Runs every 5 minutes. For each chat a person owns where the customer's last message has
 * no reply yet: remind the assigned agent after remind_agent_mins, then the tenant's
 * supervisors and admins after remind_supervisor_mins. Working hours only.
 */
export async function runReminders() {
  const db = supabaseAdmin();
  const { data: mvnos } = await db.from("mvnos").select("*").eq("reminders_enabled", true);
  const sent = { agent: 0, supervisor: 0 };

  for (const mvno of (mvnos ?? []) as (Mvno & { remind_agent_mins: number; remind_supervisor_mins: number })[]) {
    if (!isOpen(mvno.business_hours)) continue;
    const { data: convs } = await db
      .from("conversations")
      .select("id, mvno_id, ticket_no, assignee_id, subject, last_inbound_at, reminder_wait_since, reminder_level, contact:contacts(name, wa_id)")
      .eq("mvno_id", mvno.id)
      .eq("status", "open")
      .not("last_inbound_at", "is", null)
      .limit(500);
    const list = (convs ?? []) as unknown as Conv[];
    if (!list.length) continue;

    // Last customer-visible reply (agent or bot) per chat.
    const { data: outs } = await db
      .from("messages")
      .select("conversation_id, created_at")
      .in("conversation_id", list.map((c) => c.id))
      .eq("direction", "out")
      .eq("is_internal", false)
      .gte("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString())
      .order("created_at", { ascending: false });
    const lastOut = new Map<string, string>();
    for (const o of outs ?? []) if (!lastOut.has(o.conversation_id)) lastOut.set(o.conversation_id, o.created_at);

    let supervisors: { id: string; full_name: string; email: string | null }[] | null = null;
    const loadSupervisors = async () => {
      if (supervisors) return supervisors;
      const { data: m } = await db.from("mvno_members").select("user_id, profiles(full_name)").eq("mvno_id", mvno.id).in("role", ["supervisor", "admin"]);
      supervisors = await Promise.all(
        (m ?? []).map(async (x) => {
          const { data: u } = await db.auth.admin.getUserById(x.user_id);
          const banned = !!u.user?.banned_until && new Date(u.user.banned_until) > new Date();
          return banned ? null : { id: x.user_id, full_name: (x.profiles as unknown as { full_name: string })?.full_name ?? "", email: contactEmailOf(u.user) };
        }),
      ).then((r) => r.filter((x): x is { id: string; full_name: string; email: string | null } => !!x));
      return supervisors;
    };

    for (const c of list) {
      const since = c.last_inbound_at!;
      const replied = lastOut.get(c.id);
      if (replied && replied >= since) {
        // Answered: clear any reminder state.
        if (c.reminder_level) await db.from("conversations").update({ reminder_level: 0, reminder_wait_since: null }).eq("id", c.id);
        continue;
      }
      const level = c.reminder_wait_since === since ? c.reminder_level : 0; // a new customer message restarts the clock
      const waited = (Date.now() - new Date(since).getTime()) / 60_000;
      const who = c.contact?.name || (c.contact ? formatPhone(c.contact.wa_id) : "A customer");
      const ref = c.ticket_no ? `#${c.ticket_no}` : "";
      const link = `${appUrl()}/inbox?c=${c.id}`;
      let next = level;

      if (level < 1 && waited >= mvno.remind_agent_mins) {
        if (c.assignee_id) {
          await notify([{ id: c.assignee_id }], {
            mvno,
            conv: c,
            kind: "reminder_agent",
            title: `${who} has been waiting ${formatMinutes(waited)} for your reply`,
            body: `${ref ? `Ticket ${ref}` : "Chat"}${c.subject ? `: ${c.subject}` : ""}`,
            link,
          });
          sent.agent++;
        }
        next = 1; // unassigned chats have no agent to remind: supervisors get them next
      }
      if (next < 2 && waited >= mvno.remind_supervisor_mins) {
        const sups = (await loadSupervisors()) ?? [];
        let agentName = "";
        if (c.assignee_id) {
          const { data: p } = await db.from("profiles").select("full_name").eq("id", c.assignee_id).maybeSingle();
          agentName = p?.full_name ?? "";
        }
        await notify(sups, {
          mvno,
          conv: c,
          kind: "reminder_supervisor",
          title: `${who} has been waiting ${formatMinutes(waited)} with no reply`,
          body: `${ref ? `Ticket ${ref} · ` : ""}${agentName ? `assigned to ${agentName}` : "unassigned, in the queue"}${c.subject ? ` · ${c.subject}` : ""}`,
          link,
        });
        sent.supervisor++;
        next = 2;
      }
      if (next !== c.reminder_level || c.reminder_wait_since !== since) {
        await db.from("conversations").update({ reminder_level: next, reminder_wait_since: since }).eq("id", c.id);
      }
    }
  }
  return sent;
}

/** Reminder alert for each person (in-app + their own email). */
async function notify(
  people: { id: string; email?: string | null }[],
  n: { mvno: Mvno; conv: Conv; kind: string; title: string; body: string; link: string },
) {
  await notifyUsers(
    people.map((p) => p.id),
    {
      mvnoId: n.mvno.id,
      mvnoName: n.mvno.name,
      conversationId: n.conv.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      link: n.link,
      footer: "Sent because a customer is waiting for a reply in Tuongee. Reply in the app to stop these reminders.",
    },
  );
}
