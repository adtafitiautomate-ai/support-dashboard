import { connection } from "next/server";
import { runReminders } from "@/lib/reminders";
import { runAppointmentReminders } from "@/lib/appointment-reminders";

export const maxDuration = 60;

/** Called every 5 minutes by the database scheduler (pg_cron + pg_net). */
export async function POST(req: Request) {
  await connection();
  const secret = process.env.JOBS_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const [waiting, appointments] = await Promise.all([runReminders(), runAppointmentReminders().catch((e) => ({ error: String(e) }))]);
  return Response.json({ ok: true, ...waiting, appointments });
}
