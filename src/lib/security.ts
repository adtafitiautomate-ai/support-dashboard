import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { HttpError } from "@/lib/inbox/auth";
import type { Profile } from "@/lib/types";

/** Limits shared across all server instances (fixed windows in Postgres). */
export const LIMITS = {
  aiDraft: { limit: 40, windowSecs: 600 }, // AI reply drafts per agent / 10 min
  aiSummary: { limit: 30, windowSecs: 600 }, // AI summaries per agent / 10 min
  kbIngest: { limit: 20, windowSecs: 3600 }, // documents/links per user / hour
  reports: { limit: 60, windowSecs: 600 }, // report runs per user / 10 min
  outreach: { limit: 30, windowSecs: 3600 }, // template conversations per user / hour
  escalate: { limit: 20, windowSecs: 3600 }, // escalation emails per user / hour
  admin: { limit: 120, windowSecs: 600 }, // admin console actions / 10 min
  botAiPerCustomer: { limit: 30, windowSecs: 3600 }, // Claude replies per customer / hour
} as const;

export async function allow(key: string, rule: { limit: number; windowSecs: number }) {
  const { data, error } = await supabaseAdmin().rpc("rate_limit_hit", { p_key: key, p_limit: rule.limit, p_window_secs: rule.windowSecs });
  if (error) {
    console.error("rate limit check failed", error);
    return true; // fail open on limiter errors so support keeps working
  }
  return data === true;
}

/** Throws 429 when the caller is over the limit. */
export async function enforce(key: string, rule: { limit: number; windowSecs: number }) {
  if (!(await allow(key, rule))) {
    throw new HttpError(429, `Too many requests. Please wait ${Math.ceil(rule.windowSecs / 60)} minutes and try again.`);
  }
}

/** Append-only record of administrative actions. Never throws. */
export async function audit(
  actor: Pick<Profile, "id" | "full_name"> | null,
  action: string,
  opts: { target?: string; mvnoId?: string | null; details?: Record<string, unknown> } = {},
) {
  const { error } = await supabaseAdmin()
    .from("audit_log")
    .insert({
      actor_id: actor?.id ?? null,
      actor_name: actor?.full_name ?? "system",
      action,
      target: opts.target ?? null,
      mvno_id: opts.mvnoId ?? null,
      details: opts.details ?? {},
    });
  if (error) console.error("audit log write failed", error);
}
