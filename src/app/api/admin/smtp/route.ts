import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, HttpError } from "@/lib/inbox/auth";
import { requirePlatformAdmin } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { forgetSmtp, getSmtpSettings, getTenantSmtp, renderEmail, sendMail } from "@/lib/mail";
import { audit, enforce, LIMITS } from "@/lib/security";

/**
 * GET → the system SMTP settings, or ?mvno=<id> → that tenant's own server and whether it may
 * use the system one. Passwords are never returned.
 */
export async function GET(req: NextRequest) {
  await connection();
  try {
    await requirePlatformAdmin();
    const mvnoId = req.nextUrl.searchParams.get("mvno");
    const s = mvnoId ? await getTenantSmtp(mvnoId) : await getSmtpSettings();
    const shared = mvnoId ? ((await supabaseAdmin().from("mvnos").select("shared_email").eq("id", mvnoId).maybeSingle()).data?.shared_email ?? false) : undefined;
    if (!s) return Response.json({ configured: false, shared_email: shared });
    const { password, ...rest } = s;
    return Response.json({ configured: true, ...rest, has_password: !!password, shared_email: shared });
  } catch (e) {
    return errorResponse(e);
  }
}

const Scope = { mvnoId: z.guid().nullish() }; // absent = the system server
const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    ...Scope,
    host: z.string().trim().min(3).max(200),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    username: z.string().trim().max(200).optional(),
    password: z.string().max(500).optional(), // omitted = keep the stored password
    from_email: z.email(),
    from_name: z.string().trim().max(80).optional(),
    enabled: z.boolean(),
  }),
  z.object({ action: z.literal("test"), ...Scope, to: z.email() }),
  z.object({ action: z.literal("remove"), ...Scope }),
  z.object({ action: z.literal("shared"), mvnoId: z.guid(), shared: z.boolean() }),
]);

export async function POST(req: Request) {
  try {
    const { profile } = await requirePlatformAdmin();
    await enforce(`admin:${profile.id}`, LIMITS.admin);
    const body = Body.parse(await req.json());
    const db = supabaseAdmin();
    const mvnoId = body.mvnoId ?? null;

    if (body.action === "save") {
      const { action: _a, mvnoId: _m, password, ...settings } = body;
      void _a;
      void _m;
      const payload: Record<string, unknown> = { ...settings };
      if (password) payload.password = password;
      const { error } = mvnoId ? await db.rpc("set_tenant_smtp", { p_mvno: mvnoId, p: payload }) : await db.rpc("set_smtp_settings", { p: payload });
      if (error) throw error;
      forgetSmtp();
      await audit(profile, "email.smtp_updated", { mvnoId, target: `${body.host}:${body.port}`, details: { from: body.from_email, enabled: body.enabled, password_changed: !!password } });
      return Response.json({ ok: true });
    }

    if (body.action === "remove") {
      // Deletes host, username and password; that scope's emails stop (or use the system server, if shared).
      const { error } = mvnoId ? await db.rpc("clear_tenant_smtp", { p_mvno: mvnoId }) : await db.rpc("clear_smtp_settings");
      if (error) throw error;
      forgetSmtp();
      await audit(profile, "email.smtp_removed", { mvnoId });
      return Response.json({ ok: true });
    }

    if (body.action === "shared") {
      const { error } = await db.from("mvnos").update({ shared_email: body.shared }).eq("id", body.mvnoId);
      if (error) throw error;
      forgetSmtp();
      await audit(profile, "email.shared_set", { mvnoId: body.mvnoId, details: { shared: body.shared } });
      return Response.json({ ok: true });
    }

    forgetSmtp();
    const err = await sendMail(
      [body.to],
      "Tuongee test email",
      renderEmail({
        title: "Email notifications are working",
        intro: `This test was sent by ${profile.full_name} from Tuongee Admin. Alerts and notifications will arrive like this.`,
      }),
      { mvnoId },
    );
    await audit(profile, "email.test_sent", { mvnoId, target: body.to, details: { ok: !err, error: err } });
    if (err) throw new HttpError(502, `Could not send: ${err}`);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
