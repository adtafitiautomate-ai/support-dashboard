import { connection } from "next/server";
import { vtigerEnabled, vtigerOptions } from "@/lib/vtiger";

/** Read-only health check: can the live site reach and sign in to vtiger? (JOBS_SECRET protected) */
export async function GET(req: Request) {
  await connection();
  if (!process.env.JOBS_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.JOBS_SECRET}`) return new Response("Unauthorized", { status: 401 });
  const env = { url: !!process.env.VTIGER_URL, user: !!process.env.VTIGER_USER, key: !!process.env.VTIGER_API_KEY, people: !!process.env.VTIGER_ASSIGNEES };
  if (!vtigerEnabled()) return Response.json({ enabled: false, env });
  const started = Date.now();
  try {
    const o = await vtigerOptions();
    return Response.json({ enabled: true, env, ok: true, ms: Date.now() - started, organizations: o.organizations.length, groups: o.groups.length, people: o.people.length });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    return Response.json({ enabled: true, env, ok: false, ms: Date.now() - started, error: err.message, cause: err.cause?.code ?? err.cause?.message ?? null });
  }
}
