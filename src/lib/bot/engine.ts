import "server-only";
import type { InboundMessage } from "@/lib/whatsapp/types";
import type { Mvno, Priority } from "@/lib/types";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  addBotNote,
  getActiveConversation,
  getCsatPending,
  handoff,
  logEvent,
  markReadAndTyping,
  previousChat,
  recentlyClosed,
  recentMessages,
  recordInbound,
  resolveConversation,
  updateConversation,
  upsertContact,
} from "@/lib/inbox/service";
import { notifyDeletionRequest, notifyFailedTransaction } from "@/lib/notify";
import * as F from "./flows";
import { storeInboundMedia } from "@/lib/whatsapp/media";
import { allow, LIMITS } from "@/lib/security";
import { runAgent, triage } from "./ai";
import { closingOf } from "@/lib/format";
import { mediaForAi } from "@/lib/whatsapp/media";
import type { MenuAction } from "@/lib/menu";
import { notifyUsers } from "@/lib/user-notify";
import { appUrl, renderEmail, sendMail } from "@/lib/mail";

/** Entry point for every inbound WhatsApp message, from Meta or the simulator. */
export async function processInbound(mvno: Mvno, msg: InboundMessage) {
  let contact = await upsertContact(mvno, msg.from, msg.profileName);

  if (msg.type === "location" && msg.location) {
    const last_location = { lat: msg.location.lat, lng: msg.location.lng, at: new Date().toISOString() };
    await supabaseAdmin().from("contacts").update({ last_location }).eq("id", contact.id);
    contact = { ...contact, last_location };
  }

  // CSAT answer for a conversation that was just resolved.
  // Campaign opt-out / opt-in (typed keyword only). Support chats keep working either way.
  const word = msg.replyId ? "" : (msg.text?.trim().toLowerCase() ?? "");
  const optOut = /^(stop|unsubscribe|stop promotions)$/.test(word);
  const optIn = !!contact.opted_out_at && /^(start|subscribe)$/.test(word);
  if (optOut || optIn) {
    const conv = await getActiveConversation(mvno, contact);
    if (!(await recordInbound(conv, msg))) return;
    await supabaseAdmin().from("contacts").update({ opted_out_at: optOut ? new Date().toISOString() : null }).eq("id", contact.id);
    await F.say(
      { mvno, conv, contact },
      {
        type: "text",
        text: optOut
          ? `Done ✅ You won't receive promotional messages from ${mvno.name}. You can still chat with us for help anytime. Reply START to get offers again.`
          : `Welcome back 🎉 You'll receive ${mvno.name} offers again. Reply STOP anytime to opt out.`,
      },
    );
    return;
  }

  // Accepts the button tap or the same answer typed ("great", "ok", "poor"...).
  const typed = msg.text?.trim().toLowerCase().replace(/[^\p{L}\s]/gu, "").trim() ?? "";
  const typedScore = /^(great|excellent|good|very good)$/.test(typed) ? 5 : /^(okay|ok|fine|average)$/.test(typed) ? 3 : /^(poor|bad|terrible)$/.test(typed) ? 1 : 0;
  if (msg.replyId?.startsWith("csat:") || (!msg.replyId && typedScore)) {
    const pending = await getCsatPending(contact);
    // A stale rating tap (survey expired or already answered) must never restart the bot.
    if (!pending && msg.replyId?.startsWith("csat:")) return;
    if (pending) {
      const score = msg.replyId?.startsWith("csat:") ? Number(msg.replyId.split(":")[1]) : typedScore;
      await recordInbound(pending, msg);
      const conv = await updateConversation(pending.id, { csat_score: score, bot_state: {}, unread_count: 0 });
      await F.say(
        { mvno, conv, contact },
        {
          type: "text",
          text: score >= 4 ? "Thank you for your feedback! 💜" : "Thanks for telling us. We'll use this to do better. 🙏",
        },
      );
      return;
    }
  }

  // "My pleasure 🙏", "thanks", "ok 👍" just after a chat closed: file it in that chat quietly.
  // It must not reopen the ticket, start a new bot chat, or get a reply.
  if (!msg.replyId && msg.type === "text" && isCourtesy(msg.text ?? "")) {
    const closed = await recentlyClosed(contact, 6 * 3_600_000);
    if (closed) {
      if (await recordInbound(closed, msg)) await updateConversation(closed.id, { unread_count: 0 });
      return;
    }
  }

  const conv = await getActiveConversation(mvno, contact);
  const stored = await recordInbound(conv, msg);
  if (!stored) return; // duplicate webhook delivery
  void markReadAndTyping(mvno, msg.waMessageId);

  // Delivered late (e.g. held by Meta while the number moved), or a reaction: keep it, don't reply.
  // WhatsApp rejects free-form replies more than 24h after the customer's message anyway.
  const stale = Date.now() - msg.timestamp.getTime() > 23 * 3_600_000;
  if (stale || msg.silent) {
    if (stale) await logEvent(conv, "Message arrived late (sent " + msg.timestamp.toLocaleString("en-GB", { timeZone: "Africa/Kampala" }) + "): bot did not reply");
    if (msg.mediaId) await storeInboundMedia(stored).catch((e) => console.error("media", e));
    return;
  }

  // Save photos / voice notes / documents in parallel with the reply, so media never slows the bot.
  const mediaJob = msg.mediaId ? storeInboundMedia(stored).catch((e) => (console.error("media", e), null)) : null;
  // The bot reads photos and PDFs (e.g. a transaction screenshot): wait for the file first.
  const readable = msg.type === "image" || (msg.type === "document" && msg.mime === "application/pdf");
  if (readable && mediaJob && conv.status === "bot") msg.mediaPath = (await mediaJob) ?? undefined;
  try {
    const ctx: F.FlowCtx = { mvno, conv, contact };
    // Typed keyword only (never a button tap); "data" alone means data bundles, not privacy.
    if (!msg.replyId && /^(privacy|my data|delete my data|faragha)$/i.test(msg.text?.trim() ?? "") && conv.status === "bot") {
      await F.showPrivacy(ctx);
    } else {
      await respond(ctx, msg);
    }
    // Data-protection notice: once per customer, after their first reply.
    if (mvno.privacy_notice && !contact.privacy_notice_sent_at) {
      await F.say(ctx, { type: "text", text: `ℹ️ ${mvno.privacy_notice}` });
      await supabaseAdmin().from("contacts").update({ privacy_notice_sent_at: new Date().toISOString() }).eq("id", contact.id);
    }
  } finally {
    await mediaJob;
  }
}

async function respond(ctx: F.FlowCtx, msg: InboundMessage) {
  const { conv } = ctx;
  // Humans own the conversation: the bot stays quiet.
  if (conv.status === "open" || conv.status === "pending") {
    if (conv.status === "pending") {
      await updateConversation(conv.id, { status: "open" });
      await logEvent(conv, "Customer replied, reopened");
    }
    if (/^(menu|bot)$/i.test(msg.text?.trim() ?? "")) {
      await F.say(ctx, { type: "text", text: "You're chatting with our team right now. They'll reply here shortly 🙂" });
    }
    return;
  }

  try {
    await runBot(ctx, msg);
  } catch (e) {
    console.error("bot error", e);
    await doHandoff(ctx, { reason: "Bot error while handling message", priority: "normal" });
  }
}

async function doHandoff(ctx: F.FlowCtx, input: { reason: string; priority?: Priority; category?: string; quiet?: boolean }) {
  const conv = await handoff(ctx.mvno, ctx.conv, ctx.contact, input);
  ctx.conv = conv;
  // Triage after the customer has been acknowledged, so it never delays the reply.
  const history = await recentMessages(conv.id, 40);
  const t = await triage(history).catch(() => null);
  if (t) {
    await updateConversation(conv.id, {
      subject: t.subject,
      ai_summary: t.summary,
      sentiment: t.sentiment,
      category: input.category ?? t.category,
      priority: rankMax(input.priority ?? conv.priority, t.priority),
    });
  } else if (!conv.subject) {
    await updateConversation(conv.id, { subject: input.reason.slice(0, 80) });
  }
}

const order: Priority[] = ["low", "normal", "high", "urgent"];
const rankMax = (a: Priority, b: Priority) => (order.indexOf(a) >= order.indexOf(b) ? a : b);

async function runBot(ctx: F.FlowCtx, msg: InboundMessage) {
  const id = msg.replyId ?? "";
  const text = (msg.text ?? "").trim();
  const state = ctx.conv.bot_state ?? {};

  // ---------------------------------------------------------- button / list replies
  if (id) {
    const [kind, a, b] = id.split(":");
    switch (kind) {
      case "menu":
        return menuAction(ctx, a);
      case "bcat": // bcat:<category|all>[:<page>]
        return F.showBundleCategory(ctx, a === "all" ? null : (a as "data" | "voice" | "combo"), Number(b) || 0);
      case "bundle":
        return F.confirmBundle(ctx, a);
      case "esim":
        return F.showEsim(ctx);
      case "buy":
        return a === "self"
          ? F.executePurchase(ctx, { msisdn: ctx.contact.msisdn ?? ctx.contact.wa_id, bundleId: b })
          : F.askOtherNumber(ctx, { bundleId: b });
      case "airtime":
        if (a === "custom") {
          await updateConversation(ctx.conv.id, { bot_state: { flow: "airtime", awaiting: "amount" } });
          return F.say(ctx, { type: "text", text: "Type the amount in UGX, e.g. 3000" });
        }
        return F.confirmAirtime(ctx, Number(a));
      case "air":
        return a === "self"
          ? F.executePurchase(ctx, { msisdn: ctx.contact.msisdn ?? ctx.contact.wa_id, amount: Number(b) })
          : F.askOtherNumber(ctx, { amount: Number(b) });
      case "deliver":
        return ctx.mvno.sim_delivery ? F.askLocation(ctx, "delivery", { item: a }) : F.showEsim(ctx);
      case "privacy":
        // Deletion requests are handled by a person (identity check, legal holds), then erased from the dashboard.
        await doHandoff(ctx, { reason: "Customer requested deletion of their data (privacy request)", priority: "high", category: "account" });
        return notifyDeletionRequest(ctx.mvno, ctx.conv, ctx.contact);
      case "ftype":
        return F.askTxnId(ctx, (a in F.TXN_TYPES ? a : "other") as F.TxnType);
      case "near":
        return findNearest(ctx, a === "store" || a === "agent" ? a : undefined);
      case "gm": {
        // General tenant menu. "answer" items fall through to the AI with the row title as the question.
        const item = F.generalMenuItem(ctx.mvno, a);
        if (!item) return F.showMenu(ctx);
        if (item.action === "answer") break;
        return generalAction(ctx, item.action, item.title);
      }
      case "appt": {
        const item = a === "other" ? null : F.generalMenuItem(ctx.mvno, a);
        if (!item) {
          await updateConversation(ctx.conv.id, { bot_state: { flow: "appt", awaiting: "appt_service", data: {} } });
          return F.say(ctx, { type: "text", text: "Which service is the appointment for? Type it in a few words." });
        }
        return F.askAppointmentDates(ctx, item.title);
      }
      case "lost": // lost:this | lost:block:<both|line|none>
        if (a === "this") return F.askLostBlock(ctx, ctx.contact.wa_id);
        if (a === "block" && typeof state.data?.msisdn === "string") return finishLostLine(ctx, state.data.msisdn, b === "both" || b === "line" || b === "none" ? b : "both");
        return F.startLostLine(ctx);
    }
  }

  // ---------------------------------------------------------- awaited inputs
  if (state.awaiting === "txn" && text && !isEscape(text)) {
    const type = ((state.data?.txnType as string) in F.TXN_TYPES ? state.data?.txnType : "other") as F.TxnType;
    return finishFailedTxn(ctx, /^(skip|no|sina|sirina)$/i.test(text) ? null : text.slice(0, 120), type);
  }
  if (state.flow === "appt" && text && !isEscape(text)) {
    const d = (state.data ?? {}) as { service?: string; dates?: string };
    if (state.awaiting === "appt_service") return F.askAppointmentDates(ctx, text.slice(0, 100));
    if (state.awaiting === "appt_dates" && d.service) return F.askAppointmentName(ctx, d.service, text.slice(0, 200));
    if (state.awaiting === "appt_name" && d.service && d.dates) return finishAppointment(ctx, d.service, d.dates, text.slice(0, 120));
  }
  if (state.awaiting === "lost_number" && text && !isEscape(text)) {
    const msisdn = F.normalizeMsisdn(text);
    if (!msisdn) return F.say(ctx, { type: "text", text: "That number doesn't look right. Type it like 0724 123 456, or type *menu* to cancel." });
    return F.askLostBlock(ctx, msisdn);
  }
  if (state.awaiting === "lost_block" && text && !isEscape(text) && typeof state.data?.msisdn === "string") {
    const t = text.toLowerCase();
    if (/^(yes|y|block|ok|yeah|please)\b/.test(t)) return finishLostLine(ctx, state.data.msisdn, "both");
    if (/^(no|n|don'?t|nope)\b/.test(t)) return finishLostLine(ctx, state.data.msisdn, "none");
    return F.askLostBlock(ctx, state.data.msisdn);
  }
  if (state.awaiting === "location") {
    if (msg.location) {
      if (state.flow === "outlets") return F.showOutlets(ctx, msg.location, state.data?.kind as F.OutletKind | undefined);
      if (state.flow === "delivery") {
        return F.createDelivery(ctx, (state.data?.item as "sim" | "esim") ?? "sim", {
          lat: msg.location.lat,
          lng: msg.location.lng,
          address: msg.location.address ?? msg.location.name,
        });
      }
    }
    if (state.flow === "outlets" && text && !isEscape(text)) return F.showOutletsByArea(ctx, text, state.data?.kind as F.OutletKind | undefined);
    if (state.flow === "delivery" && text.length > 8 && !isEscape(text)) {
      return F.createDelivery(ctx, (state.data?.item as "sim" | "esim") ?? "sim", { address: text });
    }
  }
  if (state.awaiting === "msisdn" && text && !isEscape(text)) {
    const msisdn = F.normalizeMsisdn(text);
    if (!msisdn) return F.say(ctx, { type: "text", text: "That number doesn't look right. Try e.g. 0724 123 456, or type 'menu'." });
    return F.executePurchase(ctx, {
      msisdn,
      bundleId: state.data?.bundleId as string | undefined,
      amount: state.data?.amount as number | undefined,
    });
  }
  if (state.awaiting === "amount" && text && !isEscape(text)) {
    const amount = Number(text.replace(/[^\d.]/g, ""));
    if (!amount || amount < 500 || amount > 500_000) return F.say(ctx, { type: "text", text: "Enter an amount between UGX 500 and 500,000." });
    return F.confirmAirtime(ctx, Math.round(amount));
  }

  // Shared a location out of context: treat it as "find agents near me".
  if (msg.location) return F.showOutlets(ctx, msg.location, "agent");

  // ---------------------------------------------------------- free text
  if (isEscape(text)) return F.showMenu(ctx);

  let history = await recentMessages(ctx.conv.id, 20);
  // New chat: also show the AI the customer's previous chat, so it continues the story
  // instead of re-asking their town, number or issue.
  if (history.length < 6) history = [...(await previousChat(ctx.contact.id, ctx.conv.id)), ...history];
  // A plain greeting ("Hi", "Asalam alaikum") always gets the MVNO's configured greeting + menu,
  // never an improvised AI reply. Greetings with a question attached still go to the AI.
  // Only when the message is JUST a greeting: "Hello PaxTel, I'd like to enquire about APN…" goes to the AI.
  if (isGreeting(text) && isJustGreeting(text)) return F.showMenu(ctx, greetingReply(ctx.mvno.greeting, text));

  // View-once media, polls, events, edits...: WhatsApp doesn't pass these to businesses.
  if (msg.type === "unknown" && msg.rawType !== "contacts") {
    return F.say(ctx, {
      type: "buttons",
      body: "Sorry, I couldn't open that message (WhatsApp doesn't share view-once photos, polls or similar with businesses). Please send it again as a normal photo, document or text.",
      buttons: [
        { id: "menu:human", title: "Talk to an agent" },
        { id: "menu:main", title: "Main menu" },
      ],
    });
  }

  const attachment = msg.mediaPath ? await mediaForAi(msg.mediaPath, msg.mime ?? (msg.type === "image" ? "image/jpeg" : "application/pdf")) : null;
  if (!text && !attachment) {
    return F.say(ctx, {
      type: "buttons",
      body: "Thanks! I can't open voice notes or videos, but our team can.",
      buttons: [
        { id: "menu:human", title: "Talk to an agent" },
        { id: "menu:main", title: "Main menu" },
      ],
    });
  }

  // Cap AI replies per customer so one chat can't run up model costs; menus still work past the cap.
  if (!(await allow(`ai:bot:${ctx.mvno.id}:${ctx.contact.wa_id}`, LIMITS.botAiPerCustomer))) return keywordFallback(ctx, text);
  const turn = await runAgent(ctx.mvno, ctx.contact, history, attachment ? [attachment] : []).catch((e) => {
    console.error("claude error", e);
    return null;
  });
  if (!turn) return keywordFallback(ctx, text);

  const cited = turn.tools.some((t) => ["answer_from_kb", "handoff_to_agent", "resolve_conversation", "request_appointment", "emergency_help", "show_offices", "show_main_menu"].includes(t.name));
  if (ctx.mvno.strict_sources && turn.text && !cited && turn.text.length > 220) {
    // Sourced answers only: a long factual-looking reply with no cited article is not sent.
    await F.say(ctx, {
      type: "buttons",
      body: "I can't confirm that from our official information. An officer can help you with it.",
      buttons: [
        { id: "menu:human", title: "Talk to an officer" },
        { id: "menu:main", title: "Main menu" },
      ],
    });
  } else if (turn.text) await F.say(ctx, { type: "text", text: turn.text });
  for (const t of turn.tools) await runTool(ctx, t.name, t.input);
  if (!turn.text && !turn.tools.length) await F.showMenu(ctx);

  const turns = (ctx.conv.bot_state?.ai_turns ?? 0) + 1;
  // Loop guard: if the AI has gone back and forth a lot without resolving, offer a human.
  if (turns >= 6 && !turn.tools.some((t) => t.name === "handoff_to_agent")) {
    await F.say(ctx, {
      type: "buttons",
      body: "Would you like me to bring in someone from our team?",
      buttons: [
        { id: "menu:human", title: "Yes, an agent" },
        { id: "menu:main", title: "No, main menu" },
      ],
    });
  }
  if (ctx.conv.status === "bot") {
    await updateConversation(ctx.conv.id, { bot_state: { ...ctx.conv.bot_state, ai_turns: turns } }).catch(() => undefined);
  }
}

async function runTool(ctx: F.FlowCtx, name: string, input: Record<string, unknown>) {
  switch (name) {
    case "show_main_menu":
      return F.showMenu(ctx);
    case "check_balance":
      return F.showBalance(ctx);
    case "check_line_status":
      return F.showLineStatus(ctx);
    case "show_bundles": {
      const cat = input.category as string | undefined;
      return cat === "data" || cat === "voice" || cat === "combo" ? F.showBundleCategory(ctx, cat) : F.showBundles(ctx);
    }
    case "show_esim_steps":
      return F.showEsim(ctx);
    case "start_bundle_purchase": {
      const code = String(input.bundle_code ?? "").toUpperCase();
      const b = (await F.listBundles(ctx.mvno.id)).find((x) => x.code.toUpperCase() === code);
      return b ? F.confirmBundle(ctx, b.id) : F.showBundles(ctx);
    }
    case "start_airtime_purchase": {
      const amount = Number(input.amount ?? 0);
      return amount >= 500 ? F.confirmAirtime(ctx, amount) : F.showAirtime(ctx);
    }
    case "find_nearest_outlets": {
      const p = input.purpose as string | undefined;
      const kind = p === "agent" ? "agent" : p === "service_centre" ? "store" : undefined;
      const area = String(input.area ?? "").trim();
      return area ? F.showOutletsByArea(ctx, area.slice(0, 100), kind) : findNearest(ctx, kind);
    }
    case "report_failed_transaction": {
      const id = String(input.transaction_id ?? "").trim();
      const t = String(input.transaction_type ?? "unknown");
      const type = (t in F.TXN_TYPES ? t : null) as F.TxnType | null;
      if (id) return finishFailedTxn(ctx, id.slice(0, 120), type ?? "other");
      return type ? F.askTxnId(ctx, type) : F.startFailedTxn(ctx); // ask what failed, then the ID
    }
    case "resolve_conversation":
      return botResolve(ctx, String(input.summary ?? ""), String(input.category ?? "inquiry"));
    case "request_appointment": {
      const service = String(input.service ?? "").trim();
      return service ? F.askAppointmentDates(ctx, service.slice(0, 100)) : F.askAppointmentService(ctx);
    }
    case "emergency_help":
      return emergencyHelp(ctx, String(input.summary ?? ""));
    case "show_offices":
      return generalAction(ctx, "location", "Office hours & location");
    case "answer_from_kb":
      return answerFromKb(ctx, String(input.article_id ?? ""), String(input.answer ?? ""));
    case "sim_replacement_help":
      return F.showSimLoss(ctx);
    case "report_lost_or_stolen": {
      const msisdn = F.normalizeMsisdn(String(input.number ?? ""));
      const block = input.block as string | undefined;
      if (msisdn && (block === "both" || block === "line" || block === "none")) return finishLostLine(ctx, msisdn, block);
      return msisdn ? F.askLostBlock(ctx, msisdn) : F.startLostLine(ctx);
    }
    case "show_promos":
      return F.showPromos(ctx);
    case "track_or_order_delivery":
      return ctx.mvno.sim_delivery ? F.showDeliveries(ctx) : F.showEsim(ctx);
    case "handoff_to_agent":
      return doHandoff(ctx, {
        reason: String(input.reason ?? "Customer needs help"),
        priority: (input.priority as Priority) ?? "normal",
        category: input.category as string | undefined,
      });
  }
}

async function menuAction(ctx: F.FlowCtx, action: string) {
  switch (action) {
    case "bundles":
      return F.showBundles(ctx);
    case "airtime":
      return F.showAirtime(ctx);
    case "balance":
      return F.showBalance(ctx);
    case "outlets":
      return findNearest(ctx);
    case "promos":
      return F.showPromos(ctx);
    case "simloss":
      return F.showSimLoss(ctx);
    case "failed":
      return F.startFailedTxn(ctx);
    case "delivery":
      return ctx.mvno.sim_delivery ? F.showDeliveries(ctx) : F.showEsim(ctx);
    case "esim":
      return F.showEsim(ctx);
    case "line":
      return F.showLineStatus(ctx);
    case "wallet":
      return F.showWallet(ctx);
    case "human":
      return doHandoff(ctx, { reason: "Customer asked to talk to an agent", priority: "normal" });
    default:
      return F.showMenu(ctx);
  }
}

/** Always asks for a fresh location pin, then recommends the nearest outlets of that kind. */
function findNearest(ctx: F.FlowCtx, kind?: F.OutletKind) {
  return F.askLocation(ctx, "outlets", { kind });
}

/** Failed/deducted transaction: hand to the team with a finance checklist as an internal note. */
async function finishFailedTxn(ctx: F.FlowCtx, txnId: string | null, type: F.TxnType = "other") {
  const label = F.TXN_TYPES[type];
  await F.say(ctx, {
    type: "text",
    text: txnId
      ? `Thank you 🙏 I've raised a ticket for your failed ${label} (*${txnId}*) with our finance team. We'll update you here as soon as it's checked.`
      : `No problem. I've raised a ticket for your failed ${label}; our finance team will trace it using your number and the time of the transaction. We'll update you here.`,
  });
  await doHandoff(ctx, {
    reason: `Failed ${label}${txnId ? `, ref ${txnId}` : ", no ID given"}`,
    priority: "high",
    category: "payment",
  });
  await updateConversation(ctx.conv.id, { subject: `Failed ${label}${txnId ? ` · ${txnId.slice(0, 40)}` : ""}` }).catch(() => undefined);
  await addBotNote(
    ctx.conv,
    `🔎 Finance check needed\n` +
      `Type: ${label}\n` +
      `Transaction ID / details: ${txnId ?? "not provided: trace by number +" + ctx.contact.wa_id + " and time"}\n` +
      `1. Verify in the billing/${ctx.mvno.wallet_name} system whether the transaction succeeded.\n` +
      `2. If it succeeded, confirm the value was credited to the customer; if it failed, reverse it.\n` +
      `3. Reply to the customer with the outcome, then resolve this ticket.`,
  );
  await notifyFailedTransaction(ctx.mvno, ctx.conv, ctx.contact, { type: label, id: txnId });
}

/** Lost / stolen line: raise an urgent ticket for the team to block it (or just record it), with a checklist. */
async function finishLostLine(ctx: F.FlowCtx, msisdn: string, block: "both" | "line" | "none") {
  const w = ctx.mvno.wallet_name;
  const num = F.localNumber(msisdn);
  const what = block === "both" ? `your line and ${w}` : block === "line" ? "your line" : null;
  await updateConversation(ctx.conv.id, { bot_state: {} });
  await F.say(ctx, {
    type: "buttons",
    body:
      (what
        ? `Thank you 🙏 I've raised an urgent request to block ${what} on *${num}*. We'll confirm here once it's done.\n\n`
        : `Noted: *${num}* reported lost/stolen and *not* blocked. If you change your mind, just reply *block*.\n\n`) +
      `To get your number back on a new SIM, visit a *service centre* with your *original National ID*. You keep the same number${block !== "line" ? ` and your ${w} balance` : ""}.`,
    buttons: [
      { id: "near:store", title: "Nearest centre" },
      { id: "menu:main", title: "Main menu" },
    ],
  });
  const reason = what ? `Lost/stolen line ${num}: block ${block === "both" ? `line + ${w}` : "line only"}` : `Lost/stolen line ${num} (customer chose not to block)`;
  await doHandoff(ctx, { reason, priority: what ? "urgent" : "normal", category: "sim" });
  await updateConversation(ctx.conv.id, { subject: what ? `Block lost line ${num}` : `Lost line reported ${num}` }).catch(() => undefined);
  await addBotNote(
    ctx.conv,
    `🔒 Lost / stolen line\n` +
      `Number: ${num} (+${msisdn})\n` +
      `Reported from: +${ctx.contact.wa_id}${ctx.contact.wa_id === msisdn ? " (same number)" : " (different number: verify ownership first)"}\n` +
      `Requested: ${block === "both" ? `block line AND ${w}` : block === "line" ? `block line only (${w} stays active)` : "no block, record only"}\n` +
      (what
        ? `1. Verify the caller owns the line (registered name / NIN / recent activity).\n2. Block ${block === "both" ? `the line and ${w} wallet` : "the line"} in billing.\n3. Confirm to the customer here, then resolve the ticket.`
        : `1. Note the report on the subscriber's account.\n2. Resolve once the customer confirms they don't need a block.`),
  );
}

/** The bot answered a simple inquiry and the customer is done: close the ticket as bot-resolved. */
async function botResolve(ctx: F.FlowCtx, summary: string, category: string) {
  if (ctx.conv.status !== "bot") return; // never close chats owned by people
  await updateConversation(ctx.conv.id, {
    category: ctx.conv.category ?? category.slice(0, 40),
    subject: ctx.conv.subject ?? (summary ? summary.slice(0, 80) : "Inquiry answered by bot"),
    ai_summary: ctx.conv.ai_summary ?? (summary || null),
  });
  // resolveConversation decides whether a survey is due (once every N days per customer).
  // Keep ctx in sync so later writes in this turn don't overwrite the resolved state.
  ctx.conv = await resolveConversation(ctx.mvno, ctx.conv, ctx.contact, null, true, "Resolved by bot (inquiry answered)");
  if (ctx.conv.bot_state?.awaiting !== "csat") await F.say(ctx, { type: "text", text: closingOf(ctx.mvno) });
}

const isEscape = (t: string) => /^(menu|main menu|0|start|cancel|back)$/i.test(t);
// English, Luganda, Runyankole/Rukiga and Swahili greetings.
// English, Luganda, Runyankole/Rukiga, Swahili and Islamic greetings
// (salam / salaam / asalam / assalamu alaikum / as-salamu alaykum …).
const SALAM = /^(a?s+[-\s']?)?s?a?l+a+m(u|o)?\b/i;
const isGreeting = (t: string) =>
  SALAM.test(t) ||
  /^(hi+|hey|hello|hallo|good (morning|afternoon|evening)|oli otya|gyebale|ki kati|wasuze otya|agandi|oraire ota|habari|mambo|jambo)\b/i.test(t);

/** Only thanks / a pleasantry / emoji, with no question or request ("my pleasure 🙏", "ok 👍", "webale"). */
const COURTESY =
  /^(thanks?( (a lot|so much|very much|you( (so|very) much)?))?|thank you( (so|very) much)?|thanx|thnx|thx|tnx|ok+|okay|okey|alright|all right|sure|cool|great|nice|perfect|noted|received|my pleasure|pleasure|(you are|you're|youre) welcome|welcome|bye|goodbye|good ?night|have a (nice|good|blessed) (day|night|evening)|same to you|you too|god bless( you)?|amen|webale( nnyo| nyo)?|mwebale( nnyo)?|asante( sana)?|sawa|nice day)$/;
const isCourtesy = (t: string) => {
  const s = t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.trim().length > 60) return false;
  return s === "" ? t.trim().length > 0 : COURTESY.test(s); // "" = emoji/punctuation only
};

/** The whole message is just a greeting (no question or request attached). */
const isJustGreeting = (t: string) =>
  t.split(/\s+/).length <= 7 && !/[?]|\b(need|want|help|bundle|data|balance|airtime|sim|agent|how|what|where|why|when|njagala|nataka)\b/i.test(t);

/**
 * Builds the reply to a greeting from the MVNO's configured greeting:
 * - salam → "Wa alaikum assalam…" (never a second salam)
 * - "Hello"/"Hi"/other greeting → mirror the customer's own greeting word
 * The rest of the configured greeting (e.g. "I'm Hilal, Salamtel's virtual assistant…") follows.
 */
function greetingReply(greeting: string, text: string) {
  const t = text.trim();
  const configured = greeting.trim();
  const opensWithSalam = SALAM.test(configured);
  let opening: string | null = null;
  if (SALAM.test(t)) opening = "Wa alaikum assalam wa rahmatullahi wa barakatuh!";
  else if (opensWithSalam) {
    // Mirror e.g. "Hello", "Hi", "Good morning", "Oli otya".
    const said = t.replace(/[!.,]+$/, "").split(/\s+/).slice(0, /^good\b/i.test(t) ? 2 : /^(oli|ki|wasuze)\b/i.test(t) ? 2 : 1).join(" ");
    opening = `${said.charAt(0).toUpperCase()}${said.slice(1).toLowerCase()}!`;
  }
  let reply = configured;
  if (opening) {
    reply = opensWithSalam
      ? configured.replace(/^[^!.?]*[!.?]\s*/, `${opening} `) // replace the configured opening salam
      : `${opening} ${configured}`;
  }
  return /\?\s*$/.test(reply) ? reply : `${reply}\n\nHow can I help you today?`;
}

/** Used when no Claude API key is configured. */
async function keywordFallback(ctx: F.FlowCtx, text: string) {
  const t = text.toLowerCase();
  if (ctx.mvno.kind === "general") {
    if (/^(thanks|thank you|thank u|thx|that'?s all|bye)\b/.test(t)) return botResolve(ctx, "", "inquiry");
    if (/emergenc|danger|arrested|hospital|stolen passport|lost passport/.test(t)) return emergencyHelp(ctx, text.slice(0, 120));
    if (/appointment|book/.test(t)) return F.askAppointmentService(ctx);
    return F.showMenu(ctx, "I didn't quite catch that. Pick an option below, or ask to talk to an officer.");
  }
  if (/^(thanks|thank you|thank u|thx|asante|webale|mwebale|ok thanks|that'?s all|bye)\b/.test(t)) return botResolve(ctx, "", "inquiry");
  if (/fail|deduct|not received|haven.?t received|didn.?t (get|receive|go|reach)|not (credited|reflect)|stuck|pending|charged|reverse|refund|wrong number|sent to the wrong|bill.*(not|fail)|withdraw.*(not|fail)|deposit.*(not|fail)/.test(t))
    return F.startFailedTxn(ctx);
  if (/stolen|lost (my )?(sim|phone|line)|^block( my)?( line| number| sim)?$/.test(t)) return F.startLostLine(ctx);
  if (/replace|sim swap|damaged sim|broken sim/.test(t)) return F.showSimLoss(ctx);
  // "agent" alone usually means a PaxSente agent location, so it is not a handoff trigger.
  if (/(talk to|speak to|human|person|customer care|complain|fraud)/.test(t))
    return doHandoff(ctx, { reason: text.slice(0, 120), priority: /fraud/.test(t) ? "high" : "normal" });
  if (/promo|offer/.test(t)) return F.showPromos(ctx);
  if (/my number|namba yange|number yange/.test(t))
    return F.say(ctx, { type: "text", text: `To see your number, dial ${ctx.mvno.ussd_codes?.self_service ?? "*100#"}. Your WhatsApp number with us is +${ctx.contact.wa_id}.` });
  if (/agent/.test(t) && !/talk|speak/.test(t)) return findNearest(ctx, "agent");
  if (/service cent|office|branch/.test(t)) return findNearest(ctx, "store");
  if (/sente|mobile money|wallet|withdraw|deposit|send money|fee/.test(t)) return F.showWallet(ctx);
  if (/balance|salio/.test(t)) return F.showBalance(ctx);
  if (/esim|e-sim/.test(t)) return F.showEsim(ctx);
  if (/bundle|data|internet|mb|gb|minutes|wiki|week/.test(t)) return F.showBundles(ctx);
  if (/airtime|credit|top ?up|recharge/.test(t)) return F.showAirtime(ctx);
  if (/shop|store|near|kiosk|where/.test(t)) return findNearest(ctx);
  if (/deliver|sim card|order|track/.test(t)) return F.showDeliveries(ctx);
  if (/line|network|signal|suspend/.test(t)) return F.showLineStatus(ctx);
  return F.showMenu(ctx, "I can help with these. Pick one, or choose *Talk to an agent* 👇");
}

// ------------------------------------------------------------------ general tenants

/** Menu actions for general tenants (other than "answer", which goes to the AI). */
async function generalAction(ctx: F.FlowCtx, action: MenuAction, title: string) {
  switch (action) {
    case "appointment":
      return F.askAppointmentService(ctx);
    case "location":
      if (await F.showOffices(ctx)) return;
      return aiTopic(ctx, title); // no offices in Locations: answer from the knowledge base
    case "emergency":
      return emergencyHelp(ctx, "Customer chose Emergency help");
    case "human":
      return doHandoff(ctx, { reason: "Customer asked to talk to an officer", priority: "normal" });
    default:
      return aiTopic(ctx, title);
  }
}

/** Lets the AI answer a menu topic as if the customer had typed it. */
async function aiTopic(ctx: F.FlowCtx, title: string) {
  return F.say(ctx, { type: "text", text: `What would you like to know about *${title}*? Type your question.` });
}

/** Emergency: contact details at once, urgent ticket, and every supervisor/admin alerted (even after hours). */
async function emergencyHelp(ctx: F.FlowCtx, summary: string) {
  await F.say(ctx, {
    type: "text",
    text:
      (ctx.mvno.emergency_message?.trim() || "🚨 If you or someone else is in immediate danger, contact the local emergency services now.") +
      "\n\nWe've alerted our duty officers. Tell us here what happened and where you are, and an officer will contact you as soon as possible.",
  });
  await doHandoff(ctx, { reason: `EMERGENCY: ${summary || "customer asked for emergency help"}`, priority: "urgent", category: "emergency", quiet: true });
  await updateConversation(ctx.conv.id, { subject: `Emergency: ${(summary || "help requested").slice(0, 60)}` }).catch(() => undefined);
  const { data: staff } = await supabaseAdmin().from("mvno_members").select("user_id").eq("mvno_id", ctx.mvno.id).in("role", ["supervisor", "admin"]);
  const who = ctx.contact.name || `+${ctx.contact.wa_id}`;
  await notifyUsers((staff ?? []).map((s) => s.user_id), {
    mvnoId: ctx.mvno.id,
    mvnoName: ctx.mvno.name,
    conversationId: ctx.conv.id,
    kind: "reminder_supervisor",
    title: `🚨 Emergency: ${who} needs urgent help`,
    body: summary || "Customer chose Emergency help",
    link: `${appUrl()}/inbox?c=${ctx.conv.id}`,
    footer: "Sent because a customer asked for emergency help in Tuongee.",
  });
  if (ctx.mvno.alert_emails?.length) {
    await sendMail(
      ctx.mvno.alert_emails,
      `[${ctx.mvno.name}] 🚨 Emergency: ${who}`,
      renderEmail({ brand: ctx.mvno, title: `Emergency: ${who} needs urgent help`, intro: summary || "Customer chose Emergency help", cta: { label: "Open the chat", url: `${appUrl()}/inbox?c=${ctx.conv.id}` } }),
    );
  }
}

/** Appointment request → ticket with the details, for an officer to confirm. */
async function finishAppointment(ctx: F.FlowCtx, service: string, dates: string, name: string) {
  await F.say(ctx, {
    type: "text",
    text: `Thank you, ${name.split(" ")[0]}. Your appointment request is sent:\n\n• Service: *${service}*\n• Preferred: ${dates}\n\nAn officer will confirm your date and time here. Please don't come in until it's confirmed.`,
  });
  await doHandoff(ctx, { reason: `Appointment request: ${service}`, priority: "normal", category: "appointment", quiet: true });
  await updateConversation(ctx.conv.id, { subject: `Appointment: ${service}`.slice(0, 80), bot_state: {} }).catch(() => undefined);
  await addBotNote(ctx.conv, `📅 Appointment request\nService: ${service}\nPreferred: ${dates}\nName: ${name}\nWhatsApp: +${ctx.contact.wa_id}\n\nConfirm it on the Appointments page: the customer is messaged automatically.`);
  // The Appointments page lists these for staff to confirm.
  await supabaseAdmin()
    .from("appointments")
    .insert({ mvno_id: ctx.mvno.id, conversation_id: ctx.conv.id, contact_id: ctx.contact.id, service, preferred: dates, full_name: name })
    .then(({ error }) => error && console.error("appointment", error.message));
}

/** Strict tenants: a factual answer from ONE article, with its source and last-verified date added by us. */
async function answerFromKb(ctx: F.FlowCtx, articleId: string, answer: string) {
  const { data: a } = await supabaseAdmin().from("kb_articles").select("source_url, verified_at, mvno_id").eq("id", articleId).maybeSingle();
  if (!a || a.mvno_id !== ctx.mvno.id || !a.source_url || !a.verified_at || !answer.trim()) {
    return F.say(ctx, {
      type: "buttons",
      body: "I can't confirm that from our official information. An officer can help you with it.",
      buttons: [
        { id: "menu:human", title: "Talk to an officer" },
        { id: "menu:main", title: "Main menu" },
      ],
    });
  }
  const verified = new Date(a.verified_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return F.say(ctx, { type: "text", text: `${answer.trim()}\n\n🔗 Source: ${a.source_url}\n✅ Last verified: ${verified}`, previewUrl: false });
}
