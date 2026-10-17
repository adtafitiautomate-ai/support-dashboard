import "server-only";
import crypto from "node:crypto";
import { requireAgent, HttpError } from "@/lib/inbox/auth";

export async function requirePlatformAdmin() {
  const session = await requireAgent();
  if (!session.profile.is_platform_admin) throw new HttpError(403, "Super admin only");
  return session;
}

/** Readable but strong temporary password, e.g. "Relay-k7Qm-9xTp-4Lw2". */
export function tempPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chunk = () => Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join("");
  return `Relay-${chunk()}-${chunk()}-${chunk()}`;
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
