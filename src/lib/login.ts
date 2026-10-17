// Agents can sign in with a plain username (e.g. "sophie"). Supabase Auth needs an
// email, so usernames map to an internal, never-mailed address.
export const USERNAME_DOMAIN = "tuvugane.local";

export function toLoginEmail(input: string) {
  const v = input.trim().toLowerCase();
  return v.includes("@") ? v : `${v}@${USERNAME_DOMAIN}`;
}

/** "sophie@tuvugane.local" → "sophie"; real emails are shown as-is. */
export function displayLogin(email: string) {
  return email.endsWith(`@${USERNAME_DOMAIN}`) ? email.slice(0, -USERNAME_DOMAIN.length - 1) : email;
}
