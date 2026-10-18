import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getMvno, waCredentials } from "@/lib/inbox/service";
import { metaSend } from "@/lib/whatsapp/meta";
import { MEDIA_BUCKET } from "@/lib/whatsapp/media";
import { SIMULATOR_TAG } from "@/lib/inbox/simulation";
import { parseTemplate, type ParsedTemplate, type VarValue } from "@/lib/campaign-templates";
import type { Mvno } from "@/lib/types";

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0";
export const MAX_RECIPIENTS = 10_000;

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
    const t = c.template as ParsedTemplate;
    let headerLink: string | undefined;
    if (c.header_media?.path) {
      const { data } = await db.storage.from(MEDIA_BUCKET).createSignedUrl(c.header_media.path, 24 * 3600);
      headerLink = data?.signedUrl;
    }

    while (Date.now() - started < budgetMs) {
      const { data: cur } = await db.from("campaigns").select("status").eq("id", c.id).single();
      if (cur?.status !== "sending") return;
      const { data: batch } = await db.from("campaign_recipients").select("id, wa_id, name").eq("campaign_id", c.id).eq("status", "queued").order("id").limit(40);
      if (!batch?.length) {
        await db.from("campaigns").update({ status: "done", finished_at: new Date().toISOString(), processing_until: null }).eq("id", c.id).eq("status", "sending");
        return;
      }
      // ~10 at a time: well under Meta's per-number throughput.
      for (let i = 0; i < batch.length; i += 10) {
        await Promise.all(
          batch.slice(i, i + 10).map(async (r) => {
            try {
              const id = await metaSend(creds.phoneNumberId, creds.token, templatePayload(t, c.variables, r, headerLink));
              await db.from("campaign_recipients").update({ status: "sent", wa_message_id: id, updated_at: new Date().toISOString() }).eq("id", r.id);
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
