import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type AiKind = "bot_reply" | "triage" | "draft" | "summary" | "knowledge";

type Usage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** Context for calls deep inside helpers (e.g. knowledge ingestion) that don't know their MVNO. */
const scope = new AsyncLocalStorage<{ mvnoId: string | null; conversationId?: string | null; kind?: AiKind }>();
export const withAiScope = <T>(ctx: { mvnoId: string | null; conversationId?: string | null; kind?: AiKind }, fn: () => Promise<T>) => scope.run(ctx, fn);

/** Records one Claude call's token usage. Never throws (awaited so serverless doesn't drop it). */
export async function recordAiUsage(
  res: { model?: string; usage?: Usage | null } | null | undefined,
  ctx: { kind?: AiKind; mvnoId?: string | null; conversationId?: string | null } = {},
) {
  if (!res?.usage) return;
  const s = scope.getStore();
  const u = res.usage;
  await supabaseAdmin()
    .from("ai_usage")
    .insert({
      mvno_id: ctx.mvnoId ?? s?.mvnoId ?? null,
      conversation_id: ctx.conversationId ?? s?.conversationId ?? null,
      kind: ctx.kind ?? s?.kind ?? "bot_reply",
      model: res.model ?? "unknown",
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cache_write_tokens: u.cache_creation_input_tokens ?? 0,
    })
    .then(({ error }) => error && console.error("ai usage log failed", error.message), () => undefined);
}
