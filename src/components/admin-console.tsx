"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, Cpu, History, Mail, Check, Copy, KeyRound, Loader2, Pencil, Plus, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import { patch } from "@/lib/store";
import type { MemberRole, Mvno } from "@/lib/types";
import { PageHeader } from "./app-shell";
import { api, Avatar, Badge, cx, relTime, useNow } from "./ui";
import { ActivityLog } from "./admin-activity";
import { EmailSettings } from "./admin-email";
import { AiUsage } from "./admin-ai-usage";
import { RenewToken, TokenCountdown, type TokenInfo } from "./admin-token";
import { displayLogin } from "@/lib/login";

type AdminMvno = Mvno & { connected: boolean; members: number; open: number; with_bot: number; token: TokenInfo | null };
type AdminUser = {
  id: string;
  full_name: string;
  email: string;
  is_platform_admin: boolean;
  status: string;
  disabled: boolean;
  last_sign_in_at: string | null;
  memberships: { mvno_id: string; role: MemberRole }[];
};

const field = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-black/30";
const ROLES: MemberRole[] = ["admin", "supervisor", "agent"];
const roleTone = { admin: "violet", supervisor: "blue", agent: "neutral" } as const;

export function AdminConsole() {
  const [tab, setTab] = useState<"mvnos" | "users" | "email" | "ai" | "activity">("mvnos");
  const [data, setData] = useState<{ mvnos: AdminMvno[]; users: AdminUser[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<AdminMvno> | null>(null);
  const [creatingUser, setCreatingUser] = useState<{ mvno_id?: string } | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string; title: string } | null>(null);
  const [renewing, setRenewing] = useState<AdminMvno | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/overview");
    const j = await r.json();
    if (!r.ok) return setError(j.error ?? "Could not load");
    setData(j);
    // Keep the rest of the app's MVNO list in sync.
    patch((s) => {
      for (const m of j.mvnos as Mvno[]) s.mvnos.set(m.id, m);
    });
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function userAction(body: Record<string, unknown>) {
    setError(null);
    try {
      const res = await api<{ password?: string }>("/api/admin/users", body);
      await load();
      return res;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!data)
    return (
      <div className="grid h-full place-items-center text-sm text-muted">
        {error ?? <Loader2 className="size-5 animate-spin" />}
      </div>
    );

  const mvnoName = (id: string) => data.mvnos.find((m) => m.id === id)?.name ?? "?";

  return (
    <div className="h-full overflow-y-auto px-6 pb-6">
      <PageHeader
        title="Super admin"
        subtitle={
          <>
            <ShieldCheck className="size-3.5" /> Create MVNOs, issue logins and manage access across the platform
          </>
        }
        actions={
          <>
            <button onClick={() => setCreatingUser({})} className="glass flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium">
              <UserPlus className="size-4" /> New user
            </button>
            <button
              onClick={() => setEditing({ name: "", brand_color: "#111827", currency: "UGX", bot_name: "Assistant", wallet_name: "mobile money", sla_first_response_mins: 5 })}
              className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium shadow-md ring-1 ring-black/10 hover:bg-zinc-50"
            >
              <Plus className="size-4" /> New MVNO
            </button>
          </>
        }
      />

      <div className="glass mb-4 inline-flex rounded-full p-1">
        {(
          [
            ["mvnos", "MVNOs", Building2, data.mvnos.length],
            ["users", "Users", Users, data.users.length],
            ["email", "Email", Mail, ""],
            ["ai", "AI usage", Cpu, ""],
            ["activity", "Activity", History, ""],
          ] as const
        ).map(([id, label, Icon, n]) => (
          <button key={id} onClick={() => setTab(id)} className={cx("flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium", tab === id ? "bg-white shadow-sm" : "text-muted hover:text-ink")}>
            <Icon className="size-4" /> {label} <span className="text-[11px] opacity-60">{n}</span>
          </button>
        ))}
      </div>
      {error && <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {tab === "mvnos" && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.mvnos.map((m) => (
            <section key={m.id} className="card p-5">
              <div className="flex items-start gap-3">
                <span className="grid size-11 place-items-center rounded-2xl text-lg font-semibold text-white" style={{ background: m.brand_color }}>
                  {m.name[0]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{m.name}</div>
                  <div className="text-xs text-muted">
                    Bot “{m.bot_name}” · {m.currency} · {m.wallet_name}
                  </div>
                </div>
                <button onClick={() => setEditing(m)} className="rounded-lg p-1.5 text-muted hover:bg-white hover:text-ink" title="Edit">
                  <Pencil className="size-4" />
                </button>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                {[
                  ["Team", m.members],
                  ["With agents", m.open],
                  ["With bot", m.with_bot],
                ].map(([k, v]) => (
                  <div key={k as string} className="rounded-xl bg-white/60 py-2">
                    <div className="text-lg font-semibold tabular-nums">{v}</div>
                    <div className="text-[11px] text-muted">{k}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {m.connected ? <Badge tone="green">WhatsApp {m.wa_display_number}</Badge> : <Badge tone="amber">WhatsApp not connected (simulator)</Badge>}
                {m.connected && <TokenCountdown token={m.token} onRenew={() => setRenewing(m)} />}
                <button onClick={() => setCreatingUser({ mvno_id: m.id })} className="ml-auto flex items-center gap-1 text-xs font-medium text-muted hover:text-ink">
                  <UserPlus className="size-3.5" /> Add user
                </button>
              </div>
            </section>
          ))}
        </div>
      )}

      {tab === "email" && <EmailSettings />}
      {tab === "activity" && <ActivityLog />}
      {tab === "ai" && <AiUsage />}

      {tab === "users" && (
        <section className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-white/70 text-left text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">User</th>
                  <th className="px-4 py-2.5 font-medium">MVNO access</th>
                  <th className="px-4 py-2.5 font-medium">Last sign-in</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <UserRow key={u.id} u={u} mvnos={data.mvnos} mvnoName={mvnoName} act={userAction} onSecret={setSecret} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {editing && (
        <MvnoForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
      {creatingUser && (
        <CreateUser
          mvnos={data.mvnos}
          defaultMvno={creatingUser.mvno_id}
          onClose={() => setCreatingUser(null)}
          onCreated={async (email, password) => {
            setCreatingUser(null);
            setSecret({ email, password, title: "User created" });
            await load();
          }}
        />
      )}
      {secret && <SecretDialog {...secret} onClose={() => setSecret(null)} />}
      {renewing && (
        <RenewToken
          mvnoId={renewing.id}
          mvnoName={renewing.name}
          onClose={() => setRenewing(null)}
          onSaved={async () => {
            setRenewing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function UserRow({
  u,
  mvnos,
  mvnoName,
  act,
  onSecret,
}: {
  u: AdminUser;
  mvnos: AdminMvno[];
  mvnoName: (id: string) => string;
  act: (b: Record<string, unknown>) => Promise<{ password?: string } | undefined>;
  onSecret: (s: { email: string; password: string; title: string }) => void;
}) {
  const now = useNow(60_000);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const available = mvnos.filter((m) => !u.memberships.some((x) => x.mvno_id === m.id));
  const run = async (b: Record<string, unknown>) => {
    setBusy(true);
    const r = await act({ user_id: u.id, ...b });
    setBusy(false);
    return r;
  };

  return (
    <tr className={cx("border-t border-line/70 align-top", u.disabled && "opacity-55")}>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Avatar name={u.full_name} size={32} />
          <div>
            <div className="flex items-center gap-1.5 font-medium">
              {u.full_name}
              {u.is_platform_admin && <Badge tone="violet">Super admin</Badge>}
            </div>
            <div className="text-xs text-muted">{displayLogin(u.email)}</div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {u.memberships.map((m) => (
            <span key={m.mvno_id} className="inline-flex items-center gap-1 rounded-full bg-white/70 py-0.5 pr-1 pl-2 text-xs ring-1 ring-black/5">
              {mvnoName(m.mvno_id)}
              <select
                value={m.role}
                disabled={busy}
                onChange={(e) => run({ action: "set_membership", mvno_id: m.mvno_id, role: e.target.value })}
                className={cx(
                  "rounded-full bg-transparent text-xs font-medium outline-none",
                  roleTone[m.role] === "violet" ? "text-violet-700" : roleTone[m.role] === "blue" ? "text-sky-700" : "text-zinc-600",
                )}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button title="Remove access" disabled={busy} onClick={() => run({ action: "set_membership", mvno_id: m.mvno_id, role: null })} className="rounded-full p-0.5 text-muted hover:text-danger">
                <X className="size-3" />
              </button>
            </span>
          ))}
          {adding ? (
            <select
              autoFocus
              defaultValue=""
              onBlur={() => setAdding(false)}
              onChange={async (e) => {
                setAdding(false);
                if (e.target.value) await run({ action: "set_membership", mvno_id: e.target.value, role: "agent" });
              }}
              className="rounded-full border border-line bg-white px-2 py-0.5 text-xs"
            >
              <option value="">Choose MVNO…</option>
              {available.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            available.length > 0 && (
              <button onClick={() => setAdding(true)} className="rounded-full px-2 py-0.5 text-xs text-muted ring-1 ring-black/10 ring-dashed hover:text-ink">
                + MVNO
              </button>
            )
          )}
          {!u.memberships.length && !u.is_platform_admin && <span className="text-xs text-warn">No access yet</span>}
        </div>
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-muted">{u.last_sign_in_at ? `${relTime(u.last_sign_in_at, now)} ago` : "Never"}</td>
      <td className="px-4 py-3">{u.disabled ? <Badge tone="red">Disabled</Badge> : <Badge tone="green">Active</Badge>}</td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-1">
          <button
            disabled={busy}
            onClick={async () => {
              const r = await run({ action: "reset_password" });
              if (r?.password) onSecret({ email: displayLogin(u.email), password: r.password, title: "Password reset" });
            }}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted hover:bg-white hover:text-ink"
          >
            <KeyRound className="size-3.5" /> Reset password
          </button>
          <button
            disabled={busy}
            onClick={() => run({ action: "set_platform_admin", value: !u.is_platform_admin })}
            className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-white hover:text-ink"
          >
            {u.is_platform_admin ? "Remove super admin" : "Make super admin"}
          </button>
          <button
            disabled={busy}
            onClick={() => run({ action: "set_disabled", disabled: !u.disabled })}
            className={cx("rounded-lg px-2 py-1 text-xs hover:bg-white", u.disabled ? "text-ink" : "text-danger")}
          >
            {u.disabled ? "Enable" : "Disable"}
          </button>
        </div>
      </td>
    </tr>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/25 p-4 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="ml-auto text-muted hover:text-ink" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function L({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

function MvnoForm({ initial, onClose, onSaved }: { initial: Partial<AdminMvno>; onClose: () => void; onSaved: () => void }) {
  const isNew = !initial.id;
  const [f, setF] = useState({
    name: initial.name ?? "",
    brand_color: initial.brand_color ?? "#111827",
    currency: initial.currency ?? "UGX",
    wallet_name: initial.wallet_name ?? "mobile money",
    wallet_ussd: initial.wallet_ussd ?? "",
    care_line: initial.care_line ?? "",
    bot_name: initial.bot_name ?? "Assistant",
    greeting: initial.greeting ?? "",
    sla_first_response_mins: initial.sla_first_response_mins ?? 5,
    retention_days: initial.retention_days ?? 730,
    finance_emails: (initial.finance_emails ?? []).join(", "),
    alert_emails: (initial.alert_emails ?? []).join(", "),
    privacy_notice: initial.privacy_notice ?? "",
    balance: initial.ussd_codes?.balance ?? "",
    self_service: initial.ussd_codes?.self_service ?? "",
    promos: initial.ussd_codes?.promos ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: k === "sla_first_response_mins" || k === "retention_days" ? Number(e.target.value) : e.target.value });

  async function save(e: { preventDefault(): void }) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { balance, self_service, promos, ...rest } = f;
    const mvno = {
      ...rest,
      wallet_ussd: rest.wallet_ussd || null,
      care_line: rest.care_line || null,
      privacy_notice: rest.privacy_notice || null,
      finance_emails: rest.finance_emails.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
      alert_emails: rest.alert_emails.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
      greeting: rest.greeting || undefined,
      ussd_codes: Object.fromEntries(Object.entries({ balance, self_service, promos }).filter(([, v]) => v)),
    };
    try {
      await api("/api/admin/mvnos", isNew ? { action: "create", mvno } : { action: "update", id: initial.id, mvno });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={isNew ? "New MVNO" : `Edit ${initial.name}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <div className="grid grid-cols-[1fr_88px] gap-3">
          <L label="Brand name">
            <input required className={field} value={f.name} onChange={set("name")} placeholder="e.g. SalamTel" />
          </L>
          <L label="Colour">
            <input type="color" className="h-[38px] w-full rounded-xl border border-line bg-white" value={f.brand_color} onChange={set("brand_color")} />
          </L>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <L label="Bot name">
            <input required className={field} value={f.bot_name} onChange={set("bot_name")} />
          </L>
          <L label="Currency">
            <input required maxLength={3} className={field} value={f.currency} onChange={set("currency")} />
          </L>
          <L label="SLA (min)">
            <input type="number" min={1} className={field} value={f.sla_first_response_mins} onChange={set("sla_first_response_mins")} />
          </L>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <L label="Mobile money name">
            <input className={field} value={f.wallet_name} onChange={set("wallet_name")} placeholder="e.g. SalamPay" />
          </L>
          <L label="Mobile money USSD">
            <input className={field} value={f.wallet_ussd} onChange={set("wallet_ussd")} placeholder="*185#" />
          </L>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <L label="Balance code">
            <input className={field} value={f.balance} onChange={set("balance")} placeholder="*131#" />
          </L>
          <L label="Self-service code">
            <input className={field} value={f.self_service} onChange={set("self_service")} placeholder="*100#" />
          </L>
          <L label="Promos code">
            <input className={field} value={f.promos} onChange={set("promos")} placeholder="*150#" />
          </L>
        </div>
        <L label="Other contact channels" hint="Shown by the bot, e.g. “Dial 100 (toll free) or email care@…”">
          <input className={field} value={f.care_line} onChange={set("care_line")} />
        </L>
        <L label="Greeting" hint={isNew ? "Leave empty for a default greeting" : undefined}>
          <input className={field} value={f.greeting} onChange={set("greeting")} />
        </L>
        <L label="Finance emails" hint="Failed-transaction tickets are emailed here (comma-separated)">
          <input className={field} value={f.finance_emails} onChange={set("finance_emails")} placeholder="finance@company.com, recon@company.com" />
        </L>
        <L label="Alert emails" hint="Customer waiting with no agent online; data deletion requests">
          <input className={field} value={f.alert_emails} onChange={set("alert_emails")} placeholder="supervisors@company.com" />
        </L>
        <div className="grid grid-cols-[120px_1fr] gap-3">
          <L label="Keep chats (days)" hint="Then deleted automatically">
            <input type="number" min={30} max={3650} className={field} value={f.retention_days} onChange={set("retention_days")} />
          </L>
          <L label="Privacy notice" hint="Sent once to each new customer (Uganda DPPA 2019)">
            <textarea
              rows={3}
              maxLength={600}
              className={field}
              value={f.privacy_notice}
              onChange={(e) => setF({ ...f, privacy_notice: e.target.value })}
              placeholder="We use your messages only to help you…"
            />
          </L>
        </div>
        {isNew && (
          <p className="rounded-xl bg-zinc-50 px-3 py-2 text-xs text-muted">
            The new MVNO starts on the simulator. Connect its WhatsApp number in Settings → WhatsApp number, then add bundles, outlets and knowledge in the Knowledge page.
          </p>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 py-2.5 text-sm font-medium text-white disabled:opacity-60">
          {busy && <Loader2 className="size-4 animate-spin" />} {isNew ? "Create MVNO" : "Save changes"}
        </button>
      </form>
    </Modal>
  );
}

function CreateUser({
  mvnos,
  defaultMvno,
  onClose,
  onCreated,
}: {
  mvnos: AdminMvno[];
  defaultMvno?: string;
  onClose: () => void;
  onCreated: (email: string, password: string) => void;
}) {
  const [f, setF] = useState({ full_name: "", email: "", mvno_id: defaultMvno ?? mvnos[0]?.id ?? "", role: "agent" as MemberRole, platform_admin: false, password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ email: string; password: string }>("/api/admin/users", {
        action: "create",
        full_name: f.full_name,
        email: f.email,
        password: f.password || undefined,
        mvno_id: f.mvno_id || undefined,
        role: f.role,
        platform_admin: f.platform_admin,
      });
      onCreated(displayLogin(r.email), r.password);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="New user" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <L label="Full name">
          <input required className={field} value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
        </L>
        <L label="Username or email" hint="A plain username (e.g. sophie) signs in without an email address.">
          <input required autoCapitalize="none" spellCheck={false} className={field} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </L>
        <div className="grid grid-cols-2 gap-3">
          <L label="MVNO">
            <select className={field} value={f.mvno_id} onChange={(e) => setF({ ...f, mvno_id: e.target.value })}>
              <option value="">None</option>
              {mvnos.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </L>
          <L label="Role">
            <select className={field} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as MemberRole })}>
              <option value="agent">Agent: handles chats</option>
              <option value="supervisor">Supervisor: + reports, knowledge</option>
              <option value="admin">Admin: + settings, team</option>
            </select>
          </L>
        </div>
        <L label="Password" hint="Leave empty to generate a strong temporary password.">
          <input type="text" minLength={10} className={field} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="Auto-generate" />
        </L>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.platform_admin} onChange={(e) => setF({ ...f, platform_admin: e.target.checked })} />
          Super admin (access to every MVNO and this console)
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 py-2.5 text-sm font-medium text-white disabled:opacity-60">
          {busy && <Loader2 className="size-4 animate-spin" />} Create login
        </button>
      </form>
    </Modal>
  );
}

function SecretDialog({ email, password, title, onClose }: { email: string; password: string; title: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `Login: ${typeof window !== "undefined" ? window.location.origin : ""}/login\nUsername: ${email}\nPassword: ${password}`;
  return (
    <Modal title={title} onClose={onClose}>
      <p className="mb-3 text-sm text-muted">Share these credentials securely. The password is shown only once.</p>
      <pre className="rounded-xl bg-zinc-50 p-3 font-mono text-[13px] whitespace-pre-wrap ring-1 ring-black/5">{text}</pre>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        }}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 py-2.5 text-sm font-medium text-white"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? "Copied" : "Copy credentials"}
      </button>
    </Modal>
  );
}
