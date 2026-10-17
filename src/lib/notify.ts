import "server-only";
import { appUrl, renderEmail, sendMail } from "@/lib/mail";
import { formatPhone } from "@/lib/format";
import type { Contact, Conversation, Mvno } from "@/lib/types";

// Event → email. Each MVNO chooses recipients in Admin (finance_emails / alert_emails).

type M = Pick<Mvno, "name"> & { finance_emails?: string[]; alert_emails?: string[] };
const ticketUrl = (conv: Pick<Conversation, "id">) => `${appUrl()}/tickets?t=${conv.id}`;

export async function notifyFailedTransaction(
  mvno: M,
  conv: Pick<Conversation, "id" | "ticket_no">,
  contact: Pick<Contact, "name" | "wa_id">,
  t: { type: string; id: string | null },
) {
  const to = mvno.finance_emails?.length ? mvno.finance_emails : (mvno.alert_emails ?? []);
  if (!to.length) return;
  await sendMail(
    to,
    `[${mvno.name}] Failed ${t.type} · ticket #${conv.ticket_no}`,
    renderEmail({
      title: `Failed ${t.type} to verify`,
      intro: `A customer reported a failed ${t.type} on WhatsApp. Please verify in the billing / mobile money system, then resolve the ticket.`,
      rows: [
        ["Ticket", `#${conv.ticket_no}`],
        ["Customer", `${contact.name ?? "Unknown"} (${formatPhone(contact.wa_id)})`],
        ["Transaction type", t.type],
        ["Transaction ID", t.id ?? "Not provided: trace by number and time"],
        ["Reported", new Date().toLocaleString("en-GB", { timeZone: "Africa/Kampala", dateStyle: "medium", timeStyle: "short" }) + " (Kampala)"],
      ],
      cta: { label: "Open ticket", url: ticketUrl(conv) },
    }),
  );
}

export async function notifyWaitingNoAgent(mvno: M, conv: Pick<Conversation, "id" | "ticket_no">, contact: Pick<Contact, "name" | "wa_id">, reason: string) {
  if (!mvno.alert_emails?.length) return;
  await sendMail(
    mvno.alert_emails,
    `[${mvno.name}] Customer waiting, no agent online · #${conv.ticket_no}`,
    renderEmail({
      title: "A customer is waiting and no agent is online",
      intro: "The bot handed this chat to the team, but nobody was online to take it.",
      rows: [
        ["Ticket", `#${conv.ticket_no}`],
        ["Customer", `${contact.name ?? "Unknown"} (${formatPhone(contact.wa_id)})`],
        ["Reason", reason],
      ],
      cta: { label: "Open in Tuvugane", url: ticketUrl(conv) },
    }),
  );
}

export async function notifyDeletionRequest(mvno: M, conv: Pick<Conversation, "id" | "ticket_no">, contact: Pick<Contact, "name" | "wa_id">) {
  if (!mvno.alert_emails?.length) return;
  await sendMail(
    mvno.alert_emails,
    `[${mvno.name}] Data deletion request · #${conv.ticket_no}`,
    renderEmail({
      title: "Customer asked to delete their data",
      intro: "Verify the customer's identity, then use Erase customer data in the inbox (History tab). Respond within the legal time limit.",
      rows: [
        ["Ticket", `#${conv.ticket_no}`],
        ["Customer", `${contact.name ?? "Unknown"} (${formatPhone(contact.wa_id)})`],
      ],
      cta: { label: "Open ticket", url: ticketUrl(conv) },
    }),
  );
}
