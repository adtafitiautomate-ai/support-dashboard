import { connection } from "next/server";
import { errorResponse } from "@/lib/inbox/auth";
import { requirePlatformAdmin } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Super admin: every MVNO with headline numbers, and every user with email, roles and status. */
export async function GET() {
  await connection();
  try {
    await requirePlatformAdmin();
    const db = supabaseAdmin();

    const [mvnos, profiles, members, convs, authUsers] = await Promise.all([
      db.from("mvnos").select("*").order("name"),
      db.from("profiles").select("id, full_name, is_platform_admin, status, last_seen_at, created_at"),
      db.from("mvno_members").select("mvno_id, user_id, role"),
      db.from("conversations").select("mvno_id, status").neq("status", "resolved"),
      db.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);

    const auth = new Map((authUsers.data?.users ?? []).map((u) => [u.id, u]));
    const users = (profiles.data ?? []).map((p) => {
      const a = auth.get(p.id);
      return {
        ...p,
        email: a?.email ?? "",
        disabled: !!a?.banned_until && new Date(a.banned_until) > new Date(),
        last_sign_in_at: a?.last_sign_in_at ?? null,
        memberships: (members.data ?? []).filter((m) => m.user_id === p.id).map((m) => ({ mvno_id: m.mvno_id, role: m.role })),
      };
    });

    return Response.json({
      mvnos: (mvnos.data ?? []).map((m) => ({
        ...m,
        connected: !!m.wa_phone_number_id && !String(m.wa_phone_number_id).startsWith("SIM-"),
        members: (members.data ?? []).filter((x) => x.mvno_id === m.id).length,
        open: (convs.data ?? []).filter((c) => c.mvno_id === m.id && c.status !== "bot").length,
        with_bot: (convs.data ?? []).filter((c) => c.mvno_id === m.id && c.status === "bot").length,
      })),
      users: users.sort((a, b) => a.full_name.localeCompare(b.full_name)),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
