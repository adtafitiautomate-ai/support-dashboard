import { connection, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/inbox/auth";
import { requirePlatformAdmin } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase/admin";

type Row = { day: string; mvno_id: string | null; kind: string; model: string; calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };

// Optional prices (USD per million tokens) for a cost estimate. Cache reads bill at 0.1× input, cache writes at 1.25×.
const PRICE_IN = Number(process.env.AI_PRICE_INPUT_PER_MTOK) || 0;
const PRICE_OUT = Number(process.env.AI_PRICE_OUTPUT_PER_MTOK) || 0;
const cost = (r: Pick<Row, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens">) =>
  PRICE_IN || PRICE_OUT
    ? (Number(r.input_tokens) * PRICE_IN + Number(r.cache_read_tokens) * PRICE_IN * 0.1 + Number(r.cache_write_tokens) * PRICE_IN * 1.25 + Number(r.output_tokens) * PRICE_OUT) / 1e6
    : null;

/** GET /api/admin/ai-usage?days=30 → Claude token usage totals by day, MVNO and purpose. */
export async function GET(req: NextRequest) {
  await connection();
  try {
    await requirePlatformAdmin();
    const days = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get("days")) || 30));
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const { data, error } = await supabaseAdmin().rpc("ai_usage_summary", { p_from: from.toISOString(), p_to: to.toISOString() });
    if (error) throw error;
    const rows = ((data ?? []) as Row[]).map((r) => ({ ...r, cost: cost(r) }));

    const group = (key: (r: Row) => string) => {
      const m = new Map<string, { key: string; calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost: number | null }>();
      for (const r of rows) {
        const k = key(r);
        const g = m.get(k) ?? { key: k, calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost: null };
        g.calls += Number(r.calls);
        g.input_tokens += Number(r.input_tokens);
        g.output_tokens += Number(r.output_tokens);
        g.cache_read_tokens += Number(r.cache_read_tokens);
        g.cache_write_tokens += Number(r.cache_write_tokens);
        if (r.cost !== null) g.cost = (g.cost ?? 0) + r.cost;
        m.set(k, g);
      }
      return [...m.values()];
    };

    const [total] = group(() => "all");
    return Response.json({
      days,
      priced: !!(PRICE_IN || PRICE_OUT),
      total: total ?? { key: "all", calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost: null },
      byMvno: group((r) => r.mvno_id ?? "none").sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens)),
      byKind: group((r) => r.kind).sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens)),
      byModel: group((r) => r.model),
      byDay: group((r) => String(r.day)).sort((a, b) => a.key.localeCompare(b.key)),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
