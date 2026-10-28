import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { logEvent, sendMessage } from "@/lib/inbox/service";
import { notifyUsers } from "@/lib/user-notify";
import { appUrl } from "@/lib/mail";
import { zonedToUtc } from "@/lib/hours";
import type { Contact, Conversation, Mvno } from "@/lib/types";

const H = 3_600_000;

/**
 * Every 5 minutes: WhatsApp reminders 24h and 2h before confirmed appointments, and a 7:00
 * agenda for staff of general-business tenants.
 */
export async function runAppointmentReminders() {
  const db = supabaseAdmin();
  const now = Date.now();
  const { data } = await db
    .from("appointments")
    .select("*, mvno:mvnos(*), conv:conversations(*), contact:contacts(*)")
    .eq("status", "confirmed")
    .gt("scheduled_at", new Date(now).toISOString())
    .lt("scheduled_at", new Date(now + 25 * H).toISOString())
    .limit(500);
  let sent = 0;

  for (const a of data ?? []) {
    const mvno = a.mvno as Mvno;
    const until = new Date(a.scheduled_at).getTime() - now;
    const justConfirmed = now - new Date(a.updated_at).getTime() < 3 * H; // they were just told
    const which = !a.reminded_soon_at && until <= 2 * H ? "soon" : !a.reminded_day_at && until <= 24 * H && until > 3 * H && !justConfirmed ? "day" : null;
    if (!which) continue;

    const tz = mvno.business_hours?.tz ?? "Africa/Kampala";
    const when = new Date(a.scheduled_at).toLocaleString("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
    const time = new Date(a.scheduled_at).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
    const name = (a.full_name ?? (a.contact as Contact | null)?.name ?? "").split(" ")[0] || "there";
    const conv = a.conv as Conversation | null;
    const contact = a.contact as Contact | null;
    let result = "not sent: no chat";

    if (conv && contact) {
      const open = conv.last_inbound_at && now - new Date(conv.last_inbound_at).getTime() < 24 * H;
      if (open) {
        const text =
          which === "day"
            ? `⏰ Reminder, ${name}: your appointment for *${a.service}* is *tomorrow, ${when}*${a.office ? ` at ${a.office}` : ""}.\n\nPlease bring your documents and arrive 10 minutes early. Reply here if you can't make it.`
            : `⏰ ${name}, your appointment for *${a.service}* is today at *${time}*${a.office ? ` at ${a.office}` : ""}. See you soon!`;
        const m = await sendMessage(mvno, conv, contact, { type: "text", text }, { senderType: "bot" });
        result = m.status === "failed" ? `failed: ${m.error}` : "sent";
      } else if (mvno.reminder_template_name) {
        const m = await sendMessage(
          mvno,
          conv,
          contact,
          { type: "template", name: mvno.reminder_template_name, language: mvno.reminder_template_lang ?? "en", params: [name, a.service, when, a.office ?? "our office"] },
          { senderType: "bot" },
        );
        result = m.status === "failed" ? `failed: ${m.error}` : "sent (template)";
      } else {
        result = "not sent: 24-hour window closed and no reminder template is set";
      }
      await logEvent(conv, `Appointment reminder (${which === "day" ? "day before" : "2 hours before"}): ${result}`);
    }
    await db.from("appointments").update(which === "day" ? { reminded_day_at: new Date().toISOString() } : { reminded_soon_at: new Date().toISOString() }).eq("id", a.id);
    if (result.startsWith("sent")) sent++;
  }

  return { reminders: sent, agendas: await morningAgenda() };
}

/** At 7:00 (tenant time) staff get today's appointments, once per day. */
async function morningAgenda() {
  const db = supabaseAdmin();
  const { data: tenants } = await db.from("mvnos").select("id, name, business_hours").eq("kind", "general");
  let sent = 0;
  for (const m of tenants ?? []) {
    const tz = (m.business_hours as Mvno["business_hours"])?.tz ?? "Africa/Kampala";
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    if (get("hour") !== "07") continue;
    const day = `${get("year")}-${get("month")}-${get("day")}`;
    const key = `agenda:${m.id}:${day}`;
    const { data: done } = await db.from("app_cache").select("key").eq("key", key).maybeSingle();
    if (done) continue;
    await db.from("app_cache").upsert({ key, value: { sent: true } });

    // Today in the tenant's time zone.
    const start = zonedToUtc(day, "00:00", tz);
    const { data: appts } = await db
      .from("appointments")
      .select("scheduled_at, service, full_name, office")
      .eq("mvno_id", m.id)
      .eq("status", "confirmed")
      .gte("scheduled_at", start.toISOString())
      .lt("scheduled_at", new Date(start.getTime() + 24 * H).toISOString())
      .order("scheduled_at");
    if (!appts?.length) continue;
    const lines = appts.map((a) => `${new Date(a.scheduled_at).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" })} · ${a.full_name ?? "Customer"} · ${a.service}${a.office ? ` (${a.office})` : ""}`);
    const { data: staff } = await db.from("mvno_members").select("user_id").eq("mvno_id", m.id);
    await notifyUsers((staff ?? []).map((s) => s.user_id), {
      mvnoId: m.id,
      mvnoName: m.name,
      conversationId: null,
      kind: "agenda",
      title: `Today's appointments: ${appts.length}`,
      body: lines.join("\n"),
      link: `${appUrl()}/appointments`,
      footer: "Your daily appointment agenda from Tuongee.",
    });
    sent++;
  }
  return sent;
}
