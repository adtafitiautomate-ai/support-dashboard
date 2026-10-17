import { after } from "next/server";
import { z } from "zod";
import { errorResponse, HttpError, requireMvnoManager } from "@/lib/inbox/auth";
import { isSimulated } from "@/lib/inbox/service";
import { runSimulated, SIMULATOR_TAG } from "@/lib/inbox/simulation";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { processInbound } from "@/lib/bot/engine";
import { runSerial } from "@/lib/queue";
import type { InboundMessage } from "@/lib/whatsapp/types";

// Plays the customer's side of WhatsApp so every MVNO can be demoed without Meta.
const Body = z.object({
  mvnoId: z.guid(),
  from: z.string().regex(/^\d{8,15}$/),
  name: z.string().max(80).optional(),
  text: z.string().max(4096).optional(),
  replyId: z.string().max(200).optional(),
  location: z.object({ lat: z.number(), lng: z.number(), name: z.string().optional() }).optional(),
});

export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const { mvno } = await requireMvnoManager(body.mvnoId);

    // Never inject fake messages into a real customer's chat.
    const { data: existing } = await supabaseAdmin().from("contacts").select("tags").eq("mvno_id", mvno.id).eq("wa_id", body.from).maybeSingle();
    if (existing && !isSimulated(mvno) && !existing.tags?.includes(SIMULATOR_TAG)) {
      throw new HttpError(409, "That number belongs to a real customer. Use another test number (tap the shuffle button).");
    }

    const msg: InboundMessage = {
      waMessageId: `sim.in.${crypto.randomUUID()}`,
      from: body.from,
      profileName: body.name,
      timestamp: new Date(),
      type: body.location ? "location" : body.replyId ? "button_reply" : "text",
      text: body.text,
      replyId: body.replyId,
      location: body.location,
    };

    after(() =>
      runSerial(`${mvno.id}:${msg.from}`, () => runSimulated(() => processInbound(mvno, msg))).catch((e) => console.error("sim inbound", e)),
    );
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: "Invalid request" }, { status: 400 });
    return errorResponse(e);
  }
}
