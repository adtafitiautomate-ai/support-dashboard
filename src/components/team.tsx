"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, KeyRound, Loader2, Mail, UserPlus, Users, X } from "lucide-react";
import { useStore } from "@/lib/store";
import type { MemberRole } from "@/lib/types";
import { displayLogin } from "@/lib/login";
import { PageHeader } from "./app-shell";
import { api, Avatar, Badge, cx, relTime, useNow } from "./ui";

type Member = {
  id: string;
  full_name: string;
  role: MemberRole;
  status: string;
  is_platform_admin: boolean;
  email: string;
  contact_email: string | null;
  disabled: boolean;
  last_sign_in_at: string | null;
};

const field = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-black/30";
const ROLE_HELP: Record<MemberRole, string> = {
  agent: "Agent: handles chats and tickets",
  supervisor: "Supervisor: + insights, reports, knowledge",
  admin: "Admin: + settings, simulator, team",
};

/** Team: MVNO admins create and manage logins for their own MVNO. */
export function TeamView() {
  const now = useNow(60_000);
  const me = useStore((s) => s.me);
  // MVNOs this person administers (super admins: all).
  const mvnos = useStore((s) =>
    [...s.mvnos.values()].filter((m) => s.me?.is_platform_admin || s.memberships.some((x) => x.user_id === s.me?.id && x.mvno_id === m.id && x.role === "admin")),
  );
  const [mvnoId, setMvnoId] = useState(mvnos[0]?.id ?? "");
  const [team, setTeam] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ login: string; password: string; title: string; delivery?: Delivery } | null>(null);
  const [editingEmail, setEditingEmail] = useState<Member | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!mvnoId) return;
    const r = await fetch(`/api/team?mvno=${mvnoId}`);
    const j = await r.json();
    if (!r.ok) return setError(j.error ?? "Could not load team");
    setTeam(j.team);
  }, [mvnoId]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function act(userId: string, body: Record<string, unknown>) {
    setBusy(userId);
    setError(null);
    try {
      const r = await api<{ password?: string } & Delivery>("/api/team", { mvnoId, userId, ...body });
      await load();
      return r;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const mvnoName = mvnos.find((m) => m.id === mvnoId)?.name ?? "";

  return (
    <div className="h-full overflow-y-auto px-6 pb-6">
      <PageHeader
        title="Team"
        subtitle={
          <>
            <Users className="size-3.5" /> Create logins and manage who works on {mvnoName || "your MVNO"}
          </>
        }
        actions={
          <>
            {mvnos.length > 1 && (
              <select value={mvnoId} onChange={(e) => setMvnoId(e.target.value)} className="glass h-9 rounded-full px-3 text-sm outline-none">
                {mvnos.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
            <button onClick={() => setAdding(true)} className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium shadow-md ring-1 ring-black/10 hover:bg-zinc-50">
              <UserPlus className="size-4" /> Add member
            </button>
          </>
        }
      />
      {error && <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <section className="card overflow-hidden">
        {!team ? (
          <div className="grid h-40 place-items-center">
            <Loader2 className="size-5 animate-spin text-muted" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-white/70 text-left text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Member</th>
                  <th className="px-4 py-2.5 font-medium">Role</th>
                  <th className="px-4 py-2.5 font-medium">Last sign-in</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {team.map((m) => {
                  const self = m.id === me?.id;
                  const locked = (m.is_platform_admin && !me?.is_platform_admin) || self;
                  return (
                    <tr key={m.id} className={cx("border-t border-line/70", m.disabled && "opacity-55")}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={m.full_name} size={32} online={m.status === "online"} />
                          <div>
                            <div className="flex items-center gap-1.5 font-medium">
                              {m.full_name}
                              {self && <Badge>You</Badge>}
                              {m.is_platform_admin && <Badge tone="violet">Super admin</Badge>}
                            </div>
                            <div className="text-xs text-muted">
                              {displayLogin(m.email)}
                              {m.contact_email && m.contact_email !== m.email && <> · {m.contact_email}</>}
                              {!m.contact_email && <span className="text-warn"> · no email</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={m.role}
                          disabled={locked || busy === m.id}
                          onChange={(e) => act(m.id, { action: "set_role", role: e.target.value })}
                          className="rounded-lg border border-line bg-white px-2 py-1 text-xs disabled:opacity-60"
                        >
                          {(["agent", "supervisor", "admin"] as const).map((r) => (
                            <option key={r} value={r}>
                              {r[0].toUpperCase() + r.slice(1)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-muted">{m.last_sign_in_at ? `${relTime(m.last_sign_in_at, now)} ago` : "Never"}</td>
                      <td className="px-4 py-3">{m.disabled ? <Badge tone="red">Disabled</Badge> : <Badge tone="green">Active</Badge>}</td>
                      <td className="px-4 py-3">
                        {(!locked || self) && (
                          <div className="flex justify-end gap-1">
                            <button
                              disabled={busy === m.id}
                              onClick={() => setEditingEmail(m)}
                              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted hover:bg-white hover:text-ink"
                            >
                              <Mail className="size-3.5" /> {m.contact_email ? "Email" : "Add email"}
                            </button>
                            {!locked && (
                              <>
                            <button
                              disabled={busy === m.id}
                              onClick={async () => {
                                const r = await act(m.id, { action: "reset_password" });
                                if (r?.password) setSecret({ login: displayLogin(m.email), password: r.password, title: `New password for ${m.full_name}`, delivery: r });
                              }}
                              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted hover:bg-white hover:text-ink"
                            >
                              <KeyRound className="size-3.5" /> Reset password
                            </button>
                            <button
                              disabled={busy === m.id}
                              onClick={() => act(m.id, { action: "set_disabled", disabled: !m.disabled })}
                              className={cx("rounded-lg px-2 py-1 text-xs hover:bg-white", m.disabled ? "text-ink" : "text-danger")}
                            >
                              {m.disabled ? "Enable" : "Disable"}
                            </button>
                            {m.disabled &&
                              (confirmDelete === m.id ? (
                                <span className="flex items-center gap-1 rounded-lg bg-red-50 px-1.5 text-xs text-red-700 ring-1 ring-red-200">
                                  Delete for good?
                                  <button
                                    disabled={busy === m.id}
                                    onClick={async () => {
                                      setConfirmDelete(null);
                                      await act(m.id, { action: "delete" });
                                    }}
                                    className="rounded-md bg-red-600 px-1.5 py-0.5 font-medium text-white"
                                  >
                                    Yes
                                  </button>
                                  <button onClick={() => setConfirmDelete(null)} className="px-1 py-0.5 font-medium">
                                    No
                                  </button>
                                </span>
                              ) : (
                                <button disabled={busy === m.id} onClick={() => setConfirmDelete(m.id)} className="rounded-lg px-2 py-1 text-xs font-medium text-danger hover:bg-white">
                                  Delete
                                </button>
                              ))}
                            <button disabled={busy === m.id} onClick={() => act(m.id, { action: "remove" })} className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-white hover:text-danger">
                              Remove from team
                            </button>
                              </>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!team.length && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-muted">
                      No members yet. Add your first agent.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-3 text-xs text-muted">
        Roles: <b>Agent</b>: chats &amp; tickets · <b>Supervisor</b>: + insights, reports, knowledge · <b>Admin</b>: + settings, simulator, team. Password resets and
        disabling apply to the whole account, so they&apos;re only available for people who work solely on MVNOs you administer.
      </p>

      {adding && (
        <AddMember
          mvnoId={mvnoId}
          mvnoName={mvnoName}
          onClose={() => setAdding(false)}
          onCreated={async (login, password, delivery) => {
            setAdding(false);
            setSecret({ login: displayLogin(login), password, title: "Login created", delivery });
            await load();
          }}
        />
      )}
      {secret && <Secret {...secret} onClose={() => setSecret(null)} />}
      {editingEmail && (
        <EmailDialog
          name={editingEmail.full_name}
          current={editingEmail.contact_email}
          onClose={() => setEditingEmail(null)}
          onSave={async (email) => {
            await api("/api/team", { action: "set_email", mvnoId, userId: editingEmail.id, email });
            setEditingEmail(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-60 grid place-items-center bg-black/25 p-4 backdrop-blur-sm" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="ml-auto text-muted hover:text-ink" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function AddMember({ mvnoId, mvnoName, onClose, onCreated }: { mvnoId: string; mvnoName: string; onClose: () => void; onCreated: (login: string, password: string, d: Delivery) => void }) {
  const [f, setF] = useState({ full_name: "", login: "", email: "", role: "agent" as MemberRole, password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ login: string; password: string } & Delivery>("/api/team", { action: "create", mvnoId, ...f, password: f.password || undefined });
      onCreated(r.login, r.password, r);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Shell title={`Add member to ${mvnoName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Full name</span>
          <input required className={field} value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Username or email</span>
          <input
            required
            autoCapitalize="none"
            spellCheck={false}
            className={field}
            value={f.login}
            onChange={(e) => setF({ ...f, login: e.target.value, email: e.target.value.includes("@") && (!f.email || f.email === f.login) ? e.target.value : f.email })}
            placeholder="e.g. joan"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Email</span>
          <input required type="email" className={field} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="joan@company.com" />
          <span className="mt-1 block text-xs text-muted">Their login details are emailed here.</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Role</span>
          <select className={field} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as MemberRole })}>
            {(["agent", "supervisor", "admin"] as const).map((r) => (
              <option key={r} value={r}>
                {ROLE_HELP[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">Password (optional)</span>
          <input type="text" minLength={10} className={field} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="Leave empty to generate a strong one" />
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 py-2.5 text-sm font-medium text-white disabled:opacity-60">
          {busy && <Loader2 className="size-4 animate-spin" />} Create login & email details
        </button>
      </form>
    </Shell>
  );
}

function Secret({ login, password, title, delivery, onClose }: { login: string; password: string; title: string; delivery?: Delivery; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `Login: ${typeof window !== "undefined" ? window.location.origin : ""}/login\nUsername: ${login}\nPassword: ${password}`;
  return (
    <Shell title={title} onClose={onClose}>
      <DeliveryNote d={delivery} />
      <p className="mb-3 text-sm text-muted">The password is shown only once here; they can change it from their profile menu.</p>
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
    </Shell>
  );
}

type Delivery = { emailed_to?: string | null; email_error?: string | null };

/** "Sent to x" or why the login details weren't emailed. */
function DeliveryNote({ d }: { d?: Delivery }) {
  if (!d) return null;
  return d.emailed_to ? (
    <p className="mb-3 flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
      <Mail className="size-4 shrink-0" /> Sent to <b className="font-semibold">{d.emailed_to}</b>
    </p>
  ) : (
    <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
      Not emailed: {d.email_error ?? "unknown error"}. Copy the details below and share them securely.
    </p>
  );
}

/** Small dialog to add or change where someone's login emails go. */
function EmailDialog({ name, current, onClose, onSave }: { name: string; current: string | null; onClose: () => void; onSave: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return createPortal(
    <div className="fixed inset-0 z-60 grid place-items-center bg-black/25 p-4 backdrop-blur-sm" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onSave(email.trim());
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
        className="w-full max-w-sm space-y-3 rounded-3xl bg-white p-6 shadow-2xl"
      >
        <h2 className="text-lg font-semibold">Email for {name}</h2>
        <p className="text-sm text-muted">Login details and password resets are sent here.</p>
        <input type="email" required autoFocus className={field} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl px-4 py-2 text-sm font-medium text-muted hover:bg-zinc-100">
            Cancel
          </button>
          <button disabled={busy} className="flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            {busy && <Loader2 className="size-4 animate-spin" />} Save
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
