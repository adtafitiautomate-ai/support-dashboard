import "server-only";
import { PDFDocument } from "pdf-lib";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { claude } from "@/lib/bot/ai";
import { recordAiUsage } from "@/lib/ai-usage";
import { parseCsv } from "@/lib/csv";
import { logEvent, sendMessage } from "@/lib/inbox/service";
import type { Contact, Conversation, Mvno } from "@/lib/types";

const MODEL = process.env.BOT_MODEL || "claude-opus-5-5";
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "eng", "hon", "rev", "fr", "sr", "jr"]);
const PAGES_PER_CALL = 5;

// ------------------------------------------------------------------ names

/** "Okello, JOHN Peter" → ["john", "okello", "peter"] (accents, punctuation and titles removed). */
export function nameTokens(name: string) {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z\s]/g, " ") // "Kabali-Kagwa" matches "Kabali Kagwa"
    .split(/\s+/)
    .filter((t) => t.length > 1 && !TITLES.has(t));
}
/** Order-insensitive key: reversed names ("Okello John" / "John Okello") match. */
export const nameKey = (name: string) => [...nameTokens(name)].sort().join(" ");

function editDistance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const close = (a: string, b: string) => a === b || editDistance(a, b) <= (Math.max(a.length, b.length) >= 7 ? 2 : 1);

/** Every query word matches a different word of the candidate (allowing small misspellings). */
function covers(query: string[], cand: string[]) {
  const used = new Set<number>();
  return query.every((q) => {
    const i = cand.findIndex((c, k) => !used.has(k) && close(q, c));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
}

export type Lookup =
  | { kind: "found"; fullName: string; received: string | null; batch: { label: string; date: string | null; source: string | null; uploadedAt: string } }
  | { kind: "duplicate" } // the same name appears more than once: an officer must check
  | { kind: "near" } // a close spelling exists: ask them to send it exactly as on the application
  | { kind: "ambiguous" } // several close spellings: refuse to guess
  | { kind: "none" }
  | { kind: "too_short" };

/** Looks a customer's name up in the current register. Never returns anyone else's name. */
export async function lookupNationalId(mvnoId: string, name: string): Promise<Lookup> {
  const q = nameTokens(name);
  if (q.length < 2) return { kind: "too_short" };
  const key = [...q].sort().join(" ");
  const db = supabaseAdmin();
  const { data: exact } = await db.from("id_register").select("full_name, extra, batch:id_batches(label, batch_date, source_name, created_at, status)").eq("mvno_id", mvnoId).eq("name_key", key);
  const ready = (exact ?? []).filter((r) => (r.batch as unknown as { status: string })?.status === "ready");
  if (ready.length === 1) {
    const b = ready[0].batch as unknown as { label: string; batch_date: string | null; source_name: string | null; created_at: string };
    const received = (ready[0].extra as Record<string, string> | null)?.received_as_of ?? null;
    return { kind: "found", fullName: ready[0].full_name, received, batch: { label: b.label, date: b.batch_date, source: b.source_name, uploadedAt: b.created_at } };
  }
  if (ready.length > 1) return { kind: "duplicate" };

  // Fuzzy: same number of words with small misspellings, or the customer left out a middle name.
  // The API returns at most 1,000 rows per request, so page through the register.
  const hits: string[] = [];
  for (let from = 0; from < 200_000 && hits.length < 2; from += 1000) {
    const { data: page } = await db
      .from("id_register")
      .select("name_key, batch:id_batches!inner(status)")
      .eq("mvno_id", mvnoId)
      .eq("batch.status", "ready")
      .order("id")
      .range(from, from + 999);
    for (const r of page ?? []) {
      const c = r.name_key.split(" ");
      if ((c.length === q.length || c.length === q.length + 1) && covers(q, c)) hits.push(r.name_key);
    }
    if ((page ?? []).length < 1000) break;
  }
  if (hits.length === 1) return { kind: "near" };
  if (hits.length > 1) return { kind: "ambiguous" };
  return { kind: "none" };
}

// ------------------------------------------------------------------ import

type Row = { full_name: string; extra: Record<string, string> };
type Extracted = { updated: string | null; rows: Row[] };
const isDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * Reads an uploaded register (PDF or CSV) into rows. A list that replaces earlier ones (the usual
 * cumulative "cards pending pick-up" list) retires the previous upload. Then tells anyone waiting.
 */
export async function importBatch(batchId: string) {
  const db = supabaseAdmin();
  const { data: batch } = await db.from("id_batches").select("*").eq("id", batchId).single();
  try {
    const { data: file } = await db.storage.from("registers").download(batch.file_path);
    if (!file) throw new Error("Uploaded file not found");
    const bytes = Buffer.from(await file.arrayBuffer());
    const ex = batch.file_path.toLowerCase().endsWith(".csv") ? fromCsv(bytes.toString("utf8")) : await fromPdf(batch.mvno_id, bytes);
    const rows = ex.rows.filter((r) => nameTokens(r.full_name).length >= 2);
    if (!rows.length) throw new Error("No names found in this file");

    await db.from("id_register").delete().eq("batch_id", batchId);
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("id_register").insert(
        rows.slice(i, i + 500).map((r) => ({
          mvno_id: batch.mvno_id,
          batch_id: batchId,
          full_name: r.full_name.trim().replace(/\s+/g, " ").slice(0, 200),
          name_key: nameKey(r.full_name),
          extra: Object.fromEntries(Object.entries(r.extra).slice(0, 10).map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 120)])),
        })),
      );
      if (error) throw error;
    }
    // Staff-entered label/date win; otherwise use the list's "last updated" date.
    const update: Record<string, unknown> = { status: "ready", error: null, row_count: rows.length };
    if (!batch.batch_date && isDate(ex.updated)) update.batch_date = ex.updated;
    if (/^Upload /.test(batch.label) && isDate(ex.updated)) {
      update.label = `List updated ${new Date(ex.updated).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;
    }
    await db.from("id_batches").update(update).eq("id", batchId);
    if (batch.replaces_previous) {
      await db.from("id_batches").update({ status: "superseded" }).eq("mvno_id", batch.mvno_id).eq("status", "ready").neq("id", batchId);
    }
    const notified = await notifyWatchers(batchId);
    return { rows: rows.length, notified };
  } catch (e) {
    await db.from("id_batches").update({ status: "failed", error: (e as Error).message.slice(0, 300) }).eq("id", batchId);
    throw e;
  }
}

/** CSV with a "name" column, or "surname" + "given names" columns; other columns are kept as details. */
function fromCsv(text: string): Extracted {
  const [header, ...lines] = parseCsv(text);
  const h = (header ?? []).map((x) => x.trim().toLowerCase());
  const surname = h.findIndex((x) => /surname|last name|family name/.test(x));
  const given = h.findIndex((x) => /given|first name|other name/.test(x));
  const full = h.findIndex((x, i) => /name/.test(x) && i !== surname && i !== given);
  const received = h.findIndex((x) => /received|date|batch/.test(x));
  const nameCols = surname >= 0 && given >= 0 ? [surname, given] : full >= 0 ? [full] : [];
  if (!nameCols.length) throw new Error('The CSV needs a "name" column, or "surname" and "given names" columns');
  return {
    updated: null,
    rows: lines.map((l) => ({
      full_name: nameCols.map((i) => l[i] ?? "").join(" "),
      extra: Object.fromEntries([
        ...h.map((field, i) => [field, l[i] ?? ""] as const).filter(([, v], i) => !nameCols.includes(i) && i !== received && v),
        ...(received >= 0 && l[received] ? [["received_as_of", l[received]] as const] : []),
      ]),
    })),
  };
}

type Chunk = { list_updated: string | null; groups: { heading: string | null; received_as_of: string | null; names: string[] }[] };

const PDF_SYSTEM = `You transcribe a register of National ID cards received at an embassy (often a scanned table).
- Copy EVERY person's name exactly as printed: surname first, then the given names, as one string (e.g. "AKAMPA TIMOTHY"). Keep the printed spelling. Never invent, merge, correct or skip names; ignore the row numbers.
- The register is split into lists with headings like "LIST OF NID CARDS RECEIVED AS OF DECEMBER 12, 2025". Group names under their heading, in page order, with received_as_of as YYYY-MM-DD.
- Names at the top of the pages you are given that continue a list from an earlier page go in a first group with heading null and received_as_of null.
- list_updated: the "last updated" date printed on the pages (YYYY-MM-DD), or null.
- Skip page headers, column titles, page numbers and empty rows.`;

/** Scanned registers are long: read them 5 pages at a time, in parallel, then join the lists in order. */
async function fromPdf(mvnoId: string, pdf: Buffer): Promise<Extracted> {
  const c = claude();
  if (!c) throw new Error("PDF import needs the AI to be configured (or upload a CSV)");
  const src = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const pages = src.getPageCount();
  if (pages > 150) throw new Error("This PDF has more than 150 pages: split it, or upload the spreadsheet as CSV");
  const starts = Array.from({ length: Math.ceil(pages / PAGES_PER_CALL) }, (_, i) => i * PAGES_PER_CALL);

  const chunks = await Promise.all(
    starts.map(async (start) => {
      const part = await PDFDocument.create();
      const idx = Array.from({ length: Math.min(PAGES_PER_CALL, pages - start) }, (_, i) => start + i);
      (await part.copyPages(src, idx)).forEach((p) => part.addPage(p));
      const data = Buffer.from(await part.save()).toString("base64");
      const msg = await c.messages
        .stream({
          model: MODEL,
          max_tokens: 32_000,
          output_config: {
            effort: "low",
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                properties: {
                  list_updated: { type: ["string", "null"] },
                  groups: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { heading: { type: ["string", "null"] }, received_as_of: { type: ["string", "null"] }, names: { type: "array", items: { type: "string" } } },
                      required: ["heading", "received_as_of", "names"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["list_updated", "groups"],
                additionalProperties: false,
              },
            },
          },
          system: PDF_SYSTEM,
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
                { type: "text", text: `These are pages ${start + 1}–${start + idx.length} of ${pages}. Transcribe every name on them.` },
              ],
            },
          ],
        })
        .finalMessage();
      await recordAiUsage(msg, { kind: "knowledge", mvnoId });
      if (msg.stop_reason === "max_tokens") throw new Error(`Pages ${start + 1}–${start + idx.length} have too many names to read at once: upload the spreadsheet as CSV`);
      if (msg.stop_reason === "refusal") throw new Error("The AI declined to read this file");
      const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      return JSON.parse(text) as Chunk;
    }),
  );

  // A list that runs over a chunk boundary keeps the heading from the chunk before.
  const rows: Row[] = [];
  let heading: string | null = null;
  let received: string | null = null;
  for (const ch of chunks) {
    for (const g of ch.groups) {
      if (g.heading) {
        heading = g.heading.trim().slice(0, 120);
        received = isDate(g.received_as_of) ? g.received_as_of : null;
      }
      for (const n of g.names) {
        rows.push({ full_name: n, extra: { ...(heading && { list: heading }), ...(received && { received_as_of: received }) } });
      }
    }
  }
  return { updated: chunks.map((c) => c.list_updated).find(isDate) ?? null, rows };
}

// ------------------------------------------------------------------ notify me

/** Tells waiting customers whose exact name is in this batch. */
export async function notifyWatchers(batchId: string) {
  const db = supabaseAdmin();
  const { data: batch } = await db.from("id_batches").select("*, mvno:mvnos(*)").eq("id", batchId).single();
  const mvno = batch.mvno as Mvno;
  const { data: keys } = await db.from("id_register").select("name_key").eq("batch_id", batchId);
  const inBatch = new Set((keys ?? []).map((k) => k.name_key));
  const { data: watchers } = await db.from("id_watch").select("*, conv:conversations(*), contact:contacts(*)").eq("mvno_id", batch.mvno_id).in("status", ["waiting", "needs_template"]);
  let told = 0;
  for (const w of watchers ?? []) {
    if (!inBatch.has(w.name_key)) continue;
    const conv = w.conv as Conversation | null;
    const contact = w.contact as Contact | null;
    let status: "notified" | "needs_template" = "needs_template";
    if (conv && contact) {
      const open = conv.last_inbound_at && Date.now() - new Date(conv.last_inbound_at).getTime() < 24 * 3_600_000;
      const first = w.full_name.split(" ")[0];
      if (open) {
        const m = await sendMessage(mvno, conv, contact, { type: "text", text: `🎉 Good news, ${first}: your National ID card has arrived (${batch.label}). Reply *National ID* for how and when to collect it.` }, { senderType: "bot" });
        if (m.status !== "failed") status = "notified";
      } else if (mvno.id_ready_template_name) {
        const m = await sendMessage(mvno, conv, contact, { type: "template", name: mvno.id_ready_template_name, language: mvno.reminder_template_lang ?? "en", params: [first, batch.label] }, { senderType: "bot" });
        if (m.status !== "failed") status = "notified";
      }
      await logEvent(conv, status === "notified" ? `Told the customer their National ID arrived (${batch.label})` : `National ID arrived (${batch.label}) but the customer couldn't be messaged: 24-hour window closed and no template set`);
    }
    await db.from("id_watch").update({ status, matched_batch_id: batchId, notified_at: status === "notified" ? new Date().toISOString() : null }).eq("id", w.id);
    if (status === "notified") told++;
  }
  await db.from("id_batches").update({ notified_count: told }).eq("id", batchId);
  return told;
}
