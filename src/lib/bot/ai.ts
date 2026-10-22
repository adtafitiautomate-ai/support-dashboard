import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Contact, KbArticle, Message, Mvno } from "@/lib/types";
import { recordAiUsage, type AiKind } from "@/lib/ai-usage";
import { hasRealBilling } from "@/lib/mvno/api";
import { closingOf } from "@/lib/format";
import type { AiAttachment } from "@/lib/whatsapp/media";

const MODEL = process.env.BOT_MODEL || "claude-opus-5-5";

let client: Anthropic | null | undefined;
export function claude(): Anthropic | null {
  if (client === undefined) client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  return client;
}

// ------------------------------------------------------------------ context

// Small knowledge bases are embedded whole in the cached system prompt (no lookup
// latency). Once trained docs make it large, we retrieve the best matches per turn.
const INLINE_KB_CHARS = 30_000;

const kbCache = new Map<string, { at: number; articles: KbArticle[]; inline: boolean }>();
/** Strict tenants only ever see articles with a source page and a verified date. */
const sourced = (a: KbArticle) => !!a.source_url && !!a.verified_at;
async function knowledgeBase(mvnoId: string, strict = false) {
  const key = `${mvnoId}:${strict}`;
  const hit = kbCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const { data } = await supabaseAdmin().from("kb_articles").select("id,title,body,tags,source_url,verified_at").eq("mvno_id", mvnoId).order("title").limit(2000);
  const articles = ((data ?? []) as KbArticle[]).filter((a) => !strict || sourced(a));
  const size = articles.reduce((n, a) => n + a.title.length + a.body.length, 0);
  const entry = { at: Date.now(), articles: size <= INLINE_KB_CHARS ? articles : [], inline: size <= INLINE_KB_CHARS };
  kbCache.set(key, entry);
  return entry;
}

async function retrieveKb(mvnoId: string, history: Message[], strict = false) {
  const query = history
    .filter((m) => m.direction === "in" && m.body)
    .slice(-3)
    .map((m) => m.body)
    .join(" ");
  if (!query.trim()) return [];
  const { data } = await supabaseAdmin().rpc("search_kb", { p_mvno: mvnoId, p_query: query, p_limit: strict ? 16 : 8 });
  return ((data ?? []) as KbArticle[]).filter((a) => !strict || sourced(a)).slice(0, 8);
}

const formatKb = (articles: KbArticle[], withIds = false) =>
  articles.map((a) => (withIds ? `## [${a.id}] ${a.title}\n${a.body}` : `## ${a.title}\n${a.body}`)).join("\n\n");

/** Volatile per-turn context: customer facts plus retrieved articles when the KB is large. */
async function turnContext(mvno: Mvno, contact: Contact, history: Message[]) {
  const strict = !!mvno.strict_sources;
  const kb = await knowledgeBase(mvno.id, strict);
  if (kb.inline) return customerContext(mvno, contact);
  const found = await retrieveKb(mvno.id, history, strict);
  return `${customerContext(mvno, contact)}\n\nRelevant knowledge base articles for this conversation:\n${found.length ? formatKb(found, strict) : "(none matched: if unsure, hand over to an agent)"}`;
}

/** System prompt for tenants that aren't mobile networks (e.g. an embassy). */
async function generalSystem(mvno: Mvno) {
  const strict = !!mvno.strict_sources;
  const kb = await knowledgeBase(mvno.id, strict);
  return `You are ${mvno.bot_name}, the WhatsApp assistant for ${mvno.name}.
Brand voice: ${mvno.bot_persona}

How to reply:
- This is WhatsApp. Keep replies short (1–4 short lines), friendly, calm and specific. Use *bold* sparingly, no markdown headings or tables.
- Reply in the customer's language if they write in one other than English.
- Answer only from the knowledge base. Never make up requirements, fees, timelines, procedures, addresses or links.
- You speak only for ${mvno.name}. Never mention other organisations or businesses using this platform.
${
    strict
      ? `- SOURCED ANSWERS ONLY. Every factual answer (requirements, fees, steps, dates, places, links) MUST be sent with the answer_from_kb tool, naming the ONE article it comes from (its id in [brackets]). The system adds the source link and "last verified" date itself: never write sources, links or dates of verification yourself. Never state facts in plain text.
- If no article covers the question, say briefly that you can't confirm that from official information, and offer an officer (call handoff_to_agent if they want one). Never guess.
- Plain text is only for greetings, one short clarifying question, and acknowledgements.`
      : `- If the knowledge base doesn't cover the question, say so and offer an officer (handoff_to_agent). Never guess.`
  }
- Appointments: call request_appointment (it collects the details and creates a request an officer confirms). Never promise a date or time yourself.
- Emergencies (someone in danger, arrested, injured, in hospital, lost or stolen documents while travelling, any urgent safety issue): call emergency_help immediately.
- Office address or opening hours: call show_offices.
- "Has my National ID arrived?" or any ID status question: call check_national_id (with their full name if they gave it). Never say yourself whether a card has arrived, never guess, and never mention anyone else's name. How to collect a card is a normal knowledge-base question.
- Wanting a person, complaints, or anything you can't answer from the knowledge base: call handoff_to_agent.
- Never ask for passwords or PINs. Don't ask for full ID or passport numbers unless an article says they're needed.
- Ending a chat: only when the customer says they're done (thanks, that's all, bye), call resolve_conversation and write NO goodbye yourself: the system sends the closing message ("${closingOf(mvno)}"). Never close while the customer is waiting on us; end with the next step instead.
- Customers may send photos or PDFs (e.g. a document or a receipt); read them and help, or hand to an officer.

${kb.inline ? `Knowledge base${strict ? " (each article's id is in [brackets])" : ""}:\n${formatKb(kb.articles, strict) || "(empty: hand questions to an officer)"}` : "Knowledge base: the most relevant articles are provided with each turn below."}`;
}

/** Stable per-MVNO system prompt: identical bytes across requests so it caches. */
async function stableSystem(mvno: Mvno) {
  if (mvno.kind === "general") return generalSystem(mvno);
  const kb = await knowledgeBase(mvno.id);
  return `You are ${mvno.bot_name}, the WhatsApp customer care assistant for ${mvno.name}, a mobile network (MVNO).
Brand voice: ${mvno.bot_persona}

How to reply:
- This is WhatsApp. Keep replies short (1–4 short lines), friendly and specific. Use *bold* sparingly, no markdown headings or tables.
- Never paste whole articles. Answer only what was asked. For lists (bundles, prices, outlets) give at most 5 items, then offer the rest ("Want the monthly ones too?"). For bundles, prefer the show_bundles tool.
- Never mention where information comes from (website, homepage, documents, product list) and never pass on internal doubts or "not confirmed" notes. If something is uncertain, leave it out or offer an agent.
- You speak only for ${mvno.name}. Never reveal that ${mvno.name} shares systems or a platform with other networks or businesses.
- Reply in the customer's language (e.g. Luganda, Runyankole/Rukiga, Swahili or English) if they write that way.
- Prefer tools over describing steps: if the customer wants to buy, check, find or track something, call the matching tool. The tools send interactive WhatsApp messages themselves, so don't repeat their content.
- Money is only moved after the customer taps a confirmation button. Never claim a payment, refund or change on their account happened unless a tool result says so.
${
    hasRealBilling(mvno.slug)
      ? ""
      : `- You can NOT see customers' accounts: no balances, bundles, usage or transactions. Never offer to check, look up or confirm anything on their account ("Would you like me to check?"). Instead tell them how to check it themselves${mvno.ussd_codes?.balance ? `: dial ${mvno.ussd_codes.balance} to see their remaining airtime, data, minutes and bundle expiry` : ""}.\n`
  }- Line not working, "Emergency calls only", "No service" or no network: FIRST walk the customer through the first-line troubleshooting in the knowledge base (airplane mode on for about 6 seconds then off; they must be in Uganda; if abroad, roaming must be enabled). Ask whether it worked. Only call handoff_to_agent if it still fails after those steps, or if they already tried them.
- Always try to answer the question itself first. General questions ("what services do you offer?", "do you have other services?", "tell me about you") get a short summary from the knowledge base, not the menu.
- Answer from the knowledge base below. If it doesn't cover the question, or the customer is upset, asks for a human, reports fraud/lost phone, needs a refund, or you're unsure after one attempt, call handoff_to_agent. Don't make up policies, prices or timelines.
- Never ask for PINs, passwords or full ID numbers. Mobile money is ${mvno.wallet_name}${mvno.wallet_ussd ? ` (${mvno.wallet_ussd})` : ""}; prices are in ${mvno.currency}.
- Other ways to reach us: ${mvno.care_line ?? "this WhatsApp chat"}.${
    Object.keys(mvno.ussd_codes ?? {}).length
      ? `\n- USSD codes:${mvno.ussd_codes.balance ? ` check balance ${mvno.ussd_codes.balance};` : ""}${mvno.ussd_codes.self_service ? ` buy airtime/bundles or see your own number ${mvno.ussd_codes.self_service};` : ""}${mvno.ussd_codes.promos ? ` promo bundles ${mvno.ussd_codes.promos};` : ""}${mvno.ussd_codes.other_networks ? ` buy from an MTN/Airtel line via ${mvno.ussd_codes.other_networks} (Airtime and Bundles, small fee);` : ""}`
      : ""
  }
- Failed, stuck or deducted transactions of ANY kind (${mvno.wallet_name}: send money, receive money, bill payments, withdrawals, deposits; or airtime/bundles): always call report_failed_transaction. That raises a ticket for finance. Never promise a refund or reversal. Lost or stolen phone/SIM: always call report_lost_or_stolen (pass the number and block choice if the customer already gave them). Damaged SIM or SIM replacement only: call sim_replacement_help (agents cannot replace SIMs).
- Ending a chat: only when the customer says they're done (thanks, that's all, bye, webale, asante) or declines "anything else?", call resolve_conversation and write NO goodbye yourself: the system sends the closing message ("${closingOf(mvno)}"), together with the rating question when one is due. Never add a closing or "have a nice day" to ordinary replies.
- Never use time-of-day greetings in a goodbye (no "good morning/afternoon/evening/night").
- Don't close while the customer is still waiting on us: after a failed transaction, a lost/stolen line request, a complaint handed to the team or anything escalated, end with the next step instead (e.g. "I've passed your details to our team. We'll update you here.").
- Customers may send photos or screenshots (often an SMS or mobile money confirmation) or PDFs; they are attached to their message. Read them and act: e.g. a failed or disputed transaction → report_failed_transaction with the transaction ID, amount and type you can see. If it's unclear what they want, say briefly what you see and ask what's wrong. Don't repeat full ID or account numbers back unless needed.
- Asking where an agent is: call find_nearest_outlets with purpose "agent". Asking for a service centre: purpose "service_centre". Pass the customer's town/area if they mentioned it anywhere in the chat; never guess it.
- eSIM questions: call show_esim_steps (it lists the service centres that issue eSIMs; never say a centre can't issue them unless the knowledge base says so).${mvno.sim_delivery ? "" : "\n- We do NOT deliver SIMs or eSIMs. Never offer or mention delivery; SIMs and eSIMs are collected in person."}
- Only mention agents or the nearest agent/outlet when the customer asks where to go or asks about agents.

${kb.inline ? `Knowledge base:\n${formatKb(kb.articles)}` : "Knowledge base: the most relevant articles are provided with each turn below."}`;
}

function customerContext(mvno: Mvno, contact: Contact) {
  return `Customer: ${contact.name ?? "unknown name"}, WhatsApp +${contact.wa_id}, plan ${contact.plan ?? "prepaid"}${
    contact.tags.length ? `, tags: ${contact.tags.join(", ")}` : ""
  }. Their location is ${contact.last_location ? "known" : "unknown"}. Local time: ${new Date().toLocaleString("en-GB", {
    timeZone: mvno.business_hours?.tz ?? "Africa/Kampala",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  })}.`;
}

/** Converts stored WhatsApp history into Claude turns (customer = user, bot/agent = assistant). */
function toTurns(history: Message[]): Anthropic.Beta.BetaMessageParam[] {
  const turns: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of history) {
    if (m.is_internal || !m.body) continue;
    const role = m.direction === "in" ? "user" : "assistant";
    const text = m.sender_type === "agent" ? `[Human agent] ${m.body}` : m.body;
    if (!turns.length && role === "assistant") continue; // first turn must be the user
    turns.push({ role, content: text });
  }
  return turns;
}

// ------------------------------------------------------------------ tools

export const BOT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "show_main_menu",
    description:
      "Send the interactive main menu. Use ONLY when the customer explicitly asks for the menu/options, or sends a greeting with no question. Never use it instead of answering a question: questions about products or services (e.g. 'what other services do you have?') must be answered in text from the knowledge base.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "check_balance",
    description: "Send the customer their live airtime, data, minutes, SMS balance and expiry.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "check_line_status",
    description: "Send the customer their line status: active/suspended, registration (KYC), SIM type and network.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "show_bundles",
    description: "Send the interactive list of bundles with prices so the customer can pick one. Pass the category if clear, else 'any'.",
    input_schema: {
      type: "object",
      properties: { category: { type: "string", enum: ["data", "voice", "combo", "any"] } },
      required: ["category"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "show_esim_steps",
    description: "Send the eSIM compatibility check and in-person activation steps, with a button to find the nearest service centre.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "start_bundle_purchase",
    description:
      "Customer clearly asked for a specific bundle. Sends a confirm-and-pay card for it (customer must still tap to pay).",
    input_schema: {
      type: "object",
      properties: { bundle_code: { type: "string", description: "Bundle code from the catalogue, e.g. W5" } },
      required: ["bundle_code"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "start_airtime_purchase",
    description: "Start buying airtime. Pass the amount if the customer said one, otherwise 0 to show amount options.",
    input_schema: {
      type: "object",
      properties: { amount: { type: "integer", description: "Amount in local currency, 0 if not stated" } },
      required: ["amount"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "find_nearest_outlets",
    description:
      "Recommend the nearest outlets. If the customer already said where they are (town, area, district, landmark), pass it as area and the outlets are sent directly; otherwise pass an empty area and they're asked to type their town or share their location. purpose 'agent' = top-ups and mobile money deposits/withdrawals; 'service_centre' = SIM replacement, device support; 'any' otherwise.",
    input_schema: {
      type: "object",
      properties: {
        purpose: { type: "string", enum: ["agent", "service_centre", "any"] },
        area: { type: "string", description: "Where the customer is, in their words (e.g. 'Lira', 'near Gulu main market'). Empty string if unknown." },
      },
      required: ["purpose", "area"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "report_failed_transaction",
    description:
      "Raise a finance ticket for ANY failed or stuck transaction: mobile money (sending money, money not received, paying bills/merchants, withdrawals, deposits, reversals, sent to wrong number), or airtime/bundle purchases, or money deducted without value. Pass the type if clear (else 'unknown') and the transaction ID/reference if the customer already gave one (else an empty string); the bot asks for whatever is missing.",
    input_schema: {
      type: "object",
      properties: {
        transaction_type: {
          type: "string",
          enum: ["send_money", "receive_money", "bill_payment", "withdrawal", "deposit", "airtime_or_bundle", "other", "unknown"],
        },
        transaction_id: { type: "string" },
      },
      required: ["transaction_type", "transaction_id"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "resolve_conversation",
    description:
      "Close this chat as resolved by the bot. Use ONLY when you fully answered a simple inquiry (prices, codes, how-to, hours, locations) AND the customer signals they are done (e.g. 'thanks', 'ok', 'that's all', 'webale', 'asante'). Never use for complaints, failed transactions, account problems or anything you handed to an agent. The customer then receives a short satisfaction survey.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One line: what the customer asked and what you answered" },
        category: { type: "string", enum: ["inquiry", "bundles", "mobile_money", "network", "sim", "billing", "other"] },
      },
      required: ["summary", "category"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "sim_replacement_help",
    description: "Customer's SIM is damaged or needs replacing (NOT lost/stolen). Sends service-centre instructions (original National ID) with a nearest-centre button.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "report_lost_or_stolen",
    description:
      "Customer's phone or SIM was lost or stolen. Asks for the affected number and whether to block the line (and mobile money wallet), then raises an urgent ticket for the team to block it. Pass what the customer already said; use empty string / \"ask\" when unknown.",
    input_schema: {
      type: "object",
      properties: {
        number: { type: "string", description: "The lost/stolen line, e.g. 0724123456. Empty string if not given yet." },
        block: { type: "string", enum: ["both", "line", "none", "ask"], description: "both = block line and wallet; line = line only; none = don't block; ask = not stated yet" },
      },
      required: ["number", "block"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "show_promos",
    description: "Customer asks about promotions, offers or promo bundles.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "track_or_order_delivery",
    description: "Show the customer's SIM/eSIM/device deliveries and let them order a new SIM or eSIM delivery.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "handoff_to_agent",
    description:
      "Transfer the conversation to a human support agent. Use for refunds, fraud, unresolved technical issues, complaints, or when asked.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One line for the agent: what the customer needs" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        category: {
          type: "string",
          enum: ["recharge", "payment", "network", "sim", "delivery", "billing", "account", "fraud", "other"],
        },
      },
      required: ["reason", "priority", "category"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export type BotToolCall = { name: string; input: Record<string, unknown> };

export interface AgentTurn {
  /** Text Claude wants to send before any tool runs. */
  text: string;
  tools: BotToolCall[];
}

/**
 * One fast Claude call per customer message. Tools here are "actions" that send
 * WhatsApp UI themselves, so we execute them and stop: no second round-trip.
 */
export async function runAgent(mvno: Mvno, contact: Contact, history: Message[], attachments: AiAttachment[] = []): Promise<AgentTurn | null> {
  const c = claude();
  if (!c) return null;
  const messages = toTurns(history);
  if (!messages.length || messages[messages.length - 1].role !== "user") return null;
  if (attachments.length) {
    // Show the customer's photo/PDF with their latest message.
    const last = messages[messages.length - 1];
    const text = typeof last.content === "string" ? last.content : "";
    last.content = [
      ...attachments.map((a) =>
        a.kind === "image"
          ? ({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } } as Anthropic.Beta.BetaImageBlockParam)
          : ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } } as Anthropic.Beta.BetaRequestDocumentBlock),
      ),
      { type: "text", text: /^\[(image|document)\]$/.test(text.trim()) ? "(The customer sent this with no message.)" : text },
    ];
  }

  const response = await c.beta.messages.create({
    model: MODEL,
    max_tokens: 2048,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: [
      { type: "text", text: await stableSystem(mvno), cache_control: { type: "ephemeral" } },
      { type: "text", text: await turnContext(mvno, contact, history) },
    ],
    tools: toolsFor(mvno, await hasOffices(mvno.id)),
    tool_choice: { type: "auto" },
    messages,
  });

  await recordAiUsage(response, { kind: "bot_reply", mvnoId: mvno.id, conversationId: history[0]?.conversation_id });
  if (response.stop_reason === "refusal") {
    return { text: "", tools: [{ name: "handoff_to_agent", input: { reason: "Bot could not answer", priority: "normal", category: "other" } }] };
  }

  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const tools = response.content
    .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
    .map((b) => ({ name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
  return { text, tools };
}

// ------------------------------------------------------------------ tools for general tenants

const GENERAL_EXTRA_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "request_appointment",
    description: "Start an appointment request: the bot asks for the service, preferred dates and full name, then creates a ticket an officer confirms.",
    input_schema: { type: "object", properties: { service: { type: "string", description: "The service if the customer already said it, else empty string." } }, required: ["service"], additionalProperties: false },
    strict: true,
  },
  {
    name: "emergency_help",
    description: "Urgent help: sends the emergency contact details immediately and alerts the duty officers. Use for anyone in danger, arrested, injured, in hospital, or with lost/stolen documents while travelling.",
    input_schema: { type: "object", properties: { summary: { type: "string", description: "One line: what happened and where, from what the customer said." } }, required: ["summary"], additionalProperties: false },
    strict: true,
  },
  {
    name: "check_national_id",
    description: "Check whether the customer's National ID card has arrived, in the uploaded register of received cards. Only the customer's own name is checked; the system replies.",
    input_schema: {
      type: "object",
      properties: { full_name: { type: "string", description: "The customer's full name as they gave it, else empty string (the system then asks for it)." } },
      required: ["full_name"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "show_offices",
    description: "Send the office address(es), opening hours, phone and a map pin.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
];

const ANSWER_FROM_KB: Anthropic.Beta.BetaTool = {
  name: "answer_from_kb",
  description: "Send a factual answer taken from ONE knowledge base article. The system appends that article's source link and last-verified date.",
  input_schema: {
    type: "object",
    properties: {
      article_id: { type: "string", description: "The id in [brackets] of the article the answer comes from." },
      answer: { type: "string", description: "The answer for WhatsApp (1–6 short lines), using only facts from that article. No sources or dates." },
    },
    required: ["article_id", "answer"],
    additionalProperties: false,
  },
  strict: true,
};

/** Tools a tenant's bot may use. */
const officesCache = new Map<string, { at: number; has: boolean }>();
/** Whether the tenant lists any offices in Locations (cached for a minute). */
export async function hasOffices(mvnoId: string) {
  const hit = officesCache.get(mvnoId);
  if (hit && Date.now() - hit.at < 60_000) return hit.has;
  const { count } = await supabaseAdmin().from("outlets").select("id", { count: "exact", head: true }).eq("mvno_id", mvnoId);
  officesCache.set(mvnoId, { at: Date.now(), has: !!count });
  return !!count;
}

function toolsFor(mvno: Mvno, offices = true) {
  if (mvno.kind === "general") {
    const keep = new Set(["show_main_menu", "handoff_to_agent", "resolve_conversation"]);
    // No offices in Locations: address and hours come from the knowledge base instead.
    const extra = GENERAL_EXTRA_TOOLS.filter((t) => offices || t.name !== "show_offices");
    return [...BOT_TOOLS.filter((t) => keep.has(t.name)), ...extra, ...(mvno.strict_sources ? [ANSWER_FROM_KB] : [])];
  }
  return BOT_TOOLS.filter(
    (t) =>
      (mvno.sim_delivery || t.name !== "track_or_order_delivery") &&
      // No billing connection: the bot can't read accounts, so don't let it offer to.
      (hasRealBilling(mvno.slug) || (t.name !== "check_balance" && t.name !== "check_line_status")),
  );
}

// ------------------------------------------------------------------ agent assist

const Triage = z.object({
  subject: z.string().describe("Ticket title, max 8 words"),
  summary: z.string().describe("2-3 sentences for the agent: issue, what was tried, what the customer wants. Include references/amounts."),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  category: z.enum(["recharge", "payment", "network", "sim", "delivery", "billing", "account", "fraud", "other"]),
  priority: z.enum(["low", "normal", "high", "urgent"]),
});
export type TriageResult = z.infer<typeof Triage>;

function transcript(history: Message[]) {
  return history
    .filter((m) => m.body)
    .map((m) => {
      const who = m.is_internal ? "NOTE" : m.direction === "in" ? "CUSTOMER" : m.sender_type.toUpperCase();
      return `${who}: ${m.body}`;
    })
    .join("\n");
}

export async function triage(history: Message[], kind: AiKind = "triage"): Promise<TriageResult | null> {
  const c = claude();
  if (!c) return null;
  const res = await c.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    output_config: { effort: "low", format: zodOutputFormat(Triage) },
    system: "You triage telecom customer-care WhatsApp conversations for human agents. Be factual and terse.",
    messages: [{ role: "user", content: `Conversation so far:\n\n${transcript(history)}` }],
  });
  await recordAiUsage(res, { kind, mvnoId: history[0]?.mvno_id, conversationId: history[0]?.conversation_id });
  return res.parsed_output ?? null;
}

export async function suggestReply(mvno: Mvno, contact: Contact, history: Message[], agentName: string, instruction?: string) {
  const c = claude();
  if (!c) return null;
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 2048,
    output_config: { effort: "low" },
    system: [
      { type: "text", text: await stableSystem(mvno), cache_control: { type: "ephemeral" } },
      {
        type: "text",
        text: `${await turnContext(mvno, contact, history)}\nYou are now drafting the next WhatsApp reply for the human agent ${agentName}, written in first person as ${agentName}. Output only the message text.`,
      },
    ],
    messages: [
      {
        role: "user",
        content: `Conversation:\n\n${transcript(history)}\n\n${instruction ? `Agent's instruction: ${instruction}\n\n` : ""}Draft the next reply.`,
      },
    ],
  });
  await recordAiUsage(res, { kind: "draft", mvnoId: mvno.id, conversationId: history[0]?.conversation_id });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ------------------------------------------------------------------ nearest outlet without GPS

const OutletPick = z.object({
  ids: z.array(z.string()).describe("Up to 3 outlet ids from the list, closest first. Empty if none is reasonably close (same region)."),
  place: z.string().describe("Short name of the customer's town/area as you understood it, e.g. 'Lira'"),
});

/**
 * Picks the outlets closest to a place the customer described (or a GPS point), using
 * general knowledge of Ugandan geography. Only ever returns ids from the given list.
 */
export async function pickOutletsNear(
  mvnoId: string,
  where: string,
  outlets: { id: string; name: string; address: string }[],
): Promise<{ ids: string[]; place: string } | null> {
  const c = claude();
  if (!c || !outlets.length) return null;
  const res = await c.messages.parse({
    model: MODEL,
    max_tokens: 1024,
    output_config: { effort: "low", format: zodOutputFormat(OutletPick) },
    system:
      "You match a customer's location in Uganda to the nearest outlets from a fixed list. Use real Ugandan geography (towns, districts, distances, main roads). Only return ids that appear in the list. Prefer the same town, then the nearest town by road.",
    messages: [
      {
        role: "user",
        content: `Customer location: ${where.slice(0, 200)}\n\nOutlets (id | name | address):\n${outlets
          .slice(0, 400)
          .map((o) => `${o.id} | ${o.name} | ${o.address}`)
          .join("\n")}`,
      },
    ],
  });
  await recordAiUsage(res, { kind: "bot_reply", mvnoId });
  const out = res.parsed_output;
  if (!out) return null;
  const valid = new Set(outlets.map((o) => o.id));
  return { ids: out.ids.filter((id) => valid.has(id)).slice(0, 3), place: out.place };
}
