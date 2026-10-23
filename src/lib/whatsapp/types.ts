// Provider-neutral outbound message shapes. The Meta adapter maps these to
// Cloud API payloads; the dashboard and simulator render them directly.

export interface ReplyButton {
  id: string;
  title: string; // max 20 chars on WhatsApp
}

export interface ListRow {
  id: string;
  title: string; // max 24 chars
  description?: string; // max 72 chars
}

export interface ListSection {
  title: string;
  rows: ListRow[];
}

export type OutboundMessage =
  | { type: "text"; text: string; previewUrl?: boolean }
  | { type: "buttons"; body: string; header?: string; footer?: string; buttons: ReplyButton[] }
  | { type: "list"; body: string; button: string; header?: string; footer?: string; sections: ListSection[] }
  | { type: "location"; lat: number; lng: number; name?: string; address?: string }
  | { type: "location_request"; body: string }
  | { type: "cta_url"; body: string; buttonText: string; url: string }
  | { type: "template"; name: string; language: string; params?: string[] }
  /** An agent's attachment, stored in our bucket at `path`; `link` is a signed URL added at send time. */
  | { type: "media"; kind: "image" | "video" | "audio" | "document"; path: string; mime: string; filename?: string; caption?: string; size?: number; link?: string };

/** Normalized inbound message from any provider. */
export interface InboundMessage {
  waMessageId: string;
  from: string;
  profileName?: string;
  timestamp: Date;
  type: "text" | "button_reply" | "list_reply" | "location" | "image" | "audio" | "video" | "document" | "sticker" | "unknown";
  text?: string;
  replyId?: string;
  /** WhatsApp id of the message the customer quoted ("reply"), if any. */
  quotedId?: string;
  location?: { lat: number; lng: number; name?: string; address?: string };
  mediaId?: string;
  mime?: string;
  filename?: string;
  caption?: string;
  /** Meta's own type when it isn't one we handle (e.g. "unsupported", "reaction", "contacts"). */
  rawType?: string;
  /** The original Meta message, kept for anything unusual so it can be diagnosed later. */
  raw?: Record<string, unknown>;
  /** Storage path once the media is saved (set before the bot reads a photo/PDF). */
  mediaPath?: string;
  /** Not meant for the bot (e.g. a reaction): store it, don't reply. */
  silent?: boolean;
}

export interface StatusUpdate {
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  error?: string;
}

/** Human-readable preview text for storage and the inbox list. */
export function outboundPreview(msg: OutboundMessage): string {
  if (msg.type === "media") return msg.caption?.trim() || (msg.kind === "document" ? `📎 ${msg.filename ?? "Document"}` : `[${msg.kind}]`);
  switch (msg.type) {
    case "text":
      return msg.text;
    case "buttons":
      return msg.body;
    case "list":
      return msg.body;
    case "location":
      return `📍 ${msg.name ?? "Location"}${msg.address ? ` – ${msg.address}` : ""}`;
    case "location_request":
      return msg.body;
    case "cta_url":
      return msg.body;
    case "template":
      return `[template] ${msg.name}`;
  }
}
