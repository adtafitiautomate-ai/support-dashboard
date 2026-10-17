import "server-only";
import type { InboundMessage } from "@/lib/whatsapp/types";
import type { Mvno, Priority } from "@/lib/types";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  getActiveConversation,
  getCsatPending,
  handoff,
  logEvent,
  markReadAndTyping,
  recentMessages,
  recordInbound,
  updateConversation,
  upsertContact,
} from "@/lib/inbox/service";
import * as F from "./flows";
import { storeInboundMedia } from "@/lib/whatsapp/media";
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
  if (msg.replyId?.startsWith("csat:")) {
    const pending = await getCsatPending(contact);
    if (pending) {
      const score = Number(msg.replyId.split(":")[1]);
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
    await respond({ mvno, conv, contact }, msg);
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
      case "bcat":
        return F.showBundleCategory(ctx, a as "data" | "voice" | "combo");
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
    }
  }

  // ---------------------------------------------------------- awaited inputs
  if (state.awaiting === "location") {
    if (msg.location) {
      if (state.flow === "outlets") return F.showOutlets(ctx, msg.location);
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

  // Shared a location out of context: treat it as "find shops near me".
  if (msg.location) return F.showOutlets(ctx, msg.location);

  // ---------------------------------------------------------- free text
  if (isEscape(text)) return F.showMenu(ctx);

  const history = await recentMessages(ctx.conv.id, 20);
  const isFirst = history.filter((m) => m.direction === "out" && !m.is_internal).length === 0;
  if (isFirst && isGreeting(text)) return F.showMenu(ctx, `${ctx.mvno.greeting}\n\nWhat can I help you with today?`);

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
      const loc = ctx.contact.last_location;
      const fresh = loc && Date.now() - new Date(loc.at).getTime() < 7 * 86_400_000;
      return fresh ? F.showOutlets(ctx, loc) : F.askLocation(ctx, "outlets");
    }
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
      return runTool(ctx, "find_nearest_outlets", {});
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

const isEscape = (t: string) => /^(menu|main menu|0|start|cancel|back)$/i.test(t);
// English, Luganda, Runyankole/Rukiga and Swahili greetings.
const isGreeting = (t: string) =>
  /^(hi+|hey|hello|hallo|good (morning|afternoon|evening)|oli otya|gyebale|ki kati|wasuze otya|agandi|oraire ota|habari|mambo|jambo)\b/i.test(t);

/** Used when no Claude API key is configured. */
async function keywordFallback(ctx: F.FlowCtx, text: string) {
  const t = text.toLowerCase();
  // "agent" alone usually means a PaxSente agent location, so it is not a handoff trigger.
  if (/(talk to|speak to|human|person|customer care|complain|refund|fraud|stolen|lost|wrong number|reverse)/.test(t))
    return doHandoff(ctx, { reason: text.slice(0, 120), priority: /fraud|stolen|lost/.test(t) ? "high" : "normal" });
  if (/sente|mobile money|wallet|withdraw|deposit|send money|fee/.test(t)) return F.showWallet(ctx);
  if (/balance|salio/.test(t)) return F.showBalance(ctx);
  if (/esim|e-sim/.test(t)) return F.showEsim(ctx);
  if (/bundle|data|internet|mb|gb|minutes|wiki|week/.test(t)) return F.showBundles(ctx);
  if (/airtime|credit|top ?up|recharge/.test(t)) return F.showAirtime(ctx);
  if (/shop|store|near|agent location|service cent|kiosk|where/.test(t)) return runTool(ctx, "find_nearest_outlets", {});
  if (/deliver|sim card|order|track/.test(t)) return F.showDeliveries(ctx);
  if (/line|network|signal|suspend/.test(t)) return F.showLineStatus(ctx);
  return F.showMenu(ctx, "I can help with these. Pick one, or choose *Talk to an agent* 👇");
}
