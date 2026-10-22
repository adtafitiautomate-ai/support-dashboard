import { after, connection, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, HttpError, requireMvnoManager, requireMvnoMember } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { importBatch, nameTokens } from "@/lib/id-register";
import { audit } from "@/lib/security";

export const maxDuration = 300;

/** GET /api/id-register?mvno=<id>[&q=name] → batches, totals, waiting list, and a staff name search. */
export async function GET(req: NextRequest) {
  await connection();
  try {
    const sp = req.nextUrl.searchParams;
    const mvnoId = sp.get("mvno") ?? "";
    await requireMvnoMember(mvnoId);
    const db = supabaseAdmin();
    const q = (sp.get("q") ?? "").trim();
    if (q) {
      // Staff search: every word must appear in the name (any order).
      const words = nameTokens(q).slice(0, 4);
      if (!words.length) return Response.json({ results: [] });
      let query = db.from("id_register").select("id, full_name, extra, batch:id_batches!inner(label, batch_date, status)").eq("mvno_id", mvnoId).eq("batch.status", "ready");
      for (const w of words) query = query.ilike("name_key", `%${w}%`);
      const { data, error } = await query.order("full_name").limit(50);
      if (error) throw error;
      return Response.json({ results: data ?? [] });
    }
    const [{ data: batches }, { data: watch }] = await Promise.all([
      db.from("id_batches").select("*, uploader:profiles(full_name)").eq("mvno_id", mvnoId).order("created_at", { ascending: false }).limit(100),
      db.from("id_watch").select("id, full_name, status, created_at, notified_at, contact:contacts(name, wa_id), batch:id_batches(label)").eq("mvno_id", mvnoId).order("created_at", { ascending: false }).limit(200),
    ]);
    return Response.json({ batches: batches ?? [], watch: watch ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("upload"),
    mvnoId: z.guid(),
    fileName: z.string().min(1).max(200),
    mime: z.enum(["application/pdf", "text/csv"]),
    size: z.number().int().positive().max(25 * 1024 * 1024, "The file must be under 25 MB"),
    label: z.string().max(80).optional(),
    batchDate: z.iso.date().optional(),
    replaces: z.boolean().default(true),
  }),
  z.object({ action: z.literal("process"), mvnoId: z.guid(), batchId: z.guid() }),
  z.object({ action: z.literal("delete"), mvnoId: z.guid(), batchId: z.guid() }),
  z.object({ action: z.literal("unwatch"), mvnoId: z.guid(), watchId: z.guid() }),
]);

/** Upload a register (PDF/CSV), read it, delete a batch, or remove someone from the waiting list (supervisors/admins). */
export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const { profile } = await requireMvnoManager(body.mvnoId);
    const db = supabaseAdmin();

    if (body.action === "upload") {
      const ext = body.mime === "text/csv" ? "csv" : "pdf";
      const path = `${body.mvnoId}/${crypto.randomUUID()}.${ext}`;
      const { data: up, error } = await db.storage.from("registers").createSignedUploadUrl(path);
      if (error || !up) throw error ?? new Error("Could not prepare the upload");
      const { data: batch, error: e2 } = await db
        .from("id_batches")
        .insert({
          mvno_id: body.mvnoId,
          label: body.label?.trim() || `Upload ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`,
          batch_date: body.batchDate ?? null,
          source_name: body.fileName,
          file_path: path,
          uploaded_by: profile.id,
          replaces_previous: body.replaces,
        })
        .select("id")
        .single();
      if (e2) throw e2;
      return Response.json({ batchId: batch.id, path, token: up.token });
    }

    const owned = async (id: string) => {
      const { data } = await db.from("id_batches").select("id, label").eq("id", id).eq("mvno_id", body.mvnoId).maybeSingle();
      if (!data) throw new HttpError(404, "Batch not found");
      return data;
    };

    if (body.action === "process") {
      const b = await owned(body.batchId);
      await db.from("id_batches").update({ status: "processing", error: null }).eq("id", b.id);
      // Reading a long PDF takes a while: do it after replying; the page polls the status.
      after(() => importBatch(b.id).catch((e) => console.error("id register import", e)));
      await audit(profile, "id_register.upload", { mvnoId: body.mvnoId, details: { batch: b.label } });
      return Response.json({ ok: true });
    }

    if (body.action === "delete") {
      const b = await owned(body.batchId);
      const { data: file } = await db.from("id_batches").select("file_path").eq("id", b.id).single();
      if (file?.file_path) await db.storage.from("registers").remove([file.file_path]);
      await db.from("id_batches").delete().eq("id", b.id);
      await audit(profile, "id_register.delete", { mvnoId: body.mvnoId, details: { batch: b.label } });
      return Response.json({ ok: true });
    }

    await db.from("id_watch").delete().eq("id", body.watchId).eq("mvno_id", body.mvnoId);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
