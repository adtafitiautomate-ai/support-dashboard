import { connection } from "next/server";
import { autoCloseIdleBotChats, purgeExpired } from "@/lib/privacy";
import { audit } from "@/lib/security";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const maxDuration = 300;

/** Daily housekeeping, triggered by Vercel Cron (see vercel.json): close idle bot chats, then apply retention. */
export async function GET(req: Request) {
  await connection();
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const closed = await autoCloseIdleBotChats();
  await supabaseAdmin().from("email_log").delete().lt("created_at", new Date(Date.now() - 90 * 86_400_000).toISOString());
  const results = await purgeExpired();
  const total = results.reduce((n, r) => n + r.conversations, 0);
  if (total) await audit(null, "retention.purged", { details: { results } });
  return Response.json({ ok: true, closed_idle_bot_chats: closed, retention: results });
}
