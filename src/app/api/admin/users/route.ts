import { z } from "zod";
import { errorResponse, HttpError } from "@/lib/inbox/auth";
import { requirePlatformAdmin, tempPassword } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { toLoginEmail } from "@/lib/login";

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
  }),
  z.object({ action: z.literal("set_membership"), user_id: z.guid(), mvno_id: z.guid(), role: Role.nullable() }), // null removes
  z.object({ action: z.literal("reset_password"), user_id: z.guid(), password: z.string().min(10).max(72).optional() }),
  z.object({ action: z.literal("set_disabled"), user_id: z.guid(), disabled: z.boolean() }),
  z.object({ action: z.literal("set_platform_admin"), user_id: z.guid(), value: z.boolean() }),
  z.object({ action: z.literal("rename"), user_id: z.guid(), full_name: z.string().trim().min(2).max(80) }),
]);

export async function POST(req: Request) {
  try {
    const { profile: me } = await requirePlatformAdmin();
    const body = Body.parse(await req.json());
    const db = supabaseAdmin();

    switch (body.action) {
      case "create": {
        const password = body.password ?? tempPassword();
        const { data, error } = await db.auth.admin.createUser({
          email: body.email.toLowerCase(),
          password,
          email_confirm: true,
          user_metadata: { full_name: body.full_name },
        });
        if (error) throw new HttpError(error.status === 422 ? 409 : 400, error.message.includes("already") ? "A user with that email already exists" : error.message);
        const id = data.user.id;
        // Profile row is created by the auth trigger; make sure name/admin flag are set.
        await db.from("profiles").upsert({ id, full_name: body.full_name, is_platform_admin: body.platform_admin });
        if (body.mvno_id) await db.from("mvno_members").upsert({ mvno_id: body.mvno_id, user_id: id, role: body.role });
        return Response.json({ user_id: id, email: data.user.email, password });
      }
      case "set_membership": {
        if (body.role === null) {
          await db.from("mvno_members").delete().eq("mvno_id", body.mvno_id).eq("user_id", body.user_id);
        } else {
          const { error } = await db.from("mvno_members").upsert({ mvno_id: body.mvno_id, user_id: body.user_id, role: body.role });
          if (error) throw error;
        }
        return Response.json({ ok: true });
      }
      case "reset_password": {
        const password = body.password ?? tempPassword();
        const { error } = await db.auth.admin.updateUserById(body.user_id, { password });
        if (error) throw error;
        return Response.json({ password });
      }
      case "set_disabled": {
        if (body.user_id === me.id) throw new HttpError(400, "You can't disable your own account");
        const { error } = await db.auth.admin.updateUserById(body.user_id, { ban_duration: body.disabled ? "876000h" : "none" });
        if (error) throw error;
        if (body.disabled) {
          // Sign them out everywhere and stop routing chats to them.
          await db.auth.admin.signOut(body.user_id).catch(() => undefined);
          await db.from("profiles").update({ status: "offline" }).eq("id", body.user_id);
        }
        return Response.json({ ok: true });
      }
      case "set_platform_admin": {
        if (body.user_id === me.id && !body.value) throw new HttpError(400, "You can't remove your own super admin access");
        await db.from("profiles").update({ is_platform_admin: body.value }).eq("id", body.user_id);
        return Response.json({ ok: true });
      }
      case "rename": {
        await db.from("profiles").update({ full_name: body.full_name }).eq("id", body.user_id);
        await db.auth.admin.updateUserById(body.user_id, { user_metadata: { full_name: body.full_name } });
        return Response.json({ ok: true });
      }
    }
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
