import "server-only";
import { appUrl, renderEmail, sendMail } from "@/lib/mail";
import { displayLogin, USERNAME_DOMAIN } from "@/lib/login";
import { supabaseAdmin } from "@/lib/supabase/admin";

type AuthUser = { email?: string | null; app_metadata?: Record<string, unknown> | null };

/** Where to email a user: the contact email admins set, or their login if it's a real address. */
export function contactEmailOf(u: AuthUser | null | undefined): string | null {
  const c = u?.app_metadata?.contact_email;
  if (typeof c === "string" && c) return c;
  return u?.email && !u.email.endsWith(`@${USERNAME_DOMAIN}`) ? u.email : null;
}

/** Sets a user's contact email (kept in app_metadata: only admins can change it). */
export async function setContactEmail(userId: string, email: string) {
  const db = supabaseAdmin();
  const { data } = await db.auth.admin.getUserById(userId);
  const { error } = await db.auth.admin.updateUserById(userId, { app_metadata: { ...(data.user?.app_metadata ?? {}), contact_email: email.toLowerCase() } });
  if (error) throw error;
}

/** Emails sign-in details. Returns null when sent, otherwise why it wasn't. */
export async function mailCredentials(opts: { to: string | null; name: string; login: string; password: string; kind: "welcome" | "reset"; mvnoName?: string }) {
  if (!opts.to) return "No email address on file";
  const first = opts.name.split(/\s+/)[0] || opts.name;
  const welcome = opts.kind === "welcome";
  return sendMail(
    [opts.to],
    welcome ? `Your Tuongee login${opts.mvnoName ? ` for ${opts.mvnoName}` : ""}` : "Your Tuongee password was reset",
    renderEmail({
      title: welcome ? `Welcome to Tuongee, ${first}` : `New password for ${first}`,
      intro: welcome
        ? `An account has been created for you${opts.mvnoName ? ` on the ${opts.mvnoName} team` : ""}. Sign in with the details below, then change your password from your profile menu (top right → Change password).`
        : "Your password was reset by an administrator. Sign in with the temporary password below, then change it from your profile menu (top right → Change password).",
      rows: [
        ["Sign-in page", `${appUrl()}/login`],
        ["Username", displayLogin(opts.login)],
        ["Temporary password", opts.password],
      ],
      cta: { label: "Sign in", url: `${appUrl()}/login` },
      footer: "Keep this email private. If you weren't expecting it, tell your administrator.",
    }),
  );
}
