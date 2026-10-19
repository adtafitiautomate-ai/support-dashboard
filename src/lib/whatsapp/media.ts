import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getMvno, waCredentials } from "@/lib/inbox/service";

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0";
export const MEDIA_BUCKET = "wa-media";

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "application/pdf": "pdf",
};

interface MediaMessage {
  id: string;
  mvno_id: string;
  payload: Record<string, unknown>;
}

/**
 * Downloads an inbound WhatsApp media file from Meta and stores it in Supabase
 * Storage, recording the path on the message. Returns the storage path.
 */
export async function storeInboundMedia(message: MediaMessage): Promise<string | null> {
  const existing = message.payload.mediaPath as string | undefined;
  if (existing) return existing;
  const mediaId = message.payload.mediaId as string | undefined;
  if (!mediaId) return null;

  const creds = await waCredentials(await getMvno(message.mvno_id));
  if (!creds) return null; // simulator: no real media

  // 1) Resolve a short-lived download URL. 2) Download with the same token.
  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${creds.token}` },
  });
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number; error?: { message: string } };
  if (!metaRes.ok || !meta.url) throw new Error(meta.error?.message ?? `Media lookup failed (${metaRes.status})`);

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${creds.token}` } });
  if (!fileRes.ok) throw new Error(`Media download failed (${fileRes.status})`);
  const bytes = Buffer.from(await fileRes.arrayBuffer());
  const mime = (meta.mime_type ?? fileRes.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();

  const filename = message.payload.filename as string | undefined;
  const ext = EXT[mime] ?? filename?.split(".").pop()?.toLowerCase() ?? "bin";
  const path = `${message.mvno_id}/${message.id}.${ext}`;

  const db = supabaseAdmin();
  const { error } = await db.storage.from(MEDIA_BUCKET).upload(path, bytes, { contentType: mime, upsert: true });
  if (error) throw error;
  await db
    .from("messages")
    .update({ payload: { ...message.payload, mediaPath: path, mime, size: bytes.length } })
    .eq("id", message.id);
  return path;
}

export type AiAttachment = { kind: "image" | "document"; mediaType: string; data: string };

/**
 * A stored photo or PDF, ready to show the AI (base64). Photos are downscaled to keep
 * them fast and cheap to read. Null if it can't be used.
 */
export async function mediaForAi(path: string, mime: string): Promise<AiAttachment | null> {
  try {
    const { data } = await supabaseAdmin().storage.from(MEDIA_BUCKET).download(path);
    if (!data) return null;
    const bytes = Buffer.from(await data.arrayBuffer());
    if (mime === "application/pdf") {
      return bytes.length <= 10 * 1024 * 1024 ? { kind: "document", mediaType: "application/pdf", data: bytes.toString("base64") } : null;
    }
    if (!mime.startsWith("image/")) return null;
    try {
      const sharp = (await import("sharp")).default;
      const out = await sharp(bytes).rotate().resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      return { kind: "image", mediaType: "image/jpeg", data: out.toString("base64") };
    } catch {
      // No image library: send the original if the AI accepts it as-is.
      const ok = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime) && bytes.length <= 4.5 * 1024 * 1024;
      return ok ? { kind: "image", mediaType: mime, data: bytes.toString("base64") } : null;
    }
  } catch (e) {
    console.error("media for ai", e);
    return null;
  }
}
