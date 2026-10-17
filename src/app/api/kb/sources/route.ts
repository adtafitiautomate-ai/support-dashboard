import { after } from "next/server";
import { errorResponse, HttpError, requireAgent } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ingestSource, type SourceInput } from "@/lib/kb/ingest";
import { audit, enforce, LIMITS } from "@/lib/security";

export const maxDuration = 300; // long documents take a while to distill

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = /\.(pdf|txt|md|markdown|csv|html?|json)$/i;

/** Adds a training source: multipart `file` or form field `url`, plus `mvnoId`. */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const mvnoId = String(form.get("mvnoId") ?? "");
    const { supabase, profile } = await requireAgent();

    const { data: membership } = await supabase.from("mvno_members").select("role").eq("mvno_id", mvnoId).eq("user_id", profile.id).maybeSingle();
    if (!profile.is_platform_admin && !["admin", "supervisor"].includes(membership?.role ?? "")) {
      throw new HttpError(403, "Only supervisors and admins can train the bot");
    }
    await enforce(`kb:${profile.id}`, LIMITS.kbIngest);

    let input: SourceInput;
    let name: string;
    const file = form.get("file");
    const url = String(form.get("url") ?? "").trim();
    if (file instanceof File && file.size) {
      if (file.size > MAX_BYTES) throw new HttpError(413, "File is too large (20 MB max)");
      if (!ALLOWED.test(file.name)) throw new HttpError(415, "Supported: PDF, TXT, Markdown, CSV, HTML, JSON");
      input = { kind: "file", name: file.name, mime: file.type, bytes: Buffer.from(await file.arrayBuffer()) };
      name = file.name;
    } else if (url) {
      try {
        new URL(url);
      } catch {
        throw new HttpError(400, "That doesn't look like a valid link");
      }
      input = { kind: "url", url };
      name = url.replace(/^https?:\/\//, "").slice(0, 200);
    } else throw new HttpError(400, "Add a file or a link");

    const { data: source, error } = await supabaseAdmin()
      .from("kb_sources")
      .insert({
        mvno_id: mvnoId,
        kind: input.kind,
        name,
        url: input.kind === "url" ? input.url : null,
        mime: input.kind === "file" ? input.mime : null,
        created_by: profile.id,
      })
      .select()
      .single();
    if (error) throw error;

    await audit(profile, "knowledge.source_added", { mvnoId, target: name, details: { kind: input.kind } });
    after(() => ingestSource(source.id, mvnoId, input));
    return Response.json({ source });
  } catch (e) {
    return errorResponse(e);
  }
}
