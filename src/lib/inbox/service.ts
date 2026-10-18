import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isSimulatedRun, SIMULATOR_TAG } from "./simulation";
import { notifyWaitingNoAgent } from "@/lib/notify";
import { isOpen } from "@/lib/hours";
import { metaMarkReadAndTyping, metaSend, toMetaPayload } from "@/lib/whatsapp/meta";
import { outboundPreview, type InboundMessage, type OutboundMessage, type StatusUpdate } from "@/lib/whatsapp/types";
import type { Contact, Conversation, Message, Mvno, Priority, SenderType } from "@/lib/types";

// ------------------------------------------------------------------ tenant lookup (hot path, cached)

const mvnoCache = new Map<string, { mvno: Mvno; at: number }>();
const TTL = 60_000;

export async function getMvnoByPhoneNumberId(phoneNumberId: string): Promise<Mvno | null> {
  const hit = mvnoCache.get(`pn:${phoneNumberId}`);
  if (hit && Date.now() - hit.at < TTL) return hit.mvno;
  const { data } = await supabaseAdmin().from("mvnos").select("*").eq("wa_phone_number_id", phoneNumberId).maybeSingle();
  if (data) mvnoCache.set(`pn:${phoneNumberId}`, { mvno: data, at: Date.now() });
  return data;
}

export async function getMvno(id: string): Promise<Mvno> {
  const hit = mvnoCache.get(`id:${id}`);
  if (hit && Date.now() - hit.at < TTL) return hit.mvno;
  const { data, error } = await supabaseAdmin().from("mvnos").select("*").eq("id", id).single();
  if (error) throw error;
  mvnoCache.set(`id:${id}`, { mvno: data, at: Date.now() });
  return data;
}

const tokenCache = new Map<string, { token: string | null; at: number }>();

/** Drops cached MVNO config after the WhatsApp connection changes. */
export function forgetMvno(id: string) {
  for (const [k, v] of mvnoCache) if (v.mvno.id === id) mvnoCache.delete(k);
  tokenCache.delete(id);
}

export async function waCredentials(mvno: Mvno) {
  if (!mvno.wa_phone_number_id || mvno.wa_phone_number_id.startsWith("SIM-")) return null;
  let entry = tokenCache.get(mvno.id);
  if (!entry || Date.now() - entry.at > TTL) {
    const { data } = await supabaseAdmin().rpc("get_mvno_wa_token", { p_mvno: mvno.id });
    entry = { token: (data as string | null) ?? process.env.WHATSAPP_ACCESS_TOKEN ?? null, at: Date.now() };
    tokenCache.set(mvno.id, entry);
  }
  return entry.token ? { phoneNumberId: mvno.wa_phone_number_id, token: entry.token } : null;
}

/** True when this MVNO is wired to the local simulator instead of Meta. */
export function isSimulated(mvno: Mvno) {
  return !mvno.wa_phone_number_id || mvno.wa_phone_number_id.startsWith("SIM-");
}

// ------------------------------------------------------------------ contacts & conversations

export async function upsertContact(mvno: Mvno, waId: string, profileName?: string): Promise<Contact> {
  const db = supabaseAdmin();
  const { data: existing } = await db.from("contacts").select("*").eq("mvno_id", mvno.id).eq("wa_id", waId).maybeSingle();
  if (existing) {
    const patch: Partial<Contact> = { last_seen_at: new Date().toISOString() };
    if (!existing.name && profileName) patch.name = profileName;
    await db.from("contacts").update(patch).eq("id", existing.id);
    return { ...existing, ...patch };
  }
  const { data, error } = await db
    .from("contacts")
    .upsert(
      {
        mvno_id: mvno.id,
        wa_id: waId,
        msisdn: waId,
        name: profileName ?? null,
        last_seen_at: new Date().toISOString(),
        tags: isSimulatedRun() ? [SIMULATOR_TAG] : [],
      },
      { onConflict: "mvno_id,wa_id" },
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getActiveConversation(mvno: Mvno, contact: Contact): Promise<Conversation> {
  const db = supabaseAdmin();
  const { data: active } = await db
    .from("conversations")
    .select("*")
    .eq("contact_id", contact.id)
    .neq("status", "resolved")
    .maybeSingle();
  if (active) return active;

  const { data, error } = await db
    .from("conversations")
    .insert({ mvno_id: mvno.id, contact_id: contact.id, status: "bot" })
    .select()
    .single();
  if (error?.code === "23505") {
    // Lost a race with a parallel webhook delivery: read the winner.
    const { data: winner } = await db.from("conversations").select("*").eq("contact_id", contact.id).neq("status", "resolved").single();
    return winner!;
  }
  if (error) throw error;
  return data;
}

/** The most recent resolved conversation still waiting for a CSAT answer (24h window). */
export async function getCsatPending(contact: Contact): Promise<Conversation | null> {
  const { data } = await supabaseAdmin()
    .from("conversations")
    .select("*")
    .eq("contact_id", contact.id)
    .eq("status", "resolved")
    .gte("resolved_at", new Date(Date.now() - 86_400_000).toISOString())
    .contains("bot_state", { awaiting: "csat" })
    .order("resolved_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function updateConversation(id: string, patch: Partial<Conversation>) {
  const { data, error } = await supabaseAdmin().from("conversations").update(patch).eq("id", id).select().single();
  if (error) throw error;
  return data as Conversation;
}

// ------------------------------------------------------------------ messages

/** Stores an inbound message. Returns null when it's a duplicate webhook delivery. */
export async function recordInbound(conv: Conversation, msg: InboundMessage): Promise<Message | null> {
  const body =
    msg.text ??
    (msg.type === "location"
      ? `📍 ${msg.location?.name ?? msg.location?.address ?? `${msg.location?.lat.toFixed(4)}, ${msg.location?.lng.toFixed(4)}`}`
      : `[${msg.type}]`);
  const { data, error } = await supabaseAdmin()
    .from("messages")
    .insert({
      conversation_id: conv.id,
      mvno_id: conv.mvno_id,
      direction: "in",
      sender_type: "contact",
      type: msg.type,
      body,
      payload: { replyId: msg.replyId, location: msg.location, mediaId: msg.mediaId, filename: msg.filename, mime: msg.mime, rawType: msg.rawType, raw: msg.raw },
      wa_message_id: msg.waMessageId,
      status: "received",
      created_at: msg.timestamp.toISOString(),
    })
    .select()
    .single();
  if (error?.code === "23505") return null;
  if (error) throw error;
  return data;
}

export async function markReadAndTyping(mvno: Mvno, waMessageId: string) {
  if (isSimulatedRun()) return;
  const creds = await waCredentials(mvno);
  if (creds) await metaMarkReadAndTyping(creds.phoneNumberId, creds.token, waMessageId);
}

interface SendOpts {
  senderType: SenderType;
  senderId?: string | null;
}

/** Persists an outbound message, sends it to WhatsApp, and tracks delivery status. */
export async function sendMessage(
  mvno: Mvno,
  conv: Pick<Conversation, "id" | "mvno_id">,
  contact: Pick<Contact, "wa_id"> & { tags?: string[] },
  out: OutboundMessage,
  opts: SendOpts,
): Promise<Message> {
  const db = supabaseAdmin();
  const { data: row, error } = await db
    .from("messages")
    .insert({
      conversation_id: conv.id,
      mvno_id: conv.mvno_id,
      direction: "out",
      sender_type: opts.senderType,
      sender_id: opts.senderId ?? null,
      type: out.type === "media" ? out.kind : out.type,
      body: outboundPreview(out),
      // Media rides the same viewer as customer media (/api/media/:id reads mediaPath).
      payload:
        out.type === "media"
          ? { out, mediaId: "agent-upload", mediaPath: out.path, mime: out.mime, filename: out.filename, size: out.size }
          : { out },
      status: "queued",
    })
    .select()
    .single();
  if (error) throw error;

  // Simulator chats never reach WhatsApp, even on MVNOs with a live number.
  const simulated = isSimulatedRun() || !!contact.tags?.includes(SIMULATOR_TAG);
  const creds = simulated ? null : await waCredentials(mvno);
  if (!creds) {
    // Simulator: emulate Meta's sent → delivered → read receipts.
    const waId = `sim.${row.id}`;
    await db.from("messages").update({ status: "sent", wa_message_id: waId }).eq("id", row.id);
    setTimeout(() => void db.from("messages").update({ status: "delivered" }).eq("id", row.id), 400);
    setTimeout(() => void db.from("messages").update({ status: "read" }).eq("id", row.id), 1500);
    return { ...row, status: "sent", wa_message_id: waId };
  }

  try {
    let toSend = out;
    if (out.type === "media") {
      // Meta downloads the file itself from a short-lived signed link.
      const { data: signed, error: signErr } = await db.storage.from("wa-media").createSignedUrl(out.path, 3600);
      if (signErr || !signed) throw signErr ?? new Error("Could not prepare the file");
      toSend = { ...out, link: signed.signedUrl };
    }
    const waMessageId = await metaSend(creds.phoneNumberId, creds.token, toMetaPayload(contact.wa_id, toSend));
    await db.from("messages").update({ status: "sent", wa_message_id: waMessageId }).eq("id", row.id);
    return { ...row, status: "sent", wa_message_id: waMessageId };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await db.from("messages").update({ status: "failed", error: err }).eq("id", row.id);
    return { ...row, status: "failed", error: err };
  }
}

/** Internal timeline entry (assignments, handoffs…). Never sent to WhatsApp. */
export async function logEvent(conv: Pick<Conversation, "id" | "mvno_id">, text: string, actorId?: string | null) {
  await supabaseAdmin().from("messages").insert({
    conversation_id: conv.id,
    mvno_id: conv.mvno_id,
    direction: "out",
    sender_type: "system",
    sender_id: actorId ?? null,
    type: "event",
    body: text,
    is_internal: true,
    status: "sent",
  });
}

/** Internal note from the bot to the team (e.g. instructions for finance). Never sent to WhatsApp. */
export async function addBotNote(conv: Pick<Conversation, "id" | "mvno_id">, text: string) {
  await supabaseAdmin().from("messages").insert({
    conversation_id: conv.id,
    mvno_id: conv.mvno_id,
    direction: "out",
    sender_type: "system",
    type: "note",
    body: text,
    is_internal: true,
    status: "sent",
  });
}

const statusRank ={ queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 } as const;

export async function applyStatus(update: StatusUpdate) {
  const db = supabaseAdmin();
  const { data } = await db.from("messages").select("id,status").eq("wa_message_id", update.waMessageId).maybeSingle();
  if (!data) return;
  // Webhooks can arrive out of order: never move a receipt backwards.
  if (statusRank[update.status] <= statusRank[data.status as keyof typeof statusRank] && update.status !== "failed") return;
  await db.from("messages").update({ status: update.status, error: update.error ?? null }).eq("id", data.id);
}

export async function recentMessages(conversationId: string, limit = 30): Promise<Message[]> {
  const { data } = await supabaseAdmin()
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).reverse();
}

// ------------------------------------------------------------------ routing

/** Least-loaded online agent with spare capacity, or null. */
export async function pickAgent(mvnoId: string): Promise<{ id: string; full_name: string } | null> {
  const db = supabaseAdmin();
  const { data: members } = await db
    .from("mvno_members")
    .select("user_id, max_concurrent, profiles!inner(id, full_name, status)")
    .eq("mvno_id", mvnoId)
    .eq("role", "agent") // supervisors/admins take chats only by choice, never by auto-assignment
    .eq("profiles.status", "online")
    .gte("profiles.last_seen_at", new Date(Date.now() - 3 * 60_000).toISOString()); // live heartbeat
  if (!members?.length) return null;

  const ids = members.map((m) => m.user_id);
  const { data: open } = await db
    .from("conversations")
    .select("assignee_id")
    .in("assignee_id", ids)
    .in("status", ["open", "pending"]);
  const load = new Map<string, number>();
  for (const c of open ?? []) load.set(c.assignee_id!, (load.get(c.assignee_id!) ?? 0) + 1);

  const ranked = members
    .map((m) => ({ m, load: load.get(m.user_id) ?? 0 }))
    .filter(({ m, load }) => load < m.max_concurrent)
    .sort((a, b) => a.load - b.load);
  const best = ranked[0]?.m;
  if (!best) return null;
  const p = best.profiles as unknown as { id: string; full_name: string };
  return { id: p.id, full_name: p.full_name };
}

/** Any agent on this MVNO's team online with a live heartbeat (even if at full capacity). */
export async function anyAgentOnline(mvnoId: string) {
  const { count } = await supabaseAdmin()
    .from("mvno_members")
    .select("user_id, profiles!inner(status, last_seen_at)", { count: "exact", head: true })
    .eq("mvno_id", mvnoId)
    .eq("role", "agent")
    .eq("profiles.status", "online")
    .gte("profiles.last_seen_at", new Date(Date.now() - 3 * 60_000).toISOString());
  return (count ?? 0) > 0;
}

export async function queuePosition(conv: Conversation) {
  const { count } = await supabaseAdmin()
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("mvno_id", conv.mvno_id)
    .eq("status", "open")
    .is("assignee_id", null)
    .lt("handoff_at", conv.handoff_at ?? new Date().toISOString());
  return (count ?? 0) + 1;
}

export interface HandoffInput {
  reason: string;
  priority?: Priority;
  category?: string;
}

/** Moves a conversation from the bot to the human queue and auto-assigns if possible. */
export async function handoff(mvno: Mvno, conv: Conversation, contact: Contact, input: HandoffInput) {
  const now = new Date();
  let updated = await updateConversation(conv.id, {
    status: "open",
    handoff_at: now.toISOString(),
    sla_due_at: new Date(now.getTime() + mvno.sla_first_response_mins * 60_000).toISOString(),
    priority: input.priority ?? conv.priority,
    category: input.category ?? conv.category,
    bot_state: {},
  });
  await logEvent(updated, `Handed to team: ${input.reason}`);

  const agent = await pickAgent(mvno.id);
  if (agent) {
    updated = await updateConversation(conv.id, { assignee_id: agent.id });
    await logEvent(updated, `Auto-assigned to ${agent.full_name}`);
    await sendMessage(
      mvno,
      updated,
      contact,
      { type: "text", text: `I've connected you with ${agent.full_name.split(" ")[0]} from our team, they'll reply here shortly. 🙌` },
      { senderType: "bot" },
    );
  } else if (!isOpen(mvno.business_hours) || !(await anyAgentOnline(mvno.id))) {
    // After hours, or nobody signed in: log it as a follow-up instead of promising a wait time.
    const afterHours = !isOpen(mvno.business_hours);
    updated = await updateConversation(conv.id, { followup_reason: afterHours ? "after_hours" : "no_agents" });
    await logEvent(updated, afterHours ? "Arrived after hours: waiting for follow-up" : "No agents online: waiting for follow-up");
    const ref = updated.ticket_no ? ` (ticket #${updated.ticket_no})` : "";
    await sendMessage(
      mvno,
      updated,
      contact,
      {
        type: "text",
        // Never say the team is offline: just confirm the request is logged and will be followed up.
        text: `I've logged your request${ref} with everything you've shared. An agent will follow up with you.`,
      },
      { senderType: "bot" },
    );
    if (!contact.tags?.includes(SIMULATOR_TAG)) await notifyWaitingNoAgent(mvno, updated, contact, input.reason);
  } else {
    const pos = await queuePosition(updated);
    const wait = Math.max(mvno.sla_first_response_mins, pos * 2);
    await sendMessage(
      mvno,
      updated,
      contact,
      {
        type: "text",
        text: `I've passed this to our support team. You're number ${pos} in the queue, expected wait is about ${wait} min. You can keep typing here and we'll see everything.`,
      },
      { senderType: "bot" },
    );
    // Nobody online to take it: email the MVNO's alert list (no-op if none configured).
    if (!contact.tags?.includes(SIMULATOR_TAG)) await notifyWaitingNoAgent(mvno, updated, contact, input.reason);
  }
  return updated;
}

export async function resolveConversation(
  mvno: Mvno,
  conv: Conversation,
  contact: Contact,
  actorId: string | null,
  askCsat = true,
  note = "Conversation resolved",
) {
  // Rate limit the survey per customer: at most once every csat_every_days (default 14).
  if (askCsat) {
    const every = mvno.csat_every_days ?? 14;
    const { data: c } = await supabaseAdmin().from("contacts").select("csat_asked_at").eq("id", contact.id).maybeSingle();
    const last = c?.csat_asked_at ? new Date(c.csat_asked_at).getTime() : 0;
    if (every > 0 && Date.now() - last < every * 86_400_000) askCsat = false;
  }
  const updated = await updateConversation(conv.id, {
    status: "resolved",
    resolved_at: new Date().toISOString(),
    unread_count: 0,
    bot_state: askCsat ? { awaiting: "csat" } : {},
  });
  await logEvent(updated, note, actorId);
  if (askCsat) {
    await supabaseAdmin().from("contacts").update({ csat_asked_at: new Date().toISOString() }).eq("id", contact.id);
    await sendMessage(
      mvno,
      updated,
      contact,
      {
        type: "buttons",
        body: `Thanks for chatting with ${mvno.name}! How did we do today?`,
        buttons: [
          { id: "csat:5", title: "😀 Great" },
          { id: "csat:3", title: "😐 Okay" },
          { id: "csat:1", title: "😞 Poor" },
        ],
      },
      { senderType: "bot" },
    );
  }
  return updated;
}
