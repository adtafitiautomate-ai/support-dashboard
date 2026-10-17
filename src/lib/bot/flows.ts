import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { mvnoApi } from "@/lib/mvno/api";
import { bundleSummary, formatData, formatMoney, haversineKm } from "@/lib/format";
import type { Bundle, Contact, Conversation, Delivery, Mvno, Outlet } from "@/lib/types";
import type { OutboundMessage } from "@/lib/whatsapp/types";
import { sendMessage, updateConversation, logEvent } from "@/lib/inbox/service";

// Deterministic, button-driven flows. Anything touching money runs here,
// never through free-form AI output.

export interface FlowCtx {
  mvno: Mvno;
  conv: Conversation;
  contact: Contact;
}

export async function say(ctx: FlowCtx, out: OutboundMessage) {
  return sendMessage(ctx.mvno, ctx.conv, ctx.contact, out, { senderType: "bot" });
}

async function setState(ctx: FlowCtx, state: Conversation["bot_state"], extra: Partial<Conversation> = {}) {
  ctx.conv = await updateConversation(ctx.conv.id, { bot_state: state, ...extra });
}

// ------------------------------------------------------------------ main menu

export async function showMenu(ctx: FlowCtx, intro?: string) {
  await setState(ctx, {});
  await say(ctx, {
    type: "list",
    header: ctx.mvno.name,
    body: intro ?? "What can I help you with? Pick an option below, or just type your question.",
    button: "Menu",
    footer: "Reply 'menu' anytime",
    sections: [
      {
        title: "Top up",
        rows: [
          { id: "menu:bundles", title: "Buy a bundle", description: "Data, calls & SMS bundles" },
          { id: "menu:promos", title: "Promo bundles", description: "Current promotions and offers" },
          { id: "menu:airtime", title: "Buy airtime", description: "Top up any number" },
          { id: "menu:balance", title: "Check my balance", description: "Airtime, data and expiry" },
        ],
      },
      {
        title: "Services",
        rows: [
          { id: "menu:wallet", title: ctx.mvno.wallet_name.slice(0, 24), description: "Mobile money: fees, limits, help" },
          { id: "menu:outlets", title: "Find a shop or agent", description: "Nearest service centre or agent" },
          { id: "menu:delivery", title: "SIM, eSIM & deliveries", description: "Order a SIM, get an eSIM, track" },
          { id: "menu:simloss", title: "Lost / replace SIM", description: "Stolen, lost or damaged SIM" },
        ],
      },
      {
        title: "Help",
        rows: [
          { id: "menu:failed", title: "Failed transaction", description: "Charged but didn't get value" },
          { id: "menu:human", title: "Talk to an agent", description: "Chat with our support team" },
        ],
      },
    ],
  });
}

// ------------------------------------------------------------------ balance & line

export async function showBalance(ctx: FlowCtx) {
  const b = await mvnoApi(ctx.mvno.slug).getBalance(ctx.contact.msisdn ?? ctx.contact.wa_id);
  await say(ctx, {
    type: "buttons",
    body:
      `*Your balance* 📊\n\n` +
      `💰 Airtime: ${formatMoney(b.airtime, ctx.mvno.currency)}\n` +
      `📶 Data: ${formatData(b.dataMb)}\n` +
      `📞 Minutes: ${b.minutes}\n` +
      `✉️ SMS: ${b.sms}\n` +
      (b.activeBundle ? `\nActive bundle: ${b.activeBundle}\n` : "") +
      `Expires: ${new Date(b.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` +
      (ctx.mvno.ussd_codes?.balance ? `\n\n_Tip: dial ${ctx.mvno.ussd_codes.balance} anytime to check your balance._` : ""),
    buttons: [
      { id: "menu:bundles", title: "Buy a bundle" },
      { id: "menu:airtime", title: "Buy airtime" },
      { id: "menu:main", title: "Main menu" },
    ],
  });
}

export async function showLineStatus(ctx: FlowCtx) {
  const s = await mvnoApi(ctx.mvno.slug).getLineStatus(ctx.contact.msisdn ?? ctx.contact.wa_id);
  const ok = s.state === "active";
  await say(ctx, {
    type: "buttons",
    body:
      `*Line check for +${s.msisdn}*\n\n` +
      `${ok ? "✅" : "⚠️"} Line: ${s.state}\n` +
      `${s.kyc === "verified" ? "✅" : "⏳"} Registration: ${s.kyc}\n` +
      `📱 SIM: ${s.simType}\n📡 Network: ${s.network}` +
      (ok ? "" : "\n\nYour line needs attention, an agent can sort this out for you."),
    buttons: ok
      ? [
          { id: "menu:bundles", title: "Buy a bundle" },
          { id: "menu:main", title: "Main menu" },
        ]
      : [
          { id: "menu:human", title: "Talk to an agent" },
          { id: "menu:main", title: "Main menu" },
        ],
  });
}

// ------------------------------------------------------------------ bundles & recharge

export async function listBundles(mvnoId: string): Promise<Bundle[]> {
  const { data } = await supabaseAdmin().from("bundles").select("*").eq("mvno_id", mvnoId).eq("active", true).order("sort");
  return data ?? [];
}

const CATEGORY_LABEL: Record<Bundle["category"], string> = {
  data: "Data bundles",
  voice: "Voice bundles",
  combo: "Combo bundles",
  deal: "Deals",
};

/** Step 1: pick a category (WhatsApp lists hold max 10 rows, catalogues are bigger). */
export async function showBundles(ctx: FlowCtx) {
  const bundles = await listBundles(ctx.mvno.id);
  const cats = [...new Set(bundles.map((b) => b.category))];
  if (bundles.length <= 10 || cats.length < 2) return showBundleCategory(ctx, null);
  await setState(ctx, { flow: "bundle" });
  await say(ctx, {
    type: "buttons",
    body: "What kind of bundle would you like? 👇 Bundles activate instantly after payment.",
    buttons: [
      { id: "bcat:data", title: "📶 Data" },
      { id: "bcat:voice", title: "📞 Voice" },
      { id: "bcat:combo", title: "🎁 Combos & deals" },
    ],
  });
}

/** Step 2: list the bundles in one category (null = all). */
export async function showBundleCategory(ctx: FlowCtx, category: Bundle["category"] | null) {
  const all = await listBundles(ctx.mvno.id);
  const bundles = all.filter((b) => !category || b.category === category || (category === "combo" && b.category === "deal"));
  await setState(ctx, { flow: "bundle" });
  const rows = (list: Bundle[]) =>
    list.map((b) => ({
      id: `bundle:${b.id}`,
      title: b.name.slice(0, 24),
      description: `${formatMoney(b.price, ctx.mvno.currency)} · ${bundleSummary(b)}`,
    }));
  const groups = [...new Set(bundles.map((b) => b.category))];
  const ussd = bundles.find((b) => b.ussd)?.ussd;
  await say(ctx, {
    type: "list",
    body: `Pick a bundle 👇${ussd ? `\nYou can also dial ${ussd}.` : ""}`,
    button: "See bundles",
    sections: groups.map((g) => ({ title: CATEGORY_LABEL[g], rows: rows(bundles.filter((b) => b.category === g)) })),
  });
}

export async function showPromos(ctx: FlowCtx) {
  const promo = ctx.mvno.ussd_codes?.promos;
  await say(ctx, {
    type: "buttons",
    body: promo
      ? `🎉 *Promo bundles*\n\nDial *${promo}* to see and buy today's promotions. Offers change often, so check back!`
      : "🎉 Our current promotions are listed in the bundle menu.",
    buttons: [
      { id: "menu:bundles", title: "Regular bundles" },
      { id: "menu:main", title: "Main menu" },
    ],
  });
}

export async function showSimLoss(ctx: FlowCtx) {
  await say(ctx, {
    type: "buttons",
    body:
      `*Lost, stolen or damaged SIM* 🔒\n\n` +
      `Please visit your nearest *service centre* with your *original National ID*. We'll replace your SIM and you keep your number.\n\n` +
      `Agents can't replace SIMs, so go to a service centre.`,
    buttons: [
      { id: "near:store", title: "Nearest centre" },
      { id: "menu:main", title: "Main menu" },
    ],
  });
}

export async function startFailedTxn(ctx: FlowCtx) {
  await setState(ctx, { flow: "failed_txn", awaiting: "txn" });
  await say(ctx, {
    type: "text",
    text:
      `Sorry about that 😔 Let's get it checked.\n\n` +
      `Please send the *transaction ID* from your SMS or ${ctx.mvno.wallet_name} statement (e.g. PS81LM2Q), plus the amount if you can.\n\n` +
      `No ID? Reply *skip*.`,
  });
}

export async function showWallet(ctx: FlowCtx) {
  const m = ctx.mvno;
  await say(ctx, {
    type: "buttons",
    body:
      `*${m.wallet_name}* 💸\n\n` +
      (m.wallet_ussd ? `Dial ${m.wallet_ussd} or use the app to send money, pay bills, buy airtime & data, and transfer to/from your bank.\n\n` : "") +
      `🔒 Never share your PIN, not even with our staff. Never pay an agent a fee in cash: fees come from your wallet.\n\nAsk me anything, e.g. _"how much to send 50,000?"_`,
    buttons: [
      { id: "near:agent", title: "Find an agent" },
      { id: "menu:failed", title: "Failed transaction" },
      { id: "menu:main", title: "Main menu" },
    ],
  });
}

export async function confirmBundle(ctx: FlowCtx, bundleId: string) {
  const { data: b } = await supabaseAdmin().from("bundles").select("*").eq("id", bundleId).eq("mvno_id", ctx.mvno.id).maybeSingle();
  if (!b) return showBundles(ctx);
  await setState(ctx, { flow: "bundle", data: { bundleId } });
  await say(ctx, {
    type: "buttons",
    header: b.name,
    body: `${bundleSummary(b)}\n*Price: ${formatMoney(b.price, ctx.mvno.currency)}*\n\nWho is this for?`,
    footer: `Paid with ${ctx.mvno.wallet_name}`,
    buttons: [
      { id: `buy:self:${b.id}`, title: "My number" },
      { id: `buy:other:${b.id}`, title: "Another number" },
      { id: "menu:main", title: "Cancel" },
    ],
  });
}

export async function askOtherNumber(ctx: FlowCtx, purchase: { bundleId?: string; amount?: number }) {
  await setState(ctx, { flow: "purchase", awaiting: "msisdn", data: purchase });
  await say(ctx, { type: "text", text: "Type the number to top up, e.g. 0724 123 456" });
}

/** Ugandan mobile numbers: 07XX XXX XXX, 2567XXXXXXXX or 7XXXXXXXX. */
export function normalizeMsisdn(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (/^07\d{8}$/.test(digits)) return "256" + digits.slice(1);
  if (/^2567\d{8}$/.test(digits)) return digits;
  if (/^7\d{8}$/.test(digits)) return "256" + digits;
  return null;
}

export async function showAirtime(ctx: FlowCtx) {
  await setState(ctx, { flow: "airtime" });
  await say(ctx, {
    type: "list",
    body: "How much airtime would you like?",
    button: "Choose amount",
    sections: [
      {
        title: "Amount",
        rows: [1000, 2000, 5000, 10000, 20000].map((a) => ({ id: `airtime:${a}`, title: formatMoney(a, ctx.mvno.currency) })),
      },
      { title: "Other", rows: [{ id: "airtime:custom", title: "Enter an amount" }] },
    ],
  });
}

export async function confirmAirtime(ctx: FlowCtx, amount: number) {
  await setState(ctx, { flow: "airtime", data: { amount } });
  await say(ctx, {
    type: "buttons",
    body: `Buy *${formatMoney(amount, ctx.mvno.currency)}* airtime. Who is it for?`,
    buttons: [
      { id: `air:self:${amount}`, title: "My number" },
      { id: `air:other:${amount}`, title: "Another number" },
      { id: "menu:main", title: "Cancel" },
    ],
  });
}

/** Charges via mobile money and records the recharge. */
export async function executePurchase(ctx: FlowCtx, p: { msisdn: string; bundleId?: string; amount?: number }) {
  const db = supabaseAdmin();
  let amount = p.amount ?? 0;
  let label = `${formatMoney(amount, ctx.mvno.currency)} airtime`;
  let bundle: Bundle | null = null;
  if (p.bundleId) {
    const { data } = await db.from("bundles").select("*").eq("id", p.bundleId).single();
    bundle = data;
    amount = Number(data!.price);
    label = data!.name;
  }

  const { data: recharge } = await db
    .from("recharges")
    .insert({
      mvno_id: ctx.mvno.id,
      contact_id: ctx.contact.id,
      conversation_id: ctx.conv.id,
      msisdn: p.msisdn,
      kind: bundle ? "bundle" : "airtime",
      bundle_id: bundle?.id ?? null,
      amount,
      status: "pending",
    })
    .select()
    .single();

  await setState(ctx, {});
  await say(ctx, {
    type: "text",
    text: `📲 A ${ctx.mvno.wallet_name} payment request for *${formatMoney(amount, ctx.mvno.currency)}* has been sent to +${ctx.contact.wa_id}. Enter your ${ctx.mvno.wallet_name} PIN on the prompt to approve. Never share your PIN here.`,
  });

  const result = await mvnoApi(ctx.mvno.slug).chargeAndCredit({
    msisdn: p.msisdn,
    payerMsisdn: ctx.contact.wa_id,
    amount,
    description: label,
  });
  await db.from("recharges").update({ status: result.status, reference: result.reference }).eq("id", recharge!.id);
  await logEvent(ctx.conv, `Recharge ${result.status}: ${label} for +${p.msisdn} (${result.reference})`);

  if (result.status === "success") {
    await say(ctx, {
      type: "buttons",
      body:
        `✅ *Done!* ${label} is now active on +${p.msisdn}.\n\n` +
        `Amount: ${formatMoney(amount, ctx.mvno.currency)}\nRef: ${result.reference}`,
      buttons: [
        { id: "menu:balance", title: "Check balance" },
        { id: "menu:main", title: "Main menu" },
      ],
    });
  } else {
    await say(ctx, {
      type: "buttons",
      body: `❌ The payment didn't go through (${result.message}). You have not been charged.`,
      buttons: [
        { id: p.bundleId ? `bundle:${p.bundleId}` : "menu:airtime", title: "Try again" },
        { id: "menu:human", title: "Talk to an agent" },
      ],
    });
  }
}

// ------------------------------------------------------------------ outlets

export type OutletKind = "agent" | "store";

export async function askLocation(ctx: FlowCtx, purpose: "outlets" | "delivery", data: { kind?: OutletKind; item?: string } = {}) {
  await setState(ctx, { flow: purpose, awaiting: "location", data });
  const what = data.kind === "agent" ? `agents (top-ups & ${ctx.mvno.wallet_name})` : data.kind === "store" ? "service centres" : "service centres and agents";
  await say(ctx, {
    type: "location_request",
    body:
      purpose === "outlets"
        ? `Share your location 📍 (tap the button below) and I'll send the nearest ${what}.`
        : "Share your delivery location 📍 (tap the button), or type your address.",
  });
}

/** Nearest outlets of a kind; falls back to any kind if none of that kind exist. */
export async function nearestOutlets(mvnoId: string, at: { lat: number; lng: number }, kind?: OutletKind, limit = 3) {
  const { data } = await supabaseAdmin().from("outlets").select("*").eq("mvno_id", mvnoId);
  const all = (data ?? []) as Outlet[];
  const pool = kind ? all.filter((o) => (kind === "store" ? o.kind === "store" : o.kind !== "store")) : all;
  return (pool.length ? pool : all)
    .map((o) => ({ ...o, km: haversineKm(at, o) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, limit);
}

export async function showOutlets(ctx: FlowCtx, at: { lat: number; lng: number }, kind?: OutletKind) {
  await setState(ctx, {});
  const list = await nearestOutlets(ctx.mvno.id, at, kind);
  if (!list.length) {
    await say(ctx, { type: "text", text: "I couldn't find an outlet near you yet, sorry." });
    return;
  }
  const kindIcon = { store: "🏬", agent: "🧑‍💼", kiosk: "🏪" } as const;
  await say(ctx, {
    type: "text",
    text:
      `*Nearest to you:*\n\n` +
      list
        .map(
          (o, i) =>
            `${i + 1}. ${kindIcon[o.kind]} *${o.name}* · ${o.km.toFixed(1)} km\n   ${o.address}\n   🕒 ${o.hours ?? "–"}${o.phone ? `  ☎️ ${o.phone}` : ""}`,
        )
        .join("\n\n") +
      `\n\n🏬 service centres: SIM swaps, eSIM, ${ctx.mvno.wallet_name}, device support · 🧑‍💼 agents: deposits, withdrawals, airtime & bundles`,
  });
  const top = list[0];
  await say(ctx, { type: "location", lat: top.lat, lng: top.lng, name: top.name, address: top.address });
}

// ------------------------------------------------------------------ deliveries

export async function showDeliveries(ctx: FlowCtx) {
  const { data } = await supabaseAdmin()
    .from("deliveries")
    .select("*")
    .eq("contact_id", ctx.contact.id)
    .not("status", "in", "(delivered,cancelled)")
    .order("created_at", { ascending: false })
    .limit(3);
  const active = (data ?? []) as Delivery[];
  const label: Record<Delivery["status"], string> = {
    requested: "📝 Requested, we'll schedule it shortly",
    scheduled: "📅 Scheduled",
    out_for_delivery: "🛵 Out for delivery",
    delivered: "✅ Delivered",
    failed: "⚠️ Delivery failed",
    cancelled: "Cancelled",
  };
  const body = active.length
    ? active
        .map(
          (d) =>
            `*${d.item.toUpperCase()}* · ${d.tracking_code}\n${label[d.status]}` +
            (d.scheduled_for ? `\nETA: ${new Date(d.scheduled_for).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "") +
            (d.rider_name ? `\nRider: ${d.rider_name}${d.rider_phone ? ` (${d.rider_phone})` : ""}` : ""),
        )
        .join("\n\n")
    : "You have no active deliveries.";
  await say(ctx, {
    type: "buttons",
    body: `${body}\n\nWould you like a new SIM delivered, or an eSIM?`,
    buttons: [
      { id: "deliver:sim", title: "Deliver a SIM" },
      { id: "esim:info", title: "Get an eSIM" },
      { id: "menu:main", title: "Main menu" },
    ],
  });
}

/** eSIMs are activated in person (biometrics + National ID), so guide the customer there. */
export async function showEsim(ctx: FlowCtx) {
  await say(ctx, {
    type: "buttons",
    body:
      `*Getting an eSIM* 📱\n\n` +
      `1. Dial *#06#: if you see an *EID* number, your phone supports eSIM.\n` +
      `2. Visit a service centre with your *original National ID*.\n` +
      `3. We capture your biometrics and photo.\n` +
      `4. You get a QR code: scan it to activate.\n\n` +
      `Works on iPhone XS+, Samsung S20+, Pixel 3+, iPad Pro 2018+, Apple Watch 3+.`,
    buttons: [
      { id: "near:store", title: "Nearest centre" },
      { id: "menu:main", title: "Main menu" },
    ],
  });
}

export async function createDelivery(
  ctx: FlowCtx,
  item: "sim" | "esim",
  where: { address?: string; lat?: number; lng?: number },
) {
  const { data: d } = await supabaseAdmin()
    .from("deliveries")
    .insert({
      mvno_id: ctx.mvno.id,
      contact_id: ctx.contact.id,
      item,
      status: "requested",
      address: where.address ?? null,
      lat: where.lat ?? null,
      lng: where.lng ?? null,
    })
    .select()
    .single();
  await setState(ctx, {});
  await logEvent(ctx.conv, `Delivery requested: ${item.toUpperCase()} (${d!.tracking_code})`);
  await say(ctx, {
    type: "buttons",
    body:
      `📦 *Order placed!*\n\nItem: ${item === "esim" ? "eSIM (QR code)" : "SIM card"}\nTracking: ${d!.tracking_code}\n\n` +
      (item === "esim"
        ? "An agent will verify your ID here on WhatsApp and send your eSIM QR code."
        : "A rider will call you before arriving. Have your ID ready for registration."),
    buttons: [
      { id: "menu:delivery", title: "Track delivery" },
      { id: "menu:main", title: "Main menu" },
    ],
  });
}
