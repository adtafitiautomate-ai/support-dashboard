import { connection } from "next/server";
import { runReminders } from "@/lib/reminders";

export const maxDuration = 60;

/** Called every 5 minutes by the database scheduler (pg_cron + pg_net). */
export async function POST(req: Request) {
  await connection();
  const secret = process.env.JOBS_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return Response.json({ ok: true, ...(await runReminders()) });
}
