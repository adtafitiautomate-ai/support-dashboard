// What WhatsApp accepts as outgoing media, and how big (Cloud API limits).
export type MediaKind = "image" | "video" | "audio" | "document";

const MB = 1024 * 1024;
export const MEDIA_RULES: { kind: MediaKind; mimes: string[]; max: number }[] = [
  { kind: "image", mimes: ["image/jpeg", "image/png"], max: 5 * MB },
  { kind: "video", mimes: ["video/mp4", "video/3gpp"], max: 16 * MB },
  { kind: "audio", mimes: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"], max: 16 * MB },
  {
    kind: "document",
    mimes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "text/plain",
      "text/csv",
    ],
    max: 100 * MB,
  },
];

/** Which WhatsApp media kind a file is, or why it can't be sent. */
export function classifyMedia(mime: string, size: number): { kind: MediaKind } | { error: string } {
  const rule = MEDIA_RULES.find((r) => r.mimes.includes(mime));
  if (!rule) return { error: "WhatsApp can't send this file type. Use JPG/PNG photos, MP4 videos, MP3/OGG audio, or PDF/Word/Excel/PowerPoint documents." };
  if (size > rule.max) return { error: `Too large for WhatsApp: ${rule.kind}s can be up to ${rule.max / MB} MB.` };
  return { kind: rule.kind };
}

export const ACCEPT = MEDIA_RULES.flatMap((r) => r.mimes).join(",");
