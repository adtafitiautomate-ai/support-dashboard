import { after, type NextRequest } from "next/server";
import { parseWebhook, verifySignature } from "@/lib/whatsapp/meta";
import { applyStatus, getMvnoByPhoneNumberId } from "@/lib/inbox/service";
import { processInbound } from "@/lib/bot/engine";
import { runSerial } from "@/lib/queue";

// Meta webhook verification handshake.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(p.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  // One secret per Meta app (e.g. PaxTel's and SalamTel's apps), comma-separated.
  const secrets = (process.env.WHATSAPP_APP_SECRET ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const signature = req.headers.get("x-hub-signature-256");
  if (secrets.length && !secrets.some((s) => verifySignature(raw, signature, s))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  // Ack immediately (Meta retries slow webhooks); do the work after responding.
  after(async () => {
    for (const batch of parseWebhook(body)) {
      const mvno = await getMvnoByPhoneNumberId(batch.phoneNumberId);
      if (!mvno) {
        console.warn("webhook for unknown phone_number_id", batch.phoneNumberId);
        continue;
      }
      await Promise.all([
        ...batch.statuses.map((s) => applyStatus(s).catch((e) => console.error("status", e))),
        ...batch.messages.map((m) =>
          runSerial(`${mvno.id}:${m.from}`, () => processInbound(mvno, m)).catch((e) => console.error("inbound", e)),
        ),
      ]);
    }
  });

  return new Response("OK", { status: 200 });
}
