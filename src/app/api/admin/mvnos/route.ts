import { z } from "zod";
import { errorResponse, HttpError } from "@/lib/inbox/auth";
import { requirePlatformAdmin, slugify } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { forgetMvno } from "@/lib/inbox/service";

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
  ussd_codes: z
    .object({ balance: z.string().max(20).optional(), self_service: z.string().max(20).optional(), promos: z.string().max(20).optional() })
    .optional(),
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), mvno: Fields }),
  z.object({ action: z.literal("update"), id: z.guid(), mvno: Fields.partial() }),
]);

const DEFAULT_REPLIES = [
  ["hi", "Greeting", "Hi {{name}}, thank you for contacting {{brand}}. I'm {{agent}} and I'll help you with this today."],
  ["wait", "Checking", "Thank you for your patience, {{name}}. I'm checking this for you now, it will take 2–3 minutes."],
  ["ref", "Ask for reference", "Please share the transaction ID/reference, the amount and the time of the transaction so I can trace it."],
  ["bye", "Closing", "Glad I could help, {{name}}! Is there anything else I can do for you today?"],
];

export async function POST(req: Request) {
  try {
    await requirePlatformAdmin();
    const body = Body.parse(await req.json());
    const db = supabaseAdmin();

    if (body.action === "create") {
      const m = body.mvno;
      const slug = slugify(m.name);
      if (!slug) throw new HttpError(400, "Pick a name with letters or numbers");
      const { data, error } = await db
        .from("mvnos")
        .insert({
          ...m,
          slug,
          wa_phone_number_id: `SIM-${slug.toUpperCase()}`, // simulator until a WhatsApp number is connected
          greeting: m.greeting || `Hi 👋 Welcome to ${m.name}! I'm ${m.bot_name}, your virtual assistant.`,
          bot_persona: m.bot_persona || `Friendly, clear and helpful customer care for ${m.name}, a mobile network in Uganda. Reply in the customer's language.`,
          ussd_codes: m.ussd_codes ?? {},
        })
        .select()
        .single();
      if (error?.code === "23505") throw new HttpError(409, "An MVNO with that name already exists");
      if (error) throw error;
      await db.from("canned_responses").insert(DEFAULT_REPLIES.map(([shortcut, title, text]) => ({ mvno_id: data.id, shortcut, title, body: text })));
      return Response.json({ mvno: data });
    }

    const { data, error } = await db.from("mvnos").update(body.mvno).eq("id", body.id).select().single();
    if (error) throw error;
    forgetMvno(body.id);
    return Response.json({ mvno: data });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
