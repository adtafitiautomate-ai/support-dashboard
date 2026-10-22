import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, HttpError, requireMvnoAdmin } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { forgetMvno } from "@/lib/inbox/service";
import { audit } from "@/lib/security";
import { testCalendar } from "@/lib/google-calendar";

/** GET ?mvno= → which service account is connected (never the key). */
export async function GET(req: NextRequest) {
  await connection();
  try {
    const mvnoId = req.nextUrl.searchParams.get("mvno") ?? "";
    await requireMvnoAdmin(mvnoId);
    const { data } = await supabaseAdmin().rpc("get_google_sa", { p_mvno: mvnoId });
    return Response.json({ serviceAccount: (data as { client_email?: string } | null)?.client_email ?? null });
  } catch (e) {
    return errorResponse(e);
  }
}

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    mvnoId: z.guid(),
    calendarId: z.string().trim().max(300).nullable(),
    minutes: z.number().int().min(5).max(480),
    templateName: z.string().trim().max(512).nullable(),
    templateLang: z.string().trim().max(20).default("en"),
    serviceAccountJson: z.string().max(10_000).optional(), // only when replacing the key
  }),
  z.object({ action: z.literal("test"), mvnoId: z.guid() }),
]);

/** POST save | test (tenant admins). */
export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const { profile } = await requireMvnoAdmin(body.mvnoId);
    const db = supabaseAdmin();
    if (body.action === "test") return Response.json(await testCalendar(body.mvnoId));

    if (body.serviceAccountJson?.trim()) {
      let sa: { client_email?: string; private_key?: string; type?: string };
      try {
        sa = JSON.parse(body.serviceAccountJson);
      } catch {
        throw new HttpError(400, "The key file isn't valid JSON: upload the .json file Google gave you");
      }
      if (sa.type !== "service_account" || !sa.client_email || !sa.private_key) throw new HttpError(400, "That isn't a Google service account key (it needs client_email and private_key)");
      const { error } = await db.rpc("set_google_sa", { p_mvno: body.mvnoId, p_sa: { client_email: sa.client_email, private_key: sa.private_key } });
      if (error) throw error;
    }
    const { error } = await db
      .from("mvnos")
      .update({ google_calendar_id: body.calendarId || null, appointment_minutes: body.minutes, reminder_template_name: body.templateName || null, reminder_template_lang: body.templateLang || "en" })
      .eq("id", body.mvnoId);
    if (error) throw error;
    forgetMvno(body.mvnoId);
    await audit(profile, "calendar.settings_saved", { mvnoId: body.mvnoId, details: { calendar: !!body.calendarId, key_replaced: !!body.serviceAccountJson } });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
