import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Contact, KbArticle, Message, Mvno } from "@/lib/types";

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
  if (kb.inline) return customerContext(contact);
  const found = await retrieveKb(mvno.id, history);
  return `${customerContext(contact)}\n\nRelevant knowledge base articles for this conversation:\n${found.length ? formatKb(found) : "(none matched: if unsure, hand over to an agent)"}`;
}

/** Stable per-MVNO system prompt: identical bytes across requests so it caches. */
async function stableSystem(mvno: Mvno) {
  const kb = await knowledgeBase(mvno.id);
  return `You are ${mvno.bot_name}, the WhatsApp customer care assistant for ${mvno.name}, a mobile network (MVNO).
Brand voice: ${mvno.bot_persona}

How to reply:
- This is WhatsApp. Keep replies short (1–4 short lines), friendly and specific. Use *bold* sparingly, no markdown headings or tables.
- Reply in the customer's language (e.g. Swahili or Sheng if they write that way).
- Prefer tools over describing steps: if the customer wants to buy, check, find or track something, call the matching tool. The tools send interactive WhatsApp messages themselves, so don't repeat their content.
- Money is only moved after the customer taps a confirmation button. Never claim a payment, refund or change on their account happened unless a tool result says so.
- Answer from the knowledge base below. If it doesn't cover the question, or the customer is upset, asks for a human, reports fraud/lost phone, needs a refund, or you're unsure after one attempt, call handoff_to_agent. Don't make up policies, prices or timelines.
- Never ask for PINs, passwords or full ID numbers.

${kb.inline ? `Knowledge base:\n${formatKb(kb.articles)}` : "Knowledge base: the most relevant articles are provided with each turn below."}`;
}

function customerContext(contact: Contact) {
  return `Customer: ${contact.name ?? "unknown name"}, WhatsApp +${contact.wa_id}, plan ${contact.plan ?? "prepaid"}${
    contact.tags.length ? `, tags: ${contact.tags.join(", ")}` : ""
  }. Their location is ${contact.last_location ? "known" : "unknown"}. Local time: ${new Date().toLocaleString("en-GB", {
    timeZone: "Africa/Nairobi",
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
    description: "Send the interactive main menu. Use when the customer greets you without a request or seems lost.",
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
    description: "Send the interactive list of data/voice bundles with prices so the customer can pick one.",
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
    description: "Find the nearest shops, agents and kiosks. Asks for the customer's location if not known.",
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
      "Transfer the conversation to a human support agent. Use for refunds, fraud, lost/stolen phones, unresolved technical issues, complaints, or when asked.",
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
    tools: BOT_TOOLS,
    tool_choice: { type: "auto" },
    messages,
  });

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

export async function triage(history: Message[]): Promise<TriageResult | null> {
  const c = claude();
  if (!c) return null;
  const res = await c.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    output_config: { effort: "low", format: zodOutputFormat(Triage) },
    system: "You triage telecom customer-care WhatsApp conversations for human agents. Be factual and terse.",
    messages: [{ role: "user", content: `Conversation so far:\n\n${transcript(history)}` }],
  });
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
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
