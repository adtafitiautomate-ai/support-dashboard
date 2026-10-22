import { z } from "zod";
import { errorResponse, HttpError } from "@/lib/inbox/auth";
import { requirePlatformAdmin, slugify } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { forgetMvno } from "@/lib/inbox/service";
import { setMvnoToken } from "@/lib/wa-tokens";
import { audit, enforce, LIMITS } from "@/lib/security";
import { DEFAULT_GENERAL_MENU } from "@/lib/menu";

const Fields = z.object({
  name: z.string().trim().min(2).max(60),
  brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#111827"),
  currency: z.string().trim().min(3).max(3).default("UGX"),
  wallet_name: z.string().trim().max(40).default("mobile money"),
  wallet_ussd: z.string().trim().max(20).optional().nullable(),
  care_line: z.string().trim().max(200).optional().nullable(),
  bot_name: z.string().trim().min(1).max(40).default("Assistant"),
  greeting: z.string().trim().max(300).optional(),
  bot_persona: z.string().trim().max(2000).optional(),
  sla_first_response_mins: z.number().int().min(1).max(1440).default(5),
  retention_days: z.number().int().min(30).max(3650).optional(),
  finance_emails: z.array(z.email()).max(20).optional(),
  alert_emails: z.array(z.email()).max(20).optional(),
  privacy_notice: z.string().trim().max(600).optional().nullable(),
  ussd_codes: z
    .object({ balance: z.string().max(20).optional(), self_service: z.string().max(20).optional(), promos: z.string().max(20).optional() })
    .optional(),
  kind: z.enum(["telecom", "general"]).optional(),
  strict_sources: z.boolean().optional(),
  emergency_message: z.string().trim().max(1000).optional().nullable(),
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), mvno: Fields }),
  z.object({ action: z.literal("update"), id: z.guid(), mvno: Fields.partial() }),
  z.object({ action: z.literal("set_token"), id: z.guid(), token: z.string().trim().min(20).max(2000) }),
]);

const DEFAULT_REPLIES = [
  ["hi", "Greeting", "Hi {{name}}, thank you for contacting {{brand}}. I'm {{agent}} and I'll help you with this today."],
  ["wait", "Checking", "Thank you for your patience, {{name}}. I'm checking this for you now, it will take 2–3 minutes."],
  ["ref", "Ask for reference", "Please share the transaction ID/reference, the amount and the time of the transaction so I can trace it."],
  ["bye", "Closing", "Glad I could help, {{name}}! Is there anything else I can do for you today?"],
];

export async function POST(req: Request) {
  try {
    const { profile: me } = await requirePlatformAdmin();
    const body = Body.parse(await req.json());
    const db = supabaseAdmin();
    await enforce(`admin:${me.id}`, LIMITS.admin);

    if (body.action === "create") {
      const m = body.mvno;
      const general = m.kind === "general";
      const slug = slugify(m.name);
      if (!slug) throw new HttpError(400, "Pick a name with letters or numbers");
      const { data, error } = await db
        .from("mvnos")
        .insert({
          ...m,
          slug,
          wa_phone_number_id: `SIM-${slug.toUpperCase()}`, // simulator until a WhatsApp number is connected
          greeting: m.greeting || `Hi 👋 Welcome to ${m.name}! I'm ${m.bot_name}, your virtual assistant.`,
          bot_persona:
            m.bot_persona ||
            (general
              ? `Courteous, calm and precise assistant for ${m.name}. Plain language, no jargon. Reply in the customer's language.`
              : `Friendly, clear and helpful customer care for ${m.name}, a mobile network in Uganda. Reply in the customer's language.`),
          ussd_codes: m.ussd_codes ?? {},
          // General businesses start with the standard menu and sourced answers only.
          ...(general ? { menu_items: DEFAULT_GENERAL_MENU, strict_sources: m.strict_sources ?? true, wallet_name: "" } : {}),
        })
        .select()
        .single();
      if (error?.code === "23505") throw new HttpError(409, "A tenant with that name already exists");
      if (error) throw error;
      await db
        .from("canned_responses")
        .insert(DEFAULT_REPLIES.filter(([s]) => !general || s !== "ref").map(([shortcut, title, text]) => ({ mvno_id: data.id, shortcut, title, body: text })));
      await audit(me, "mvno.created", { mvnoId: data.id, target: data.name });
      return Response.json({ mvno: data });
    }

    if (body.action === "set_token") {
      try {
        const result = await setMvnoToken(body.id, body.token);
        forgetMvno(body.id);
        await audit(me, "whatsapp.token_renewed", { mvnoId: body.id, details: { expires_at: result.expires_at, converted: result.exchanged } });
        return Response.json(result);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : "Could not save token");
      }
    }

    const { data, error } = await db.from("mvnos").update(body.mvno).eq("id", body.id).select().single();
    if (error) throw error;
    forgetMvno(body.id);
    await audit(me, "mvno.updated", { mvnoId: body.id, target: data.name, details: { fields: Object.keys(body.mvno) } });
    return Response.json({ mvno: data });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
