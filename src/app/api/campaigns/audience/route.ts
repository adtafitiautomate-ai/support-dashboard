import { z } from "zod";
import { errorResponse, requireMvnoManager } from "@/lib/inbox/auth";
import { inServiceWindow, resolveAudience } from "@/lib/campaigns";
import { AudienceSchema } from "@/lib/campaign-audience";

const Body = z.object({ mvnoId: z.guid(), audience: AudienceSchema });

/** POST /api/campaigns/audience → how many a campaign would reach, and how many wrote in the last 24 hours. */
export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const { mvno } = await requireMvnoManager(body.mvnoId);
    const [recipients, open] = await Promise.all([resolveAudience(mvno, body.audience), inServiceWindow(body.mvnoId)]);
    return Response.json({ total: recipients.length, inWindow: recipients.filter((r) => open.has(r.id)).length });
  } catch (e) {
    if (e instanceof z.ZodError) return Response.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 });
    return errorResponse(e);
  }
}
