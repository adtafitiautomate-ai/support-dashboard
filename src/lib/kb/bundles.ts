import "server-only";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { claude } from "@/lib/bot/ai";
import { recordAiUsage } from "@/lib/ai-usage";

const MODEL = process.env.BOT_MODEL || "claude-opus-5-5";

const Extracted = z.object({
  bundles: z.array(
    z.object({
      name: z.string().describe("Customer-facing name, e.g. 'Ardhi 5' or '80 on-net minutes (weekly)'"),
      category: z.enum(["voice", "data", "combo"]),
      price: z.number().describe("Price in the local currency, digits only"),
      data_mb: z.number().describe("Data in MB (1 GB = 1024 MB); 0 if none"),
      minutes: z.number().describe("Voice minutes; 0 if none"),
      sms: z.number().describe("SMS count; 0 if none"),
      validity_days: z.number().nullable().describe("1 daily, 7 weekly, 30 monthly, 0 = never expires, null = not stated"),
    }),
  ),
});

/**
 * Builds the tenant's bundle list (the tappable "Buy a bundle" menu) from its knowledge
 * articles. The previous list is switched off, not deleted, so old top-up records still resolve.
 */
export async function importBundlesFromKnowledge(mvnoId: string) {
  const c = claude();
  if (!c) throw new Error("AI is not configured");
  const db = supabaseAdmin();
  const { data: articles } = await db.from("kb_articles").select("title, body").eq("mvno_id", mvnoId);
  const relevant = (articles ?? []).filter((a) => /bundle|GB|MB|minutes|mins|data|combo|UGX|price/i.test(a.title + a.body));
  if (!relevant.length) throw new Error("No articles mention bundles or prices yet");

  const res = await c.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: "low", format: zodOutputFormat(Extracted) },
    system:
      "Extract every purchasable mobile bundle (voice, data or combo) with its exact price from these knowledge articles. Only bundles with a stated price. Never invent or estimate values. Promo/limited offers are fine if priced.",
    messages: [{ role: "user", content: relevant.map((a) => `# ${a.title}\n${a.body}`).join("\n\n") }],
  });
  await recordAiUsage(res, { kind: "knowledge", mvnoId });
  const list = (res.parsed_output?.bundles ?? []).filter((b) => b.name.trim() && b.price > 0);
  if (!list.length) throw new Error("Couldn't find any priced bundles in the articles");

  const order = { voice: 0, data: 1, combo: 2 } as const;
  list.sort((a, b) => order[a.category] - order[b.category] || a.price - b.price);
  const code = (name: string, i: number) => `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "B"}${i}`;

  await db.from("bundles").update({ active: false }).eq("mvno_id", mvnoId);
  const { error } = await db.from("bundles").upsert(
    list.map((b, i) => ({
      mvno_id: mvnoId,
      code: code(b.name, i),
      name: b.name.trim().slice(0, 80),
      category: b.category,
      price: b.price,
      data_mb: Math.round(b.data_mb),
      minutes: Math.round(b.minutes),
      sms: Math.round(b.sms),
      validity_days: b.validity_days,
      ussd: null,
      active: true,
      sort: i,
    })),
    { onConflict: "mvno_id,code" },
  );
  if (error) throw error;
  return { count: list.length, byCategory: Object.fromEntries((["voice", "data", "combo"] as const).map((k) => [k, list.filter((b) => b.category === k).length])) };
}

/** Rewrites an article without notes about where facts came from or doubts about them. */
export async function cleanArticle(title: string, body: string) {
  const c = claude();
  if (!c) return null;
  const res = await c.messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low" },
    system:
      "You edit customer-care knowledge articles. Remove every sentence or clause about sources or doubts (e.g. 'the homepage says', 'the product list shows', 'not yet confirmed', 'contact care to confirm', mentions of websites/pages/documents as sources). Keep every concrete fact, price, code and step exactly as written; when two facts conflict, keep the more specific one. Do not add anything. Output only the cleaned article body.",
    messages: [{ role: "user", content: `Title: ${title}\n\n${body}` }],
  });
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
  return text || null;
}
