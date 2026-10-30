import { after, connection, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, HttpError, requireMvnoAdmin, requireMvnoManager } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchTemplates, inServiceWindow, MAX_RECIPIENTS, processCampaign, resolveAudience } from "@/lib/campaigns";
import { templateFields } from "@/lib/campaign-templates";
import { AudienceSchema } from "@/lib/campaign-audience";
import { audit, enforce, LIMITS } from "@/lib/security";
import type { Mvno } from "@/lib/types";

/** GET /api/campaigns?mvno=<id> → campaigns with delivery counts. Also resumes any still sending. */
export async function GET(req: NextRequest) {
  await connection();
  try {
    const mvnoId = req.nextUrl.searchParams.get("mvno") ?? "";
    await requireMvnoManager(mvnoId);
    const db = supabaseAdmin();
    const [{ data: campaigns }, { data: stats }] = await Promise.all([
      db
        .from("campaigns")
        .select("id, name, kind, body, audience, template_name, template_language, template_category, status, created_at, finished_at, profiles(full_name)")
        .eq("mvno_id", mvnoId)
        .order("created_at", { ascending: false })
        .limit(50),
      db.rpc("campaign_stats", { p_mvno: mvnoId }),
    ]);
    const byId = new Map(((stats ?? []) as { campaign_id: string }[]).map((s) => [s.campaign_id, s]));
    const list = (campaigns ?? []).map(({ profiles, ...c }) => ({
      ...c,
      by: (profiles as unknown as { full_name: string } | null)?.full_name ?? null,
      stats: byId.get(c.id) ?? null,
    }));
    // Keep sending in the background while someone is watching the page.
    const pending = list.filter((c) => c.status === "sending").map((c) => c.id);
    if (pending.length) {
      after(async () => {
        for (const id of pending) await processCampaign(id).catch((e) => console.error("campaign", e));
      });
    }
    return Response.json({ campaigns: list });
  } catch (e) {
    return errorResponse(e);
  }
}

const Var = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("text"), text: z.string().trim().max(1000) }),
  z.object({ mode: z.literal("name"), fallback: z.string().trim().max(60).default("Customer") }),
]);
const Body = z.object({
  mvnoId: z.guid(),
  name: z.string().trim().min(2).max(80),
  kind: z.enum(["template", "text"]).default("template"),
  // A plain message (kind "text"): only reaches people who wrote in the last 24 hours.
  text: z.string().trim().max(4096).optional(),
  templateName: z.string().max(512).optional(),
  language: z.string().max(20).optional(),
  variables: z.record(z.string(), Var).default({}),
  headerMedia: z.object({ path: z.string().max(300), mime: z.string().max(120) }).optional(),
  audience: AudienceSchema,
});

/** POST /api/campaigns → creates the campaign, queues recipients and starts sending. Tenant admins only. */
export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const { profile } = await requireMvnoAdmin(body.mvnoId);
    await enforce(`campaign:${profile.id}`, LIMITS.campaign);
    const db = supabaseAdmin();
    const { data: row } = await db.from("mvnos").select("*").eq("id", body.mvnoId).single();
    const mvno = row as Mvno;

    let fields: Record<string, unknown>;
    if (body.kind === "text") {
      if (!body.text) throw new HttpError(400, "Type the message");
      fields = { kind: "text", body: body.text };
    } else {
      // Re-read the template from Meta: never trust the browser's copy.
      const t = (await fetchTemplates(mvno)).find((x) => x.name === body.templateName && x.language === body.language);
      if (!t) throw new HttpError(400, "That template isn't approved (or no longer exists) on WhatsApp");
      if (t.unsupported) throw new HttpError(400, `Can't send this template: ${t.unsupported}`);
      for (const f of templateFields(t)) {
        const v = body.variables[f.key];
        if (!v || (v.mode === "text" && !v.text)) throw new HttpError(400, `Fill in ${f.label}`);
      }
      const needsMedia = !!t.header && t.header.format !== "TEXT";
      if (needsMedia && !body.headerMedia?.path.startsWith(`${body.mvnoId}/campaigns/`)) {
        throw new HttpError(400, `This template needs a header ${t.header!.format.toLowerCase()}: upload one`);
      }
      fields = {
        kind: "template",
        template_name: t.name,
        template_language: t.language,
        template_category: t.category,
        template: t,
        variables: body.variables,
        header_media: needsMedia ? { ...body.headerMedia, kind: t.header!.format.toLowerCase() } : null,
      };
    }

    const recipients = await resolveAudience(mvno, body.audience);
    if (!recipients.length) throw new HttpError(400, "No customers to send to (they may all be out of range or opted out)");
    if (recipients.length > MAX_RECIPIENTS) throw new HttpError(400, `Too many recipients (max ${MAX_RECIPIENTS.toLocaleString()} per campaign)`);
    // WhatsApp only delivers a plain message to someone who wrote in the last 24 hours: skip the rest up front.
    const open = body.kind === "text" ? await inServiceWindow(body.mvnoId) : null;
    if (open && !recipients.some((r) => open.has(r.id))) throw new HttpError(400, "None of these customers wrote in the last 24 hours, so a plain message can't reach them. Use a template.");

    const { data: c, error } = await db
      .from("campaigns")
      .insert({ mvno_id: body.mvnoId, name: body.name, audience: body.audience.mode === "selected" ? { mode: "selected", count: body.audience.contactIds.length } : body.audience, created_by: profile.id, ...fields })
      .select("id")
      .single();
    if (error) throw error;
    for (let i = 0; i < recipients.length; i += 1000) {
      const { error: e } = await db.from("campaign_recipients").insert(
        recipients.slice(i, i + 1000).map((r) =>
          open && !open.has(r.id)
            ? { campaign_id: c.id, contact_id: r.id, wa_id: r.wa_id, name: r.name, status: "skipped", error: "Hasn't written in the last 24 hours: only a template can reach them" }
            : { campaign_id: c.id, contact_id: r.id, wa_id: r.wa_id, name: r.name },
        ),
      );
      if (e) throw e;
    }
    await audit(profile, "campaign.started", {
      mvnoId: body.mvnoId,
      target: body.name,
      details: { kind: body.kind, template: fields.template_name ?? null, audience: body.audience.mode, recipients: recipients.length },
    });
    after(() => processCampaign(c.id).catch((e) => console.error("campaign", e)));
    return Response.json({ id: c.id, recipients: recipients.length });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
