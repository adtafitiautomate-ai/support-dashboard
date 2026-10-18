import "server-only";
import { getAgent } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getMvno } from "./service";
import type { Contact, Conversation, Mvno, Profile } from "@/lib/types";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function errorResponse(e: unknown) {
  if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
  console.error(e);
  return Response.json({ error: "Internal error" }, { status: 500 });
}

export async function requireAgent() {
  const session = await getAgent();
  if (!session) throw new HttpError(401, "Not signed in");
  const { data: profile } = await session.supabase.from("profiles").select("*").eq("id", session.user.id).single();
  return { ...session, profile: profile as Profile };
}

/**
 * Loads a conversation through the agent's RLS-scoped client: if they can read
 * it, they're a member of its MVNO. Mutations then run with the admin client.
 */
export async function requireConversation(id: string): Promise<{
  profile: Profile;
  conv: Conversation;
  contact: Contact;
  mvno: Mvno;
}> {
  const { supabase, profile } = await requireAgent();
  const { data: conv } = await supabase.from("conversations").select("*").eq("id", id).maybeSingle();
  if (!conv) throw new HttpError(404, "Conversation not found");
  const [{ data: contact }, mvno] = await Promise.all([
    supabaseAdmin().from("contacts").select("*").eq("id", conv.contact_id).single(),
    getMvno(conv.mvno_id),
  ]);
  return { profile, conv, contact: contact as Contact, mvno };
}

/** Admins of the MVNO, or super admins. */
export async function requireMvnoAdmin(mvnoId: string) {
  const { supabase, profile } = await requireAgent();
  if (!profile.is_platform_admin) {
    const { data } = await supabase.from("mvno_members").select("role").eq("mvno_id", mvnoId).eq("user_id", profile.id).maybeSingle();
    if (data?.role !== "admin") throw new HttpError(403, "Tenant admins only");
  }
  return { profile, mvno: await getMvno(mvnoId) };
}

/** Supervisors/admins of the MVNO, or super admins. */
export async function requireMvnoManager(mvnoId: string) {
  const { supabase, profile } = await requireAgent();
  if (!profile.is_platform_admin) {
    const { data } = await supabase.from("mvno_members").select("role").eq("mvno_id", mvnoId).eq("user_id", profile.id).maybeSingle();
    if (data?.role !== "admin" && data?.role !== "supervisor") throw new HttpError(403, "Supervisors and admins only");
  }
  return { profile, mvno: await getMvno(mvnoId) };
}

export async function requireMvnoMember(mvnoId: string) {
  const { supabase, profile } = await requireAgent();
  const { data } = await supabase.from("mvnos").select("id").eq("id", mvnoId).maybeSingle();
  if (!data) throw new HttpError(403, "Not a member of this tenant");
  return { profile, mvno: await getMvno(mvnoId) };
}
