import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { MEDIA_BUCKET } from "@/lib/whatsapp/media";

/** Removes stored WhatsApp media for these conversations from Storage (rows are deleted separately). */
async function deleteMedia(conversationIds: string[]) {
  const db = supabaseAdmin();
  let removed = 0;
  for (let i = 0; i < conversationIds.length; i += 200) {
    const { data } = await db
      .from("messages")
      .select("payload")
      .in("conversation_id", conversationIds.slice(i, i + 200))
      .not("payload->>mediaPath", "is", null);
    const paths = (data ?? []).map((m) => (m.payload as { mediaPath?: string }).mediaPath).filter((p): p is string => !!p);
    for (let j = 0; j < paths.length; j += 100) {
      const { data: gone } = await db.storage.from(MEDIA_BUCKET).remove(paths.slice(j, j + 100));
      removed += gone?.length ?? 0;
    }
  }
  return removed;
}

/**
 * Right to erasure (Uganda DPPA 2019, s.16): deletes a customer's chats, messages, media
 * and profile. Top-up records are kept for finance/legal duties but detached from the
 * profile (contact_id is set null by the foreign key).
 */
export async function eraseContact(contactId: string) {
  const db = supabaseAdmin();
  const { data: convs } = await db.from("conversations").select("id").eq("contact_id", contactId);
  const ids = (convs ?? []).map((c) => c.id as string);
  const media = ids.length ? await deleteMedia(ids) : 0;
  const { error } = await db.from("contacts").delete().eq("id", contactId); // cascades conversations → messages
  if (error) throw error;
  return { conversations: ids.length, media };
}

/** Deletes conversations older than each MVNO's retention period, plus their media and orphaned contacts. */
export async function purgeExpired() {
  const db = supabaseAdmin();
  const { data: mvnos } = await db.from("mvnos").select("id, name, retention_days");
  const results: { mvno: string; conversations: number; media: number; contacts: number }[] = [];

  for (const m of mvnos ?? []) {
    const cutoff = new Date(Date.now() - m.retention_days * 86_400_000).toISOString();
    // Only closed or abandoned chats: anything with recent activity stays.
    const { data: old } = await db
      .from("conversations")
      .select("id")
      .eq("mvno_id", m.id)
      .in("status", ["resolved", "bot"])
      .lt("last_message_at", cutoff)
      .limit(5000);
    const ids = (old ?? []).map((c) => c.id as string);
    const media = ids.length ? await deleteMedia(ids) : 0;
    for (let i = 0; i < ids.length; i += 500) await db.from("conversations").delete().in("id", ids.slice(i, i + 500));

    // Contacts with no remaining conversations who haven't been in touch within the period.
    const { data: stale } = await db.from("contacts").select("id, conversations(id)").eq("mvno_id", m.id).lt("last_seen_at", cutoff).limit(5000);
    const orphans = (stale ?? []).filter((c) => !(c.conversations as unknown[])?.length).map((c) => c.id as string);
    for (let i = 0; i < orphans.length; i += 500) await db.from("contacts").delete().in("id", orphans.slice(i, i + 500));

    results.push({ mvno: m.name, conversations: ids.length, media, contacts: orphans.length });
  }
  return results;
}
