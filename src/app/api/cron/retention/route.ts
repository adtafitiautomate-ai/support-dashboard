import { connection } from "next/server";
import { purgeExpired } from "@/lib/privacy";
import { audit } from "@/lib/security";

export const maxDuration = 300;

/** Daily data-retention purge, triggered by Vercel Cron (see vercel.json). */
export async function GET(req: Request) {
  await connection();
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const results = await purgeExpired();
  const total = results.reduce((n, r) => n + r.conversations, 0);
  if (total) await audit(null, "retention.purged", { details: { results } });
  return Response.json({ ok: true, results });
}
