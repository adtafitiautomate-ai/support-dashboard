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
