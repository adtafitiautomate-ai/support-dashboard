import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { supabaseAdmin } from "@/lib/supabase/admin";

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password: string | null;
  from_email: string;
  from_name: string;
  enabled: boolean;
  updated_at: string;
}

type Resolved = { at: number; settings: SmtpSettings | null; transport: Transporter | null; reason: string | null };
const cache = new Map<string, Resolved>(); // "system" or a tenant id

export async function getSmtpSettings(): Promise<SmtpSettings | null> {
  const { data } = await supabaseAdmin().rpc("get_smtp_settings");
  return (data as SmtpSettings | null) ?? null;
}

/** A tenant's own mail server (password included: server-only). */
export async function getTenantSmtp(mvnoId: string): Promise<SmtpSettings | null> {
  const { data } = await supabaseAdmin().rpc("get_tenant_smtp", { p_mvno: mvnoId });
  return (data as SmtpSettings | null) ?? null;
}

export function forgetSmtp() {
  cache.clear();
}

function buildTransport(s: SmtpSettings) {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    requireTLS: !s.secure, // STARTTLS must succeed; never send credentials in clear text
    auth: s.username ? { user: s.username, pass: s.password ?? "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

const resolvedFrom = (settings: SmtpSettings | null, missing: string): Omit<Resolved, "at"> => ({
  settings,
  transport: settings?.enabled ? buildTransport(settings) : null,
  reason: !settings ? missing : !settings.enabled ? "Email is switched off" : null,
});

/**
 * Which server sends for a tenant: its own; else the system server only if the tenant may share it
 * (Admin → tenant → "Use the system email server"). Never another tenant's.
 */
async function transport(mvnoId?: string | null) {
  const key = mvnoId ?? "system";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  let r: Omit<Resolved, "at">;
  if (!mvnoId) r = resolvedFrom(await getSmtpSettings(), "SMTP is not configured");
  else {
    const own = await getTenantSmtp(mvnoId);
    if (own) r = resolvedFrom(own, "");
    else {
      const { data: m } = await supabaseAdmin().from("mvnos").select("shared_email").eq("id", mvnoId).maybeSingle();
      r = m?.shared_email ? resolvedFrom(await getSmtpSettings(), "SMTP is not configured") : { settings: null, transport: null, reason: "This tenant has no email server (Admin → Email)" };
    }
  }
  const entry = { at: Date.now(), ...r };
  cache.set(key, entry);
  return entry;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Simple, readable HTML email: title, key/value rows, optional button. */
export function renderEmail(opts: {
  title: string;
  intro?: string;
  rows?: [string, string][];
  cta?: { label: string; url: string };
  footer?: string;
  /** The tenant the email is sent for: its own logo replaces Tuongee's. */
  brand?: { name: string; logo_url?: string | null } | null;
}) {
  const rows = (opts.rows ?? [])
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;color:#111827">${esc(v).replace(/\n/g, "<br>")}</td></tr>`)
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f5;font-family:Segoe UI,Arial,sans-serif">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:16px;padding:28px;border:1px solid #e5e7eb">
${
    opts.brand?.logo_url
      ? `<img src="${esc(opts.brand.logo_url)}" alt="${esc(opts.brand.name)}" height="56" style="display:block;height:56px;width:auto;max-width:220px;margin-bottom:12px;border:0" />`
      : opts.brand
        ? `<div style="font-size:18px;font-weight:600;color:#111827;margin-bottom:12px">${esc(opts.brand.name)}</div>`
        : `<img src="${appUrl()}/logo.png" alt="Tuongee" width="96" height="76" style="display:block;margin-bottom:12px;border:0" />`
  }
<h1 style="font-size:20px;margin:0 0 12px;color:#111827">${esc(opts.title)}</h1>
${opts.intro ? `<p style="color:#374151;line-height:1.5;margin:0 0 16px">${esc(opts.intro).replace(/\n/g, "<br>")}</p>` : ""}
${rows ? `<table style="font-size:14px;border-collapse:collapse;margin-bottom:16px">${rows}</table>` : ""}
${opts.cta ? `<a href="${esc(opts.cta.url)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-size:14px">${esc(opts.cta.label)}</a>` : ""}
<p style="color:#9ca3af;font-size:12px;margin:24px 0 0">${esc(opts.footer ?? "You receive this because your address is set for notifications in Tuongee.")}</p>
</div></body></html>`;
  const text = [opts.title, opts.intro, ...(opts.rows ?? []).map(([k, v]) => `${k}: ${v}`), opts.cta ? `${opts.cta.label}: ${opts.cta.url}` : ""].filter(Boolean).join("\n");
  return { html, text };
}

/**
 * Sends an email. Never throws: notifications must not break customer flows.
 * Returns an error message when sending failed (used by the test button).
 */
export async function sendMail(to: string[], subject: string, body: { html: string; text: string }, opts: { mvnoId?: string | null } = {}): Promise<string | null> {
  const recipients = [...new Set(to.map((t) => t.trim()).filter(Boolean))];
  if (!recipients.length) return "No recipients";
  let status: "sent" | "failed" | "not_sent" = "sent";
  let error: string | null = null;
  try {
    const { settings, transport: t, reason } = await transport(opts.mvnoId);
    if (!settings || !t) {
      status = "not_sent";
      error = reason ?? "Email is switched off";
      return error;
    }
    await t.sendMail({
      from: { name: settings.from_name || "Tuongee", address: settings.from_email },
      to: recipients,
      subject,
      html: body.html,
      text: body.text,
    });
    return null;
  } catch (e) {
    status = "failed";
    error = e instanceof Error ? e.message : String(e);
    console.error("email send failed", error);
    return error;
  } finally {
    // Email log (Admin → Email): who, subject, result. Never the body: it can contain passwords.
    await supabaseAdmin()
      .from("email_log")
      .insert({ recipients, subject: subject.slice(0, 300), status, error: error?.slice(0, 500) ?? null, mvno_id: opts.mvnoId ?? null })
      .then(({ error: e }) => e && console.error("email log", e.message), () => undefined);
  }
}

export const appUrl = () => process.env.APP_URL ?? "https://support-dashboard-iota.vercel.app";
