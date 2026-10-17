import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, HttpError, requireMvnoAdmin } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tempPassword } from "@/lib/admin";
import { toLoginEmail } from "@/lib/login";
import { audit, enforce, LIMITS } from "@/lib/security";
import type { Profile } from "@/lib/types";

// Team management for MVNO admins: only within MVNOs they administer.

const Role = z.enum(["admin", "supervisor", "agent"]);

/** GET /api/team?mvno=<id> → members of that MVNO with login, role and status. */
export async function GET(req: NextRequest) {
  await connection();
  try {
    const mvnoId = req.nextUrl.searchParams.get("mvno") ?? "";
    await requireMvnoAdmin(mvnoId);
    const db = supabaseAdmin();
    const { data: members } = await db.from("mvno_members").select("user_id, role, profiles(id, full_name, status, is_platform_admin)").eq("mvno_id", mvnoId);
    const { data: auth } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const byId = new Map((auth?.users ?? []).map((u) => [u.id, u]));
    const team = (members ?? []).map((m) => {
      const p = m.profiles as unknown as Pick<Profile, "id" | "full_name" | "status" | "is_platform_admin">;
      const a = byId.get(m.user_id);
      return {
        id: m.user_id,
        full_name: p?.full_name ?? "",
        role: m.role,
        status: p?.status ?? "offline",
        is_platform_admin: !!p?.is_platform_admin,
        email: a?.email ?? "",
        disabled: !!a?.banned_until && new Date(a.banned_until) > new Date(),
        last_sign_in_at: a?.last_sign_in_at ?? null,
      };
    });
    return Response.json({ team: team.sort((a, b) => a.full_name.localeCompare(b.full_name)) });
  } catch (e) {
    return errorResponse(e);
  }
}

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    mvnoId: z.guid(),
    full_name: z.string().trim().min(2).max(80),
    login: z
      .string()
      .trim()
      .toLowerCase()
      .refine((v) => (v.includes("@") ? z.email().safeParse(v).success : /^[a-z0-9._-]{3,32}$/.test(v)), "Enter an email, or a username of 3–32 letters/digits"),
    role: Role,
    password: z.string().min(10).max(72).optional(),
  }),
  z.object({ action: z.literal("set_role"), mvnoId: z.guid(), userId: z.guid(), role: Role }),
  z.object({ action: z.literal("remove"), mvnoId: z.guid(), userId: z.guid() }),
  z.object({ action: z.literal("reset_password"), mvnoId: z.guid(), userId: z.guid() }),
  z.object({ action: z.literal("set_disabled"), mvnoId: z.guid(), userId: z.guid(), disabled: z.boolean() }),
]);

export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const { profile: me, mvno } = await requireMvnoAdmin(body.mvnoId);
    await enforce(`team:${me.id}`, LIMITS.admin);
    const db = supabaseAdmin();

    if (body.action === "create") {
      const email = toLoginEmail(body.login);
      const password = body.password ?? tempPassword();
      const { error: inviteErr } = await db.rpc("allow_signup", { p_email: email });
      if (inviteErr) throw inviteErr;
      const { data, error } = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: body.full_name },
        app_metadata: { invited: true },
      });
      if (error) throw new HttpError(409, /already/i.test(error.message) ? "That username/email is already taken. Choose another, or ask a super admin to add the existing person." : error.message);
      await db.from("profiles").upsert({ id: data.user.id, full_name: body.full_name });
      await db.from("mvno_members").insert({ mvno_id: mvno.id, user_id: data.user.id, role: body.role });
      await audit(me, "user.created", { mvnoId: mvno.id, target: body.full_name, details: { login: email, role: body.role, by: "team" } });
      return Response.json({ login: email, password });
    }

    // Every other action targets an existing member of this MVNO.
    const { data: target } = await db.from("mvno_members").select("role, profiles(full_name, is_platform_admin)").eq("mvno_id", mvno.id).eq("user_id", body.userId).maybeSingle();
    if (!target) throw new HttpError(404, "That person isn't on this team");
    const tp = target.profiles as unknown as { full_name: string; is_platform_admin: boolean };
    if (tp.is_platform_admin && !me.is_platform_admin) throw new HttpError(403, "Super admins can only be changed by a super admin");
    if (body.userId === me.id && body.action !== "reset_password") throw new HttpError(400, "You can't change your own access here");

    // Account-wide actions (password, disable) affect every MVNO the person belongs to:
    // only allowed if the actor administers all of them.
    const accountWide = body.action === "reset_password" || body.action === "set_disabled";
    if (accountWide && !me.is_platform_admin) {
      const { data: theirs } = await db.from("mvno_members").select("mvno_id").eq("user_id", body.userId);
      const { data: mine } = await db.from("mvno_members").select("mvno_id").eq("user_id", me.id).eq("role", "admin");
      const adminOf = new Set((mine ?? []).map((m) => m.mvno_id));
      if ((theirs ?? []).some((m) => !adminOf.has(m.mvno_id))) {
        throw new HttpError(403, "This person also works on another MVNO. Ask a super admin to change their password or account.");
      }
    }

    switch (body.action) {
      case "set_role": {
        await db.from("mvno_members").update({ role: body.role }).eq("mvno_id", mvno.id).eq("user_id", body.userId);
        await audit(me, "user.role_set", { mvnoId: mvno.id, target: tp.full_name, details: { role: body.role, by: "team" } });
        return Response.json({ ok: true });
      }
      case "remove": {
        await db.from("mvno_members").delete().eq("mvno_id", mvno.id).eq("user_id", body.userId);
        await audit(me, "user.access_removed", { mvnoId: mvno.id, target: tp.full_name, details: { by: "team" } });
        return Response.json({ ok: true });
      }
      case "reset_password": {
        const password = tempPassword();
        const { error } = await db.auth.admin.updateUserById(body.userId, { password });
        if (error) throw error;
        await audit(me, "user.password_reset", { mvnoId: mvno.id, target: tp.full_name, details: { by: "team" } });
        return Response.json({ password });
      }
      case "set_disabled": {
        const { error } = await db.auth.admin.updateUserById(body.userId, { ban_duration: body.disabled ? "876000h" : "none" });
        if (error) throw error;
        if (body.disabled) await db.from("profiles").update({ status: "offline" }).eq("id", body.userId);
        await audit(me, body.disabled ? "user.disabled" : "user.enabled", { mvnoId: mvno.id, target: tp.full_name, details: { by: "team" } });
        return Response.json({ ok: true });
      }
    }
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
