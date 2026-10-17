import "server-only";
import crypto from "node:crypto";
import type { InboundMessage, OutboundMessage, StatusUpdate } from "./types";

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Maps a neutral message to a Meta Cloud API payload. */
export function toMetaPayload(to: string, msg: OutboundMessage): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  switch (msg.type) {
    case "text":
      return { ...base, type: "text", text: { body: clip(msg.text, 4096), preview_url: msg.previewUrl ?? false } };
    case "buttons":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          ...(msg.header ? { header: { type: "text", text: clip(msg.header, 60) } } : {}),
          body: { text: clip(msg.body, 1024) },
          ...(msg.footer ? { footer: { text: clip(msg.footer, 60) } } : {}),
          action: {
            buttons: msg.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: clip(b.title, 20) } })),
          },
        },
      };
    case "list": {
      // WhatsApp allows at most 10 rows across all sections of a list.
      let budget = 10;
      const sections = msg.sections
        .map((s) => {
          const rows = s.rows.slice(0, Math.max(0, budget));
          budget -= rows.length;
          return { ...s, rows };
        })
        .filter((s) => s.rows.length);
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          ...(msg.header ? { header: { type: "text", text: clip(msg.header, 60) } } : {}),
          body: { text: clip(msg.body, 4096) },
          ...(msg.footer ? { footer: { text: clip(msg.footer, 60) } } : {}),
          action: {
            button: clip(msg.button, 20),
            sections: sections.map((s) => ({
              title: clip(s.title, 24),
              rows: s.rows.map((r) => ({
                id: r.id,
                title: clip(r.title, 24),
                ...(r.description ? { description: clip(r.description, 72) } : {}),
              })),
            })),
          },
        },
      };
    }
    case "location":
      return { ...base, type: "location", location: { latitude: msg.lat, longitude: msg.lng, name: msg.name, address: msg.address } };
    case "location_request":
      return {
        ...base,
        type: "interactive",
        interactive: { type: "location_request_message", body: { text: msg.body }, action: { name: "send_location" } },
      };
    case "cta_url":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "cta_url",
          body: { text: msg.body },
          action: { name: "cta_url", parameters: { display_text: clip(msg.buttonText, 20), url: msg.url } },
        },
      };
    case "template":
      return {
        ...base,
        type: "template",
        template: {
          name: msg.name,
          language: { code: msg.language },
          ...(msg.params?.length
            ? { components: [{ type: "body", parameters: msg.params.map((text) => ({ type: "text", text })) }] }
            : {}),
        },
      };
  }
}

export async function metaSend(phoneNumberId: string, token: string, payload: Record<string, unknown>) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({}))) as {
    messages?: { id: string }[];
    error?: { message?: string; code?: number };
  };
  if (!res.ok || !json.messages?.[0]?.id) {
    throw new Error(json.error?.message ?? `WhatsApp send failed (${res.status})`);
  }
  return json.messages[0].id;
}

/** Marks an inbound message read and shows the typing indicator (up to 25s or until we reply). */
export async function metaMarkReadAndTyping(phoneNumberId: string, token: string, waMessageId: string) {
  await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: waMessageId,
      typing_indicator: { type: "text" },
    }),
  }).catch(() => undefined);
}

export function verifySignature(rawBody: string, header: string | null, appSecret: string) {
  if (!header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const given = header.slice("sha256=".length);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// ------------------------------------------------------------------ inbound parsing

interface MetaWebhook {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: MetaInboundMessage[];
        statuses?: { id: string; status: string; errors?: { title?: string; message?: string }[] }[];
      };
    }[];
  }[];
}

interface MetaInboundMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  interactive?: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: { payload: string; text: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  image?: { id: string; caption?: string; mime_type?: string };
  audio?: { id: string; mime_type?: string };
  video?: { id: string; caption?: string; mime_type?: string };
  document?: { id: string; caption?: string; filename?: string; mime_type?: string };
  sticker?: { id: string; mime_type?: string };
}

export interface ParsedBatch {
  phoneNumberId: string;
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

export function parseWebhook(body: unknown): ParsedBatch[] {
  const out: ParsedBatch[] = [];
  for (const entry of (body as MetaWebhook).entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      const phoneNumberId = v?.metadata?.phone_number_id;
      if (!v || !phoneNumberId) continue;
      const names = new Map((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      out.push({
        phoneNumberId,
        messages: (v.messages ?? []).map((m) => normalizeInbound(m, names.get(m.from))),
        statuses: (v.statuses ?? [])
          .filter((s) => ["sent", "delivered", "read", "failed"].includes(s.status))
          .map((s) => ({
            waMessageId: s.id,
            status: s.status as StatusUpdate["status"],
            error: s.errors?.[0]?.message ?? s.errors?.[0]?.title,
          })),
      });
    }
  }
  return out;
}

function normalizeInbound(m: MetaInboundMessage, profileName?: string): InboundMessage {
  const base = { waMessageId: m.id, from: m.from, profileName, timestamp: new Date(Number(m.timestamp) * 1000) };
  switch (m.type) {
    case "text":
      return { ...base, type: "text", text: m.text?.body ?? "" };
    case "interactive":
      if (m.interactive?.type === "button_reply")
        return { ...base, type: "button_reply", replyId: m.interactive.button_reply?.id, text: m.interactive.button_reply?.title };
      return { ...base, type: "list_reply", replyId: m.interactive?.list_reply?.id, text: m.interactive?.list_reply?.title };
    case "button": // quick-reply button on a template
      return { ...base, type: "button_reply", replyId: m.button?.payload, text: m.button?.text };
    case "location":
      return {
        ...base,
        type: "location",
        location: { lat: m.location!.latitude, lng: m.location!.longitude, name: m.location?.name, address: m.location?.address },
      };
    case "image":
    case "video":
      return { ...base, type: m.type, mediaId: m[m.type]?.id, mime: m[m.type]?.mime_type, caption: m[m.type]?.caption, text: m[m.type]?.caption };
    case "document":
      return {
        ...base,
        type: "document",
        mediaId: m.document?.id,
        mime: m.document?.mime_type,
        filename: m.document?.filename,
        caption: m.document?.caption,
        text: m.document?.caption ?? (m.document?.filename ? `📎 ${m.document.filename}` : undefined),
      };
    case "audio":
    case "sticker":
      return { ...base, type: m.type, mediaId: m[m.type]?.id, mime: m[m.type]?.mime_type };
    default:
      return { ...base, type: "unknown" };
  }
}
