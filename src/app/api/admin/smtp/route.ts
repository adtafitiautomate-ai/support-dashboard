import { connection } from "next/server";
import { z } from "zod";
import { errorResponse, HttpError } from "@/lib/inbox/auth";
import { requirePlatformAdmin } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { forgetSmtp, getSmtpSettings, renderEmail, sendMail } from "@/lib/mail";
import { audit, enforce, LIMITS } from "@/lib/security";

/** Current SMTP settings for the admin form. The password is never returned. */
export async function GET() {
  await connection();
  try {
    await requirePlatformAdmin();
    const s = await getSmtpSettings();
    if (!s) return Response.json({ configured: false });
    const { password, ...rest } = s;
    return Response.json({ configured: true, ...rest, has_password: !!password });
  } catch (e) {
    return errorResponse(e);
  }
}

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    host: z.string().trim().min(3).max(200),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    username: z.string().trim().max(200).optional(),
    password: z.string().max(500).optional(), // omitted = keep the stored password
    from_email: z.email(),
    from_name: z.string().trim().max(80).optional(),
    enabled: z.boolean(),
  }),
  z.object({ action: z.literal("test"), to: z.email() }),
  z.object({ action: z.literal("remove") }),
]);

export async function POST(req: Request) {
  try {
    const { profile } = await requirePlatformAdmin();
    await enforce(`admin:${profile.id}`, LIMITS.admin);
    const body = Body.parse(await req.json());

    if (body.action === "save") {
      const { action: _a, password, ...settings } = body;
      void _a;
      const payload: Record<string, unknown> = { ...settings };
      if (password) payload.password = password;
      const { error } = await supabaseAdmin().rpc("set_smtp_settings", { p: payload });
      if (error) throw error;
      forgetSmtp();
      await audit(profile, "email.smtp_updated", { target: `${body.host}:${body.port}`, details: { from: body.from_email, enabled: body.enabled, password_changed: !!password } });
      return Response.json({ ok: true });
    }

    if (body.action === "remove") {
      // Deletes host, username and password; emails stop until new settings are saved.
      const { error } = await supabaseAdmin().rpc("clear_smtp_settings");
      if (error) throw error;
      forgetSmtp();
      await audit(profile, "email.smtp_removed");
      return Response.json({ ok: true });
    }

    forgetSmtp();
    const err = await sendMail(
      [body.to],
      "Tuongee test email",
      renderEmail({
        title: "Email notifications are working",
        intro: `This test was sent by ${profile.full_name} from Tuongee Admin. Failed-transaction and waiting-customer alerts will arrive like this.`,
      }),
    );
    await audit(profile, "email.test_sent", { target: body.to, details: { ok: !err, error: err } });
    if (err) throw new HttpError(502, `Could not send: ${err}`);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
