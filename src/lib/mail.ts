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

let cache: { at: number; settings: SmtpSettings | null; transport: Transporter | null } | null = null;

export async function getSmtpSettings(): Promise<SmtpSettings | null> {
  const { data } = await supabaseAdmin().rpc("get_smtp_settings");
  return (data as SmtpSettings | null) ?? null;
}

export function forgetSmtp() {
  cache = null;
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

async function transport() {
  if (!cache || Date.now() - cache.at > 60_000) {
    const settings = await getSmtpSettings();
    cache = { at: Date.now(), settings, transport: settings?.enabled ? buildTransport(settings) : null };
  }
  return cache;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Simple, readable HTML email: title, key/value rows, optional button. */
export function renderEmail(opts: { title: string; intro?: string; rows?: [string, string][]; cta?: { label: string; url: string }; footer?: string }) {
  const rows = (opts.rows ?? [])
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;color:#111827">${esc(v).replace(/\n/g, "<br>")}</td></tr>`)
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f5;font-family:Segoe UI,Arial,sans-serif">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:16px;padding:28px;border:1px solid #e5e7eb">
<div style="font-size:12px;color:#6b7280;margin-bottom:8px">Tuvugane</div>
<h1 style="font-size:20px;margin:0 0 12px;color:#111827">${esc(opts.title)}</h1>
${opts.intro ? `<p style="color:#374151;line-height:1.5;margin:0 0 16px">${esc(opts.intro)}</p>` : ""}
${rows ? `<table style="font-size:14px;border-collapse:collapse;margin-bottom:16px">${rows}</table>` : ""}
${opts.cta ? `<a href="${esc(opts.cta.url)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-size:14px">${esc(opts.cta.label)}</a>` : ""}
<p style="color:#9ca3af;font-size:12px;margin:24px 0 0">${esc(opts.footer ?? "You receive this because your address is set for notifications in Tuvugane.")}</p>
</div></body></html>`;
  const text = [opts.title, opts.intro, ...(opts.rows ?? []).map(([k, v]) => `${k}: ${v}`), opts.cta ? `${opts.cta.label}: ${opts.cta.url}` : ""].filter(Boolean).join("\n");
  return { html, text };
}

/**
 * Sends an email. Never throws: notifications must not break customer flows.
 * Returns an error message when sending failed (used by the test button).
 */
export async function sendMail(to: string[], subject: string, body: { html: string; text: string }): Promise<string | null> {
  const recipients = [...new Set(to.map((t) => t.trim()).filter(Boolean))];
  if (!recipients.length) return "No recipients";
  try {
    const { settings, transport: t } = await transport();
    if (!settings) return "SMTP is not configured";
    if (!t) return "Email notifications are switched off";
    await t.sendMail({
      from: { name: settings.from_name, address: settings.from_email },
      to: recipients,
      subject,
      html: body.html,
      text: body.text,
    });
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("email send failed", msg);
    return msg;
  }
}

export const appUrl = () => process.env.APP_URL ?? "https://support-dashboard-iota.vercel.app";
