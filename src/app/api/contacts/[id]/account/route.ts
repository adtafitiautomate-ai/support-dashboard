import { errorResponse, HttpError, requireAgent } from "@/lib/inbox/auth";
import { getMvno } from "@/lib/inbox/service";
import { hasRealBilling, mvnoApi } from "@/lib/mvno/api";

// Live account snapshot from the MVNO's systems for the agent side panel.
export async function GET(_req: Request, ctx: RouteContext<"/api/contacts/[id]/account">) {
  try {
    const { id } = await ctx.params;
    const { supabase } = await requireAgent();
    const { data: contact } = await supabase.from("contacts").select("id, mvno_id, msisdn, wa_id").eq("id", id).maybeSingle();
    if (!contact) throw new HttpError(404, "Contact not found");
    const mvno = await getMvno(contact.mvno_id);
    // Never show agents invented numbers: only real billing integrations report balances.
    if (!hasRealBilling(mvno.slug)) return Response.json({ connected: false, currency: mvno.currency });
    const api = mvnoApi(mvno.slug);
    const msisdn = contact.msisdn ?? contact.wa_id;
    const [balance, line] = await Promise.all([api.getBalance(msisdn), api.getLineStatus(msisdn)]);
    return Response.json({ connected: true, balance, line, currency: mvno.currency });
  } catch (e) {
    return errorResponse(e);
  }
}
