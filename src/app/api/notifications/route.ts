import { connection } from "next/server";
import { errorResponse, requireAgent } from "@/lib/inbox/auth";

/** GET → my latest reminders (last 3 days) and how many are unread. */
export async function GET() {
  await connection();
  try {
    const { supabase, profile } = await requireAgent();
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const [{ data }, { count }] = await Promise.all([
      supabase.from("notifications").select("id, kind, title, body, conversation_id, created_at, read_at").eq("user_id", profile.id).gte("created_at", since).order("created_at", { ascending: false }).limit(20),
      supabase.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", profile.id).is("read_at", null).gte("created_at", since),
    ]);
    return Response.json({ notifications: data ?? [], unread: count ?? 0 });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST → mark all my reminders read. */
export async function POST() {
  try {
    const { supabase, profile } = await requireAgent();
    await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", profile.id).is("read_at", null);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
