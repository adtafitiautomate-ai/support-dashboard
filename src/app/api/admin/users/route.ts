import { z } from "zod";
import { errorResponse, HttpError } from "@/lib/inbox/auth";
import { requirePlatformAdmin, tempPassword } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { toLoginEmail } from "@/lib/login";
import { contactEmailOf, mailCredentials, setContactEmail } from "@/lib/credentials-mail";
import { audit, enforce, LIMITS } from "@/lib/security";

const Role = z.enum(["admin", "supervisor", "agent"]);

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    // Real email, or a username (letters, digits, . _ -) mapped to an internal address.
    email: z
      .string()
      .trim()
      .toLowerCase()
      .refine((v) => (v.includes("@") ? z.email().safeParse(v).success : /^[a-z0-9._-]{3,32}$/.test(v)), "Enter an email, or a username of 3–32 letters/digits")
      .transform(toLoginEmail),
    full_name: z.string().trim().min(2).max(80),
    password: z.string().min(10).max(72).optional(), // omitted → generated
    mvno_id: z.guid().optional(),
    role: Role.default("agent"),
    platform_admin: z.boolean().default(false),
    contact_email: z.email("Enter a valid email address").trim().toLowerCase(), // where the login details are sent
  }),
  z.object({ action: z.literal("set_email"), user_id: z.guid(), email: z.email("Enter a valid email address").trim().toLowerCase() }),
  z.object({ action: z.literal("set_membership"), user_id: z.guid(), mvno_id: z.guid(), role: Role.nullable() }), // null removes
  z.object({ action: z.literal("reset_password"), user_id: z.guid(), password: z.string().min(10).max(72).optional() }),
  z.object({ action: z.literal("set_disabled"), user_id: z.guid(), disabled: z.boolean() }),
  z.object({ action: z.literal("delete"), user_id: z.guid() }),
  z.object({ action: z.literal("set_platform_admin"), user_id: z.guid(), value: z.boolean() }),
  z.object({ action: z.literal("rename"), user_id: z.guid(), full_name: z.string().trim().min(2).max(80) }),
]);

export async function POST(req: Request) {
  try {
    const { profile: me } = await requirePlatformAdmin();
    const body = Body.parse(await req.json());
    const db = supabaseAdmin();
    await enforce(`admin:${me.id}`, LIMITS.admin);
    const nameOf = async (id: string) => (await db.from("profiles").select("full_name").eq("id", id).maybeSingle()).data?.full_name ?? id;

    switch (body.action) {
      case "create": {
        const password = body.password ?? tempPassword();
        // Invite-only: the database rejects any new account whose email isn't on the invite list.
        const { error: inviteErr } = await db.rpc("allow_signup", { p_email: body.email });
        if (inviteErr) throw inviteErr;
        const { data, error } = await db.auth.admin.createUser({
          email: body.email.toLowerCase(),
          password,
          email_confirm: true,
          user_metadata: { full_name: body.full_name },
          app_metadata: { invited: true, contact_email: body.contact_email }, // invited: passes the invite-only sign-up guard
        });
        if (error) throw new HttpError(error.status === 422 ? 409 : 400, error.message.includes("already") ? "A user with that email already exists" : error.message);
        const id = data.user.id;
        // Profile row is created by the auth trigger; make sure name/admin flag are set.
        await db.from("profiles").upsert({ id, full_name: body.full_name, is_platform_admin: body.platform_admin });
        if (body.mvno_id) await db.from("mvno_members").upsert({ mvno_id: body.mvno_id, user_id: id, role: body.role });
        const mvnoName = body.mvno_id ? (await db.from("mvnos").select("name").eq("id", body.mvno_id).maybeSingle()).data?.name : undefined;
        const mailError = await mailCredentials({ to: body.contact_email, name: body.full_name, login: data.user.email ?? body.email, password, kind: "welcome", mvnoName, mvnoId: body.mvno_id });
        await audit(me, "user.created", { target: body.full_name, mvnoId: body.mvno_id ?? null, details: { login: data.user.email, role: body.role, super_admin: body.platform_admin, emailed: !mailError } });
        return Response.json({ user_id: id, email: data.user.email, password, emailed_to: mailError ? null : body.contact_email, email_error: mailError });
      }
      case "set_membership": {
        if (body.role === null) {
          await db.from("mvno_members").delete().eq("mvno_id", body.mvno_id).eq("user_id", body.user_id);
        } else {
          const { error } = await db.from("mvno_members").upsert({ mvno_id: body.mvno_id, user_id: body.user_id, role: body.role });
          if (error) throw error;
        }
        await audit(me, body.role === null ? "user.access_removed" : "user.role_set", { target: await nameOf(body.user_id), mvnoId: body.mvno_id, details: { role: body.role } });
        return Response.json({ ok: true });
      }
      case "reset_password": {
        const password = body.password ?? tempPassword();
        const { data: u, error } = await db.auth.admin.updateUserById(body.user_id, { password });
        if (error) throw error;
        const name = await nameOf(body.user_id);
        const to = contactEmailOf(u.user);
        // A user of exactly one tenant hears from that tenant's mail server; others from the system one.
        const { data: tenants } = await db.from("mvno_members").select("mvno_id").eq("user_id", body.user_id);
        const mailError = await mailCredentials({ to, name, login: u.user.email ?? "", password, kind: "reset", mvnoId: tenants?.length === 1 ? tenants[0].mvno_id : null });
        await audit(me, "user.password_reset", { target: name, details: { emailed: !mailError } });
        return Response.json({ password, emailed_to: mailError ? null : to, email_error: mailError });
      }
      case "delete": {
        if (body.user_id === me.id) throw new HttpError(400, "You can't delete your own account");
        // Only disabled accounts can be deleted. Their chats, notes and tickets stay (unlinked).
        const { data: u } = await db.auth.admin.getUserById(body.user_id);
        if (!u.user?.banned_until || new Date(u.user.banned_until) < new Date()) throw new HttpError(400, "Disable the account first, then delete it");
        const name = await nameOf(body.user_id);
        const { error } = await db.auth.admin.deleteUser(body.user_id);
        if (error) throw error;
        await audit(me, "user.deleted", { target: name, details: { login: u.user.email } });
        return Response.json({ ok: true });
      }
      case "set_email": {
        await setContactEmail(body.user_id, body.email);
        await audit(me, "user.email_set", { target: await nameOf(body.user_id), details: { email: body.email } });
        return Response.json({ ok: true });
      }
      case "set_disabled": {
        if (body.user_id === me.id) throw new HttpError(400, "You can't disable your own account");
        const { error } = await db.auth.admin.updateUserById(body.user_id, { ban_duration: body.disabled ? "876000h" : "none" });
        if (error) throw error;
        if (body.disabled) {
          // The ban blocks sign-in and session refresh, so any open session ends when its
          // access token expires (<= 1 hour). Also stop routing chats to them right away.
          await db.from("profiles").update({ status: "offline" }).eq("id", body.user_id);
        }
        await audit(me, body.disabled ? "user.disabled" : "user.enabled", { target: await nameOf(body.user_id) });
        return Response.json({ ok: true });
      }
      case "set_platform_admin": {
        if (body.user_id === me.id && !body.value) throw new HttpError(400, "You can't remove your own super admin access");
        await db.from("profiles").update({ is_platform_admin: body.value }).eq("id", body.user_id);
        await audit(me, body.value ? "user.super_admin_granted" : "user.super_admin_removed", { target: await nameOf(body.user_id) });
        return Response.json({ ok: true });
      }
      case "rename": {
        const before = await nameOf(body.user_id);
        await db.from("profiles").update({ full_name: body.full_name }).eq("id", body.user_id);
        await db.auth.admin.updateUserById(body.user_id, { user_metadata: { full_name: body.full_name } });
        await audit(me, "user.renamed", { target: body.full_name, details: { from: before } });
        return Response.json({ ok: true });
      }
    }
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
