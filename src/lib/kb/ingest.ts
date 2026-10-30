import "server-only";
import dns from "node:dns/promises";
import net from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { claude } from "@/lib/bot/ai";
import { recordAiUsage, withAiScope } from "@/lib/ai-usage";

const MODEL = process.env.BOT_MODEL || "claude-opus-5-5";
const MAX_TEXT = 400_000; // chars kept from any one source
const CHUNK = 80_000; // chars per distillation call

export type SourceInput =
  | { kind: "file"; name: string; mime: string; bytes: Buffer }
  | { kind: "url"; url: string };

const Articles = z.object({
  articles: z.array(
    z.object({
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()),
      source_url: z.string().optional(), // the web page the source names for this topic
    }),
  ),
});
type Article = z.infer<typeof Articles>["articles"][number];

const TELECOM_INTRO = `You are building the knowledge base for a mobile network's customer-care assistant.
Turn the source into self-contained articles the assistant can answer customers from.
- One topic per article (a product, a policy, a how-to, a price list, an FAQ answer...). Title it the way a customer would ask about it.
- Keep every concrete fact: prices, codes (USSD like *100#), steps, eligibility, timelines, contact points. Never invent anything.`;

const generalIntro = (name: string) => `You are building the knowledge base for the WhatsApp assistant of ${name}, which answers questions from the public.
Turn the source into self-contained articles the assistant can answer people from.
- One topic per article (a service, its requirements, fees, steps, opening hours, contacts...). Title it the way a member of the public would ask about it.
- Keep every concrete fact exactly: required documents, fees and currencies, steps, eligibility, processing times, addresses, phone numbers, emails and links. Never invent anything.
- Skip internal or planning material (project notes, checklists of what staff must provide, demo notes): only what the public is told.`;

const DISTILL_RULES = `
- Plain text, concise, steps as numbered lines. 40–250 words each.
- Skip navigation, legal boilerplate, marketing fluff and anything not useful for customer support.
- Write only customer-facing facts. Never mention the source (website, homepage, page, document, product list) and never add notes about doubts, inconsistencies or things "not confirmed". If two facts conflict, keep the more specific one; leave out anything uncertain.
- 1–4 short lowercase tags per article.
- source_url: the official web page the source gives for this article's topic (a full URL, or a domain with its path), copied exactly. Empty string if the source names none. Never invent or guess one.
Return an empty list if nothing is useful.`;

// ------------------------------------------------------------------ public entry

/** Runs after the HTTP response: extract → distill → store, updating the source row's status. */
export async function ingestSource(sourceId: string, mvnoId: string, input: SourceInput) {
  const db = supabaseAdmin();
  try {
    const { data: mvno } = await db.from("mvnos").select("name, kind").eq("id", mvnoId).single();
    const prompt = `${mvno?.kind === "general" ? generalIntro(mvno.name) : TELECOM_INTRO}\n${DISTILL_RULES}`;
    const articles = await withAiScope({ mvnoId, kind: "knowledge" }, () => (input.kind === "url" ? fromUrl(input.url, prompt) : fromFile(input, prompt)));
    if (!articles.length) throw new Error("No usable content found in this source");

    await db.from("kb_articles").delete().eq("source_id", sourceId); // re-ingest replaces
    const { error } = await db.from("kb_articles").insert(
      articles.map((a) => ({
        mvno_id: mvnoId,
        source_id: sourceId,
        title: a.title.slice(0, 200),
        body: a.body,
        tags: a.tags.map((t) => t.toLowerCase().slice(0, 30)).slice(0, 4),
        // Every article cites where it came from (sourced-answers tenants only use cited articles).
        // For a file that is the page it names; else the file name, which staff see but customers never do.
        source_url: input.kind === "url" ? input.url : a.source_url?.trim() || input.name,
        verified_at: new Date().toISOString().slice(0, 10),
      })),
    );
    if (error) throw error;
    await db
      .from("kb_sources")
      .update({ status: "ready", error: null, article_count: articles.length, chars: articles.reduce((n, a) => n + a.body.length, 0) })
      .eq("id", sourceId);
  } catch (e) {
    await db
      .from("kb_sources")
      .update({ status: "failed", error: e instanceof Error ? e.message : String(e) })
      .eq("id", sourceId);
  }
}

// ------------------------------------------------------------------ files

async function fromFile(f: Extract<SourceInput, { kind: "file" }>, prompt: string): Promise<Article[]> {
  const isPdf = f.mime === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    const c = claude();
    if (!c) throw new Error("PDF training needs ANTHROPIC_API_KEY. Upload a .txt/.md export instead, or set the key.");
    return distill([
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.bytes.toString("base64") }, title: f.name },
      { type: "text", text: `Source document: ${f.name}` },
    ], prompt);
  }
  let text = f.bytes.toString("utf8");
  if (f.mime.includes("html") || /\.html?$/i.test(f.name)) text = htmlToText(text).text;
  return fromText(text, f.name, prompt);
}

// ------------------------------------------------------------------ links

async function fromUrl(raw: string, prompt: string): Promise<Article[]> {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http(s) links are supported");
  await assertPublicHost(url.hostname);

  const res = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "TuongeeKnowledgeBot/1.0", Accept: "text/html,text/plain,application/pdf" },
  });
  if (res.status >= 300 && res.status < 400) {
    const next = res.headers.get("location");
    if (!next) throw new Error("Redirect without location");
    return fromUrl(new URL(next, url).toString(), prompt); // re-validates the new host
  }
  if (!res.ok) throw new Error(`Link returned HTTP ${res.status}`);

  const type = res.headers.get("content-type") ?? "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) throw new Error("Page is too large (15 MB max)");
  if (type.includes("pdf")) return fromFile({ kind: "file", name: url.pathname.split("/").pop() || "document.pdf", mime: "application/pdf", bytes: buf }, prompt);

  const { title, text } = type.includes("html") ? htmlToText(buf.toString("utf8")) : { title: url.hostname, text: buf.toString("utf8") };
  return fromText(text, title || url.toString(), prompt);
}

/** Blocks SSRF: refuses hosts that resolve to private, loopback or link-local addresses. */
async function assertPublicHost(hostname: string) {
  const addrs = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  for (const { address } of addrs) {
    if (isPrivate(address)) throw new Error("That link points to a private network address");
  }
}

function isPrivate(ip: string) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivate(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function htmlToText(html: string) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return { title: decodeEntities(title), text };
}

const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');

// ------------------------------------------------------------------ distillation

async function fromText(text: string, name: string, prompt: string): Promise<Article[]> {
  const clean = text.slice(0, MAX_TEXT).trim();
  if (clean.length < 40) return [];
  if (!claude()) return splitHeuristically(clean, name);

  const out: Article[] = [];
  for (let i = 0; i < clean.length; i += CHUNK) {
    out.push(...(await distill([{ type: "text", text: `Source: ${name}\n\n${clean.slice(i, i + CHUNK)}` }], prompt)));
  }
  return out;
}

async function distill(content: Anthropic.ContentBlockParam[], prompt: string): Promise<Article[]> {
  const c = claude()!;
  // Streaming: a long document can yield a lot of articles.
  const stream = c.messages.stream({
    model: MODEL,
    max_tokens: 64_000,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            articles: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  body: { type: "string" },
                  tags: { type: "array", items: { type: "string" } },
                  source_url: { type: "string" },
                },
                required: ["title", "body", "tags", "source_url"],
                additionalProperties: false,
              },
            },
          },
          required: ["articles"],
          additionalProperties: false,
        },
      },
    },
    system: prompt,
    messages: [{ role: "user", content }],
  });
  const msg = await stream.finalMessage();
  await recordAiUsage(msg, { kind: "knowledge" });
  if (msg.stop_reason === "refusal") throw new Error("The AI declined to process this source");
  if (msg.stop_reason === "max_tokens") throw new Error("Source is too large to process in one go. Split it into smaller files.");
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return Articles.parse(JSON.parse(text)).articles.filter((a) => a.title.trim() && a.body.trim());
}

/** No-AI fallback: split on headings / blank-line blocks into ~1,200-char articles. */
function splitHeuristically(text: string, name: string): Article[] {
  const blocks = text.split(/\n(?=#{1,3} )|\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const out: Article[] = [];
  let cur = "";
  const flush = () => {
    if (!cur.trim()) return;
    const first = cur.split("\n")[0].replace(/^#+\s*/, "").trim();
    out.push({ title: first.length <= 100 ? first : `${name} (part ${out.length + 1})`, body: cur.trim(), tags: [] });
    cur = "";
  };
  for (const b of blocks) {
    if (/^#{1,3} /.test(b) || (cur.length + b.length > 1200 && cur)) flush();
    cur += (cur ? "\n\n" : "") + b;
  }
  flush();
  return out.slice(0, 300);
}
