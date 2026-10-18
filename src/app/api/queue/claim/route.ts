import { errorResponse, requireAgent } from "@/lib/inbox/auth";
import { logEvent } from "@/lib/inbox/service";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Conversation } from "@/lib/types";

/**
 * POST /api/queue/claim: called when an agent comes online. Assigns them the oldest
 * waiting tickets (up to their chat limit, per MVNO) so after-hours requests get followed up.
 */
export async function POST() {
  try {
    const { profile } = await requireAgent();
    if (profile.status !== "online") return Response.json({ claimed: [], waiting: 0 });
    const db = supabaseAdmin();
    const { data: memberships } = await db.from("mvno_members").select("mvno_id, max_concurrent").eq("user_id", profile.id);

    const claimed: Pick<Conversation, "id" | "ticket_no" | "subject" | "followup_reason" | "mvno_id">[] = [];
    let waiting = 0;
    for (const m of memberships ?? []) {
      const { count: load } = await db
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("mvno_id", m.mvno_id)
        .eq("assignee_id", profile.id)
        .in("status", ["open", "pending"]);
      const room = Math.max(0, m.max_concurrent - (load ?? 0));
      const { data: queue, count } = await db
        .from("conversations")
        .select("id, ticket_no, subject, followup_reason, mvno_id", { count: "exact" })
        .eq("mvno_id", m.mvno_id)
        .eq("status", "open")
        .is("assignee_id", null)
        .order("handoff_at", { ascending: true })
        .limit(Math.max(room, 1));
      waiting += count ?? 0;
      for (const c of (queue ?? []).slice(0, room)) {
        // Conditional update: if another agent claimed it a moment earlier, skip it.
        const { data: won } = await db.from("conversations").update({ assignee_id: profile.id }).eq("id", c.id).is("assignee_id", null).select("id, mvno_id").maybeSingle();
        if (!won) continue;
        await logEvent(won, `Assigned to ${profile.full_name} when they came online${c.followup_reason === "after_hours" ? " (arrived after hours)" : ""}`);
        claimed.push(c);
      }
    }
    return Response.json({ claimed, waiting: waiting - claimed.length });
  } catch (e) {
    return errorResponse(e);
  }
}
