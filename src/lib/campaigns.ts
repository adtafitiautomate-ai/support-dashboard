import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getMvno, waCredentials } from "@/lib/inbox/service";
import { metaSend } from "@/lib/whatsapp/meta";
import { MEDIA_BUCKET } from "@/lib/whatsapp/media";
import { SIMULATOR_TAG } from "@/lib/inbox/simulation";
import { parseTemplate, type ParsedTemplate, type VarValue } from "@/lib/campaign-templates";
import { zonedToUtc } from "@/lib/hours";
import { MAX_AUDIENCE } from "@/lib/campaign-audience";
import type { Mvno } from "@/lib/types";
import { usesNumberRanges } from "@/lib/modules";

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0";
export const MAX_RECIPIENTS = MAX_AUDIENCE;

/** The tenant's APPROVED templates from Meta, parsed. */
export async function fetchTemplates(mvno: Mvno): Promise<ParsedTemplate[]> {
  if (!mvno.wa_waba_id) throw new Error("This tenant's WhatsApp Business Account ID isn't set");
  const creds = await waCredentials(mvno);
  if (!creds) throw new Error("This tenant isn't connected to WhatsApp");
  const out: ParsedTemplate[] = [];
  let url: string | null =
    `https://graph.facebook.com/${GRAPH_VERSION}/${mvno.wa_waba_id}/message_templates?fields=name,language,status,category,parameter_format,components&limit=100`;
  while (url && out.length < 500) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${creds.token}` } });
    const j = (await res.json()) as { data?: { status: string; name: string; language: string; category: string; parameter_format?: string; components: [] }[]; paging?: { next?: string }; error?: { message: string } };
    if (!res.ok) throw new Error(j.error?.message ?? `Couldn't load templates (${res.status})`);
    for (const t of j.data ?? []) if (t.status === "APPROVED") out.push(parseTemplate(t));
    url = j.paging?.next ?? null;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** In-range, not opted out, not simulator. Optionally limited to chosen contacts. */
export async function resolveRecipients(mvnoId: string, prefixes: string[], contactIds?: string[]) {
  if (!prefixes.length) return [];
  const db = supabaseAdmin();
  const rows: { id: string; wa_id: string; name: string | null }[] = [];
  const inRange = prefixes.map((p) => `wa_id.like.${p}%`).join(",");
  const ids = contactIds?.length ? contactIds : null;
  for (let from = 0; rows.length < MAX_RECIPIENTS + 1; from += 1000) {
    let q = db
      .from("contacts")
      .select("id, wa_id, name")
      .eq("mvno_id", mvnoId)
      .or(inRange)
      .is("opted_out_at", null)
      .not("tags", "cs", `{${SIMULATOR_TAG}}`)
      .order("id")
      .range(from, from + 999);
    if (ids) q = q.in("id", ids.slice(0, MAX_RECIPIENTS));
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000 || ids) break;
  }
  return rows;
}

/** Who a campaign goes to. Telecoms' "all"/"selected" stay within their number ranges (resolveRecipients). */
export type Audience =
  | { mode: "all" }
  | { mode: "selected"; contactIds: string[] }
  | { mode: "waiting" } // on the ID waiting list, card not arrived yet
  | { mode: "id_untold" } // card arrived, couldn't tell them yet (outside 24h, no template)
  | { mode: "id_arrived" } // card arrived (told or not)
  | { mode: "appointments"; date: string }; // confirmed appointment on this day (tenant's time zone)

type Recipient = { id: string; wa_id: string; name: string | null };

/** Contacts reachable by this campaign: not opted out, not simulator test contacts. */
export async function resolveAudience(mvno: Mvno, audience: Audience): Promise<Recipient[]> {
  if ((audience.mode === "all" || audience.mode === "selected") && usesNumberRanges(mvno)) {
    return resolveRecipients(mvno.id, mvno.number_prefixes ?? [], audience.mode === "selected" ? audience.contactIds : undefined);
  }
  const db = supabaseAdmin();
  let ids: string[] | null = null; // null = everyone who messaged the tenant
  if (audience.mode === "selected") ids = audience.contactIds;
  else if (audience.mode === "waiting" || audience.mode === "id_untold" || audience.mode === "id_arrived") {
    const status = audience.mode === "waiting" ? ["waiting"] : audience.mode === "id_untold" ? ["needs_template"] : ["needs_template", "notified"];
    const { data, error } = await db.from("id_watch").select("contact_id").eq("mvno_id", mvno.id).in("status", status).not("contact_id", "is", null).limit(MAX_RECIPIENTS + 1);
    if (error) throw error;
    ids = [...new Set((data ?? []).map((w) => w.contact_id as string))];
  } else if (audience.mode === "appointments") {
    const tz = mvno.business_hours?.tz ?? "Africa/Kampala";
    const start = zonedToUtc(audience.date, "00:00", tz);
    const end = new Date(start.getTime() + 36 * 3600_000); // then keep only that local date
    const { data, error } = await db.from("appointments").select("contact_id, scheduled_at").eq("mvno_id", mvno.id).eq("status", "confirmed").gte("scheduled_at", start.toISOString()).lt("scheduled_at", end.toISOString());
    if (error) throw error;
    const sameDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz }) === audience.date;
    ids = [...new Set((data ?? []).filter((a) => a.contact_id && sameDay(a.scheduled_at)).map((a) => a.contact_id as string))];
  }
  if (ids && !ids.length) return [];

  const rows: Recipient[] = [];
  const chunks = ids ? Array.from({ length: Math.ceil(ids.length / 500) }, (_, i) => ids!.slice(i * 500, i * 500 + 500)) : [null];
  for (const chunk of chunks) {
    for (let from = 0; rows.length < MAX_RECIPIENTS + 1; from += 1000) {
      let q = db.from("contacts").select("id, wa_id, name").eq("mvno_id", mvno.id).is("opted_out_at", null).not("tags", "cs", `{${SIMULATOR_TAG}}`).order("id").range(from, from + 999);
      if (chunk) q = q.in("id", chunk);
      const { data, error } = await q;
      if (error) throw error;
      rows.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
  }
  return rows;
}

/** Contacts who wrote to the tenant in the last 24 hours: the only ones a plain (non-template) message can reach. */
export async function inServiceWindow(mvnoId: string): Promise<Set<string>> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data, error } = await supabaseAdmin().from("conversations").select("contact_id").eq("mvno_id", mvnoId).gte("last_inbound_at", since).limit(50_000);
  if (error) throw error;
  return new Set((data ?? []).map((c) => c.contact_id as string));
}

const firstName = (n: string | null) => (n ?? "").trim().split(/\s+/)[0] ?? "";

function value(v: VarValue | undefined, name: string | null) {
  if (!v) return "";
  if (v.mode === "name") return firstName(name) || v.fallback || "Customer";
  return v.text;
}

/** Meta template payload for one recipient. */
export function templatePayload(
  t: ParsedTemplate,
  vars: Record<string, VarValue>,
  to: { wa_id: string; name: string | null },
  headerLink?: string,
) {
  const param = (k: string, text: string) => (t.named ? { type: "text", parameter_name: k, text } : { type: "text", text });
  const components: Record<string, unknown>[] = [];
  if (t.header) {
    if (t.header.format === "TEXT" && t.header.vars.length) {
      components.push({ type: "header", parameters: t.header.vars.map((k) => param(k, value(vars[`header.${k}`], to.name))) });
    } else if (t.header.format !== "TEXT" && headerLink) {
      const kind = t.header.format.toLowerCase();
      components.push({ type: "header", parameters: [{ type: kind, [kind]: { link: headerLink } }] });
    }
  }
  if (t.body.vars.length) components.push({ type: "body", parameters: t.body.vars.map((k) => param(k, value(vars[`body.${k}`], to.name))) });
  for (const b of t.buttons) {
    if (b.urlVar) components.push({ type: "button", sub_type: "url", index: String(b.index), parameters: [{ type: "text", text: value(vars[`button.${b.index}`], to.name) }] });
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to.wa_id,
    type: "template",
    template: { name: t.name, language: { code: t.language }, ...(components.length ? { components } : {}) },
  };
}

/**
 * Sends queued recipients for up to ~45s, then stops; the next call (page polling or the
 * create request) carries on. A row lock stops two workers sending the same campaign.
 */
export async function processCampaign(campaignId: string, budgetMs = 45_000) {
  const db = supabaseAdmin();
  const now = new Date();
  const { data: c } = await db
    .from("campaigns")
    .update({ processing_until: new Date(now.getTime() + 90_000).toISOString() })
    .eq("id", campaignId)
    .eq("status", "sending")
    .or(`processing_until.is.null,processing_until.lt.${now.toISOString()}`)
    .select("*")
    .maybeSingle();
  if (!c) return; // finished, cancelled, or another worker has it

  const started = Date.now();
  try {
    const mvno = await getMvno(c.mvno_id);
    const creds = await waCredentials(mvno);
    if (!creds) throw new Error("Tenant isn't connected to WhatsApp");
    const t = c.template as ParsedTemplate | null;
    let headerLink: string | undefined;
    if (c.header_media?.path) {
      const { data } = await db.storage.from(MEDIA_BUCKET).createSignedUrl(c.header_media.path, 24 * 3600);
      headerLink = data?.signedUrl;
    }
    const payload = (r: { wa_id: string; name: string | null }) =>
      c.kind === "text"
        ? { messaging_product: "whatsapp", recipient_type: "individual", to: r.wa_id, type: "text", text: { body: c.body as string, preview_url: false } }
        : templatePayload(t!, c.variables, r, headerLink);
    // Telling people their ID arrived takes them off the "not told yet" list.
    const idNews = c.audience?.mode === "id_untold" || c.audience?.mode === "id_arrived";

    while (Date.now() - started < budgetMs) {
      const { data: cur } = await db.from("campaigns").select("status").eq("id", c.id).single();
      if (cur?.status !== "sending") return;
      const { data: batch } = await db.from("campaign_recipients").select("id, wa_id, name, contact_id").eq("campaign_id", c.id).eq("status", "queued").order("id").limit(40);
      if (!batch?.length) {
        await db.from("campaigns").update({ status: "done", finished_at: new Date().toISOString(), processing_until: null }).eq("id", c.id).eq("status", "sending");
        return;
      }
      // ~10 at a time: well under Meta's per-number throughput.
      for (let i = 0; i < batch.length; i += 10) {
        await Promise.all(
          batch.slice(i, i + 10).map(async (r) => {
            try {
              const id = await metaSend(creds.phoneNumberId, creds.token, payload(r));
              await db.from("campaign_recipients").update({ status: "sent", wa_message_id: id, updated_at: new Date().toISOString() }).eq("id", r.id);
              if (idNews && r.contact_id) {
                await db
                  .from("id_watch")
                  .update({ status: "notified", notified_at: new Date().toISOString() })
                  .eq("mvno_id", c.mvno_id)
                  .eq("contact_id", r.contact_id)
                  .eq("status", "needs_template");
              }
            } catch (e) {
              await db.from("campaign_recipients").update({ status: "failed", error: (e as Error).message.slice(0, 300), updated_at: new Date().toISOString() }).eq("id", r.id);
            }
          }),
        );
      }
      await db.from("campaigns").update({ processing_until: new Date(Date.now() + 90_000).toISOString() }).eq("id", c.id);
    }
  } finally {
    await db.from("campaigns").update({ processing_until: null }).eq("id", c.id).eq("status", "sending");
  }
}

const rank = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4, skipped: 4 } as const;

/** Delivery receipts for campaign messages (they aren't in any conversation). */
export async function applyCampaignStatus(waMessageId: string, status: "sent" | "delivered" | "read" | "failed", error?: string) {
  const db = supabaseAdmin();
  const { data } = await db.from("campaign_recipients").select("id, status").eq("wa_message_id", waMessageId).maybeSingle();
  if (!data) return;
  if (status !== "failed" && rank[status] <= rank[data.status as keyof typeof rank]) return;
  await db.from("campaign_recipients").update({ status, error: error ?? null, updated_at: new Date().toISOString() }).eq("id", data.id);
}
