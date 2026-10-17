import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

const G = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0"}`;

export interface TokenStatus {
  source: "mvno" | "environment" | "none";
  valid: boolean;
  expires_at: string | null; // null = never expires (system user)
  app: string | null;
  error?: string;
}

async function debug(token: string) {
  const r = await fetch(`${G}/debug_token?input_token=${encodeURIComponent(token)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const j = (await r.json()) as { data?: { is_valid?: boolean; expires_at?: number; app_id?: string; application?: string }; error?: { message: string } };
  return j;
}

/** Which token an MVNO sends with, and when it expires. */
export async function tokenStatus(mvnoId: string): Promise<TokenStatus> {
  const { data } = await supabaseAdmin().rpc("get_mvno_wa_token", { p_mvno: mvnoId });
  const own = data as string | null;
  const token = own ?? process.env.WHATSAPP_ACCESS_TOKEN ?? null;
  if (!token) return { source: "none", valid: false, expires_at: null, app: null };
  const source = own ? "mvno" : "environment";
  try {
    const j = await debug(token);
    if (!j.data) return { source, valid: false, expires_at: null, app: null, error: j.error?.message ?? "Unknown token" };
    const exp = j.data.expires_at ? new Date(j.data.expires_at * 1000).toISOString() : null;
    return { source, valid: !!j.data.is_valid, expires_at: exp, app: j.data.application ?? null };
  } catch {
    return { source, valid: false, expires_at: null, app: null, error: "Could not reach Meta" };
  }
}

/**
 * Stores a new token for an MVNO. Short-lived tokens (~24h from the dashboard / Graph
 * Explorer) are exchanged for ~60-day tokens using whichever configured app secret
 * belongs to the token's app.
 */
export async function setMvnoToken(mvnoId: string, token: string): Promise<{ expires_at: string | null; exchanged: boolean }> {
  const info = await debug(token);
  if (!info.data?.is_valid || !info.data.app_id) throw new Error(info.error?.message ?? "That token isn't valid");
  let final = token;
  let expires = info.data.expires_at ? info.data.expires_at * 1000 : null;
  let exchanged = false;

  if (expires && expires - Date.now() < 7 * 86_400_000) {
    const secrets = (process.env.WHATSAPP_APP_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const secret of secrets) {
      const r = await fetch(
        `${G}/oauth/access_token?grant_type=fb_exchange_token&client_id=${info.data.app_id}&client_secret=${encodeURIComponent(secret)}&fb_exchange_token=${encodeURIComponent(token)}`,
        { cache: "no-store" },
      );
      const j = (await r.json()) as { access_token?: string };
      if (j.access_token) {
        final = j.access_token;
        const d = await debug(final);
        expires = d.data?.expires_at ? d.data.expires_at * 1000 : null;
        exchanged = true;
        break;
      }
    }
  }

  const { error } = await supabaseAdmin().rpc("set_mvno_wa_token", { p_mvno: mvnoId, p_token: final });
  if (error) throw error;
  return { expires_at: expires ? new Date(expires).toISOString() : null, exchanged };
}
