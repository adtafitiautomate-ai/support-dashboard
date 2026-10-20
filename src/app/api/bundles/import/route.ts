import { z } from "zod";
import { errorResponse, requireMvnoManager } from "@/lib/inbox/auth";
import { importBundlesFromKnowledge } from "@/lib/kb/bundles";
import { audit, enforce, LIMITS } from "@/lib/security";

export const maxDuration = 120;

/** POST { mvnoId } → rebuild the tenant's bundle menu from its knowledge articles (supervisors/admins). */
export async function POST(req: Request) {
  try {
    const { mvnoId } = z.object({ mvnoId: z.guid() }).parse(await req.json());
    const { profile } = await requireMvnoManager(mvnoId);
    await enforce(`kb:${profile.id}`, LIMITS.kbIngest);
    const r = await importBundlesFromKnowledge(mvnoId);
    await audit(profile, "bundles.imported", { mvnoId, details: r });
    return Response.json(r);
  } catch (e) {
    return errorResponse(e);
  }
}
