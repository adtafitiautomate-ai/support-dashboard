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
          text: score >= 4 ? "Thank you! 💜 Have a great day." : "Thanks for telling us. We'll use this to do better. 🙏",
        },
      );
      return;
    }
  }

  const conv = await getActiveConversation(mvno, contact);
  const stored = await recordInbound(conv, msg);
  if (!stored) return; // duplicate webhook delivery
  void markReadAndTyping(mvno, msg.waMessageId);

  // Save photos / voice notes / documents in parallel with the reply, so media never slows the bot.
  const mediaJob = msg.mediaId ? storeInboundMedia(stored).catch((e) => console.error("media", e)) : null;
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

async function doHandoff(ctx: F.FlowCtx, input: { reason: string; priority?: Priority; category?: string }) {
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
        return F.askLocation(ctx, "delivery", { item: a });
      case "privacy":
        // Deletion requests are handled by a person (identity check, legal holds), then erased from the dashboard.
        await doHandoff(ctx, { reason: "Customer requested deletion of their data (privacy request)", priority: "high", category: "account" });
        return notifyDeletionRequest(ctx.mvno, ctx.conv, ctx.contact);
      case "ftype":
        return F.askTxnId(ctx, (a in F.TXN_TYPES ? a : "other") as F.TxnType);
      case "near":
        return findNearest(ctx, a === "store" || a === "agent" ? a : undefined);
    }
  }

  // ---------------------------------------------------------- awaited inputs
  if (state.awaiting === "txn" && text && !isEscape(text)) {
    const type = ((state.data?.txnType as string) in F.TXN_TYPES ? state.data?.txnType : "other") as F.TxnType;
    return finishFailedTxn(ctx, /^(skip|no|sina|sirina)$/i.test(text) ? null : text.slice(0, 120), type);
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

  const history = await recentMessages(ctx.conv.id, 20);
  const isFirst = history.filter((m) => m.direction === "out" && !m.is_internal).length === 0;
  // A plain greeting ("Hi", "Asalam alaikum") always gets the MVNO's configured greeting + menu,
  // never an improvised AI reply. Greetings with a question attached still go to the AI.
  if (isGreeting(text) && (isFirst || isJustGreeting(text))) return F.showMenu(ctx, greetingReply(ctx.mvno.greeting, text));

  if (!text) {
    return F.say(ctx, {
      type: "buttons",
      body: "Thanks! I can't open attachments, but our team can.",
      buttons: [
        { id: "menu:human", title: "Talk to an agent" },
        { id: "menu:main", title: "Main menu" },
      ],
    });
  }

  // Cap AI replies per customer so one chat can't run up model costs; menus still work past the cap.
  if (!(await allow(`ai:bot:${ctx.mvno.id}:${ctx.contact.wa_id}`, LIMITS.botAiPerCustomer))) return keywordFallback(ctx, text);
  const turn = await runAgent(ctx.mvno, ctx.contact, history).catch((e) => {
    console.error("claude error", e);
    return null;
  });
  if (!turn) return keywordFallback(ctx, text);

  if (turn.text) await F.say(ctx, { type: "text", text: turn.text });
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
      return findNearest(ctx, p === "agent" ? "agent" : p === "service_centre" ? "store" : undefined);
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
    case "sim_replacement_help":
      return F.showSimLoss(ctx);
    case "show_promos":
      return F.showPromos(ctx);
    case "track_or_order_delivery":
      return F.showDeliveries(ctx);
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
      return F.showDeliveries(ctx);
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

/** The bot answered a simple inquiry and the customer is done: close the ticket as bot-resolved. */
async function botResolve(ctx: F.FlowCtx, summary: string, category: string) {
  if (ctx.conv.status !== "bot") return; // never close chats owned by people
  await updateConversation(ctx.conv.id, {
    category: ctx.conv.category ?? category.slice(0, 40),
    subject: ctx.conv.subject ?? (summary ? summary.slice(0, 80) : "Inquiry answered by bot"),
    ai_summary: ctx.conv.ai_summary ?? (summary || null),
  });
  // Only one survey per day: a customer who already rated just gets a goodbye.
  const { count } = await supabaseAdmin()
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", ctx.contact.id)
    .not("csat_score", "is", null)
    .gte("resolved_at", new Date(Date.now() - 86_400_000).toISOString());
  const askCsat = !count;
  // Keep ctx in sync so later writes in this turn don't overwrite the resolved state.
  ctx.conv = await resolveConversation(ctx.mvno, ctx.conv, ctx.contact, null, askCsat, "Resolved by bot (inquiry answered)");
  if (!askCsat) await F.say(ctx, { type: "text", text: `Thanks for chatting with ${ctx.mvno.name}! Have a great day 💜` });
}

const isEscape = (t: string) => /^(menu|main menu|0|start|cancel|back)$/i.test(t);
// English, Luganda, Runyankole/Rukiga and Swahili greetings.
// English, Luganda, Runyankole/Rukiga, Swahili and Islamic greetings
// (salam / salaam / asalam / assalamu alaikum / as-salamu alaykum …).
const SALAM = /^(a?s+[-\s']?)?s?a?l+a+m(u|o)?\b/i;
const isGreeting = (t: string) =>
  SALAM.test(t) ||
  /^(hi+|hey|hello|hallo|good (morning|afternoon|evening)|oli otya|gyebale|ki kati|wasuze otya|agandi|oraire ota|habari|mambo|jambo)\b/i.test(t);

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
  if (/^(thanks|thank you|thank u|thx|asante|webale|mwebale|ok thanks|that'?s all|bye)\b/.test(t)) return botResolve(ctx, "", "inquiry");
  if (/fail|deduct|not received|haven.?t received|didn.?t (get|receive|go|reach)|not (credited|reflect)|stuck|pending|charged|reverse|refund|wrong number|sent to the wrong|bill.*(not|fail)|withdraw.*(not|fail)|deposit.*(not|fail)/.test(t))
    return F.startFailedTxn(ctx);
  if (/stolen|lost (my )?(sim|phone)|replace|sim swap|damaged sim|broken sim/.test(t)) return F.showSimLoss(ctx);
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
