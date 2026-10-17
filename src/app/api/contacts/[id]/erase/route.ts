import { errorResponse, HttpError, requireAgent } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { eraseContact } from "@/lib/privacy";
import { audit } from "@/lib/security";

/** Customer erasure request: supervisors/admins of the contact's MVNO only. */
export async function POST(_req: Request, ctx: RouteContext<"/api/contacts/[id]/erase">) {
  try {
    const { id } = await ctx.params;
    const { supabase, profile } = await requireAgent();
    const { data: contact } = await supabase.from("contacts").select("id, mvno_id, wa_id").eq("id", id).maybeSingle();
    if (!contact) throw new HttpError(404, "Customer not found");
    if (!profile.is_platform_admin) {
      const { data: m } = await supabaseAdmin().from("mvno_members").select("role").eq("mvno_id", contact.mvno_id).eq("user_id", profile.id).maybeSingle();
      if (m?.role !== "admin" && m?.role !== "supervisor") throw new HttpError(403, "Only supervisors and admins can erase customer data");
    }
    const result = await eraseContact(contact.id);
    // Keep only a masked number in the audit trail.
    await audit(profile, "customer.erased", { mvnoId: contact.mvno_id, target: `+${contact.wa_id.slice(0, 5)}•••${contact.wa_id.slice(-2)}`, details: result });
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return errorResponse(e);
  }
}
