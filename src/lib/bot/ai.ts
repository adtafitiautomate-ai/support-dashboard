import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Contact, KbArticle, Message, Mvno } from "@/lib/types";
import { recordAiUsage, type AiKind } from "@/lib/ai-usage";

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
async function knowledgeBase(mvnoId: string) {
  const hit = kbCache.get(mvnoId);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const { data } = await supabaseAdmin().from("kb_articles").select("id,title,body,tags").eq("mvno_id", mvnoId).order("title").limit(2000);
  const articles = (data ?? []) as KbArticle[];
  const size = articles.reduce((n, a) => n + a.title.length + a.body.length, 0);
  const entry = { at: Date.now(), articles: size <= INLINE_KB_CHARS ? articles : [], inline: size <= INLINE_KB_CHARS };
  kbCache.set(mvnoId, entry);
  return entry;
}

async function retrieveKb(mvnoId: string, history: Message[]) {
  const query = history
    .filter((m) => m.direction === "in" && m.body)
    .slice(-3)
    .map((m) => m.body)
    .join(" ");
  if (!query.trim()) return [];
  const { data } = await supabaseAdmin().rpc("search_kb", { p_mvno: mvnoId, p_query: query, p_limit: 8 });
  return (data ?? []) as KbArticle[];
}

const formatKb = (articles: Pick<KbArticle, "title" | "body">[]) => articles.map((a) => `## ${a.title}\n${a.body}`).join("\n\n");

/** Volatile per-turn context: customer facts plus retrieved articles when the KB is large. */
async function turnContext(mvno: Mvno, contact: Contact, history: Message[]) {
  const kb = await knowledgeBase(mvno.id);
  if (kb.inline) return customerContext(mvno, contact);
  const found = await retrieveKb(mvno.id, history);
  return `${customerContext(mvno, contact)}\n\nRelevant knowledge base articles for this conversation:\n${found.length ? formatKb(found) : "(none matched: if unsure, hand over to an agent)"}`;
}

/** Stable per-MVNO system prompt: identical bytes across requests so it caches. */
async function stableSystem(mvno: Mvno) {
  const kb = await knowledgeBase(mvno.id);
  return `You are ${mvno.bot_name}, the WhatsApp customer care assistant for ${mvno.name}, a mobile network (MVNO).
Brand voice: ${mvno.bot_persona}

How to reply:
- This is WhatsApp. Keep replies short (1–4 short lines), friendly and specific. Use *bold* sparingly, no markdown headings or tables.
- Reply in the customer's language (e.g. Luganda, Runyankole/Rukiga, Swahili or English) if they write that way.
- Prefer tools over describing steps: if the customer wants to buy, check, find or track something, call the matching tool. The tools send interactive WhatsApp messages themselves, so don't repeat their content.
- Money is only moved after the customer taps a confirmation button. Never claim a payment, refund or change on their account happened unless a tool result says so.
- Always try to answer the question itself first. General questions ("what services do you offer?", "do you have other services?", "tell me about you") get a short summary from the knowledge base, not the menu.
- Answer from the knowledge base below. If it doesn't cover the question, or the customer is upset, asks for a human, reports fraud/lost phone, needs a refund, or you're unsure after one attempt, call handoff_to_agent. Don't make up policies, prices or timelines.
- Never ask for PINs, passwords or full ID numbers. Mobile money is ${mvno.wallet_name}${mvno.wallet_ussd ? ` (${mvno.wallet_ussd})` : ""}; prices are in ${mvno.currency}.
- Other ways to reach us: ${mvno.care_line ?? "this WhatsApp chat"}.${
    Object.keys(mvno.ussd_codes ?? {}).length
      ? `\n- USSD codes:${mvno.ussd_codes.balance ? ` check balance ${mvno.ussd_codes.balance};` : ""}${mvno.ussd_codes.self_service ? ` buy airtime/bundles or see your own number ${mvno.ussd_codes.self_service};` : ""}${mvno.ussd_codes.promos ? ` promo bundles ${mvno.ussd_codes.promos};` : ""}${mvno.ussd_codes.other_networks ? ` buy from an MTN/Airtel line via ${mvno.ussd_codes.other_networks} (Airtime and Bundles, small fee);` : ""}`
      : ""
  }
- Failed, stuck or deducted transactions of ANY kind (${mvno.wallet_name}: send money, receive money, bill payments, withdrawals, deposits; or airtime/bundles): always call report_failed_transaction. That raises a ticket for finance. Never promise a refund or reversal. Lost or stolen phone/SIM: always call report_lost_or_stolen (pass the number and block choice if the customer already gave them). Damaged SIM or SIM replacement only: call sim_replacement_help (agents cannot replace SIMs).
- When you have fully answered a simple inquiry and the customer says thanks / that's all, call resolve_conversation with a short reply (don't ask "anything else?" again).
- Asking where an agent is: call find_nearest_outlets with purpose "agent". Asking for a service centre: purpose "service_centre".
- eSIM questions: call show_esim_steps (it names the only centre(s) that issue eSIMs).${mvno.sim_delivery ? "" : "\n- We do NOT deliver SIMs or eSIMs. Never offer or mention delivery; SIMs and eSIMs are collected in person."}
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
      "Ask the customer to share their WhatsApp location, then send the nearest outlets. purpose 'agent' = top-ups and mobile money deposits/withdrawals; 'service_centre' = SIM replacement, eSIM, device support; 'any' otherwise.",
    input_schema: {
      type: "object",
      properties: { purpose: { type: "string", enum: ["agent", "service_centre", "any"] } },
      required: ["purpose"],
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
export async function runAgent(mvno: Mvno, contact: Contact, history: Message[]): Promise<AgentTurn | null> {
  const c = claude();
  if (!c) return null;
  const messages = toTurns(history);
  if (!messages.length || messages[messages.length - 1].role !== "user") return null;

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
    tools: mvno.sim_delivery ? BOT_TOOLS : BOT_TOOLS.filter((t) => t.name !== "track_or_order_delivery"),
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
