"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Mail, Send, Trash2 } from "lucide-react";
import { api, Badge, cx } from "./ui";

const field = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-black/30";

type Form = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from_email: string;
  from_name: string;
  enabled: boolean;
};

/** Admin → Email: platform SMTP server used for notification emails. */
export function EmailSettings() {
  const [form, setForm] = useState<Form | null>(null);
  const [hasPassword, setHasPassword] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "test" | "remove">(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testTo, setTestTo] = useState("");

  useEffect(() => {
    void fetch("/api/admin/smtp")
      .then((r) => r.json())
      .then((j) => {
        setConfigured(!!j.configured);
        setHasPassword(!!j.has_password);
        setForm({
          host: j.host ?? "",
          port: j.port ?? 587,
          secure: j.secure ?? false,
          username: j.username ?? "",
          password: "",
          from_email: j.from_email ?? "",
          from_name: j.from_name ?? "Tuongee",
          enabled: j.enabled ?? true,
        });
      });
  }, []);

  if (!form)
    return (
      <div className="card grid h-40 place-items-center">
        <Loader2 className="size-5 animate-spin text-muted" />
      </div>
    );

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });

  async function save(e: { preventDefault(): void }) {
    e.preventDefault();
    setBusy("save");
    setMsg(null);
    try {
      await api("/api/admin/smtp", { action: "save", ...form, password: form!.password || undefined, username: form!.username || undefined });
      setConfigured(true);
      if (form!.password) setHasPassword(true);
      setForm({ ...form!, password: "" });
      setMsg({ ok: true, text: "Saved." });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setMsg(null);
    try {
      await api("/api/admin/smtp", { action: "test", to: testTo });
      setMsg({ ok: true, text: `Test email sent to ${testTo}. Check the inbox (and spam folder).` });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    setMsg(null);
    try {
      await api("/api/admin/smtp", { action: "remove" });
      setConfigured(false);
      setHasPassword(false);
      setConfirmRemove(false);
      setForm({ host: "", port: 587, secure: false, username: "", password: "", from_email: "", from_name: "Tuongee", enabled: true });
      setMsg({ ok: true, text: "SMTP settings removed. The server, username and password are deleted; no emails will be sent until new settings are saved." });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <form onSubmit={save} className="card space-y-4 p-5">
        <div className="flex items-center gap-2">
          <Mail className="size-4 text-muted" />
          <h2 className="font-semibold">Outgoing email (SMTP)</h2>
          {configured ? (
            form.enabled ? (
              <Badge tone="green">Active</Badge>
            ) : (
              <Badge tone="amber">Paused</Badge>
            )
          ) : (
            <Badge tone="neutral">Not set up</Badge>
          )}
        </div>
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">SMTP server</span>
            <input required className={field} value={form.host} onChange={(e) => set("host", e.target.value.trim())} placeholder="smtp.gmail.com / smtp.office365.com" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Port</span>
            <input required type="number" className={field} value={form.port} onChange={(e) => set("port", Number(e.target.value))} />
          </label>
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium text-muted">Security</span>
          <div className="inline-flex rounded-full bg-zinc-100 p-1 text-[13px] font-medium">
            {(
              [
                [false, "STARTTLS (port 587)"],
                [true, "SSL/TLS (port 465)"],
              ] as const
            ).map(([v, label]) => (
              <button
                type="button"
                key={label}
                onClick={() => setForm({ ...form, secure: v, port: v ? 465 : 587 })}
                className={cx("rounded-full px-3 py-1.5", form.secure === v ? "bg-white shadow-sm" : "text-muted")}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Username</span>
            <input className={field} autoComplete="off" value={form.username} onChange={(e) => set("username", e.target.value)} placeholder="notifications@company.com" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Password / app password</span>
            <input
              type="password"
              autoComplete="new-password"
              className={field}
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
              placeholder={hasPassword ? "•••••••• (saved, leave blank to keep)" : ""}
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">From address</span>
            <input required type="email" className={field} value={form.from_email} onChange={(e) => set("from_email", e.target.value.trim())} placeholder="care-alerts@company.com" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">From name</span>
            <input className={field} value={form.from_name} onChange={(e) => set("from_name", e.target.value)} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Send notification emails
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button disabled={busy === "save"} className="flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60">
            {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save settings
          </button>
          {configured &&
            (confirmRemove ? (
              <span className="flex items-center gap-2 rounded-xl bg-red-50 px-3 py-1.5 text-sm text-red-700 ring-1 ring-red-200">
                Delete server, username and password?
                <button type="button" onClick={remove} disabled={busy === "remove"} className="flex items-center gap-1 rounded-lg bg-red-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-60">
                  {busy === "remove" && <Loader2 className="size-3 animate-spin" />} Yes, remove
                </button>
                <button type="button" onClick={() => setConfirmRemove(false)} className="rounded-lg px-2 py-1 text-xs font-medium hover:bg-red-100">
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmRemove(true)}
                className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-red-600 ring-1 ring-red-200 transition hover:bg-red-50"
              >
                <Trash2 className="size-4" /> Remove settings
              </button>
            ))}
        </div>
        {msg && <p className={cx("rounded-xl px-3 py-2 text-sm", msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700")}>{msg.text}</p>}
      </form>

      <div className="space-y-4">
        <section className="card p-5">
          <h3 className="font-semibold">Send a test email</h3>
          <p className="mt-1 text-xs text-muted">{configured ? "Sends a test using the saved settings." : "Save the settings first, then send a test here."}</p>
          <div className="mt-3 flex gap-2">
            <input type="email" className={field} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@company.com" />
            <button
              onClick={test}
              disabled={!configured || !testTo || busy === "test"}
              className="grid size-10 shrink-0 place-items-center rounded-xl bg-zinc-900 text-white disabled:opacity-40"
              title="Send test"
            >
              {busy === "test" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </button>
          </div>
        </section>
        <section className="card p-5 text-[13px]">
          <h3 className="font-semibold">What gets emailed</h3>
          <ul className="mt-2 space-y-2 text-muted">
            <li>
              <b className="text-ink">Failed transactions</b> → each tenant&apos;s <i>finance emails</i>, with type, reference and a link to the ticket.
            </li>
            <li>
              <b className="text-ink">Customer waiting, no agent online</b> → the tenant&apos;s <i>alert emails</i>.
            </li>
            <li>
              <b className="text-ink">Data deletion requests</b> → the tenant&apos;s <i>alert emails</i>.
            </li>
          </ul>
          <p className="mt-3 text-xs text-muted">Set recipients per tenant in Tenants → Edit.</p>
          <p className="mt-3 text-xs text-muted">
            Gmail / Microsoft 365: use an <b>app password</b>, not your normal password. Office 365: smtp.office365.com, port 587, STARTTLS.
          </p>
        </section>
      </div>
    </div>
  );
}
