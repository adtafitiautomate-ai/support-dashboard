"use client";

import { useEffect, useState } from "react";
import { Bot, Megaphone, MessageSquareText, Plus, Smartphone, Trash2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { patch, useStore } from "@/lib/store";
import type { CannedResponse, EscalationContact, Mvno } from "@/lib/types";
import { api, Badge, Button, cx } from "./ui";
import { PageHeader } from "./app-shell";

type Tab = "bot" | "whatsapp" | "canned" | "escalations";

const TABS: { id: Tab; label: string; icon: typeof Bot }[] = [
  { id: "bot", label: "Bot & SLA", icon: Bot },
  { id: "whatsapp", label: "WhatsApp number", icon: Smartphone },
  { id: "canned", label: "Saved replies", icon: MessageSquareText },
  { id: "escalations", label: "Escalations", icon: Megaphone },
];

export function SettingsView() {
  const mvnos = useStore((s) => [...s.mvnos.values()]);
  const [mvnoId, setMvnoId] = useState(mvnos[0]?.id ?? "");
  const [tab, setTab] = useState<Tab>("bot");
  const mvno = mvnos.find((m) => m.id === mvnoId);

  return (
    <div className="h-full overflow-y-auto px-3 sm:px-6 pb-6">
      <div className="mx-auto max-w-4xl">
        <PageHeader
          title="Settings"
          subtitle="Bot personality, SLAs, WhatsApp connection, saved replies and escalation contacts, per tenant"
          actions={
            <select value={mvnoId} onChange={(e) => setMvnoId(e.target.value)} className="h-9 rounded-full bg-surface px-3 text-sm shadow-sm ring-1 ring-black/5 outline-none">
              {mvnos.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          }
        />
        <div className="mb-4 inline-flex glass rounded-full p-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cx(
                "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition",
                tab === id ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink",
              )}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </div>
        {mvno && tab === "bot" && <BotSettings key={mvno.id} mvno={mvno} />}
        {mvno && tab === "whatsapp" && <WhatsAppSettings key={mvno.id} mvno={mvno} />}
        {mvno && tab === "canned" && <CannedSettings key={mvno.id} mvno={mvno} />}
        {mvno && tab === "escalations" && <EscalationSettings key={mvno.id} mvno={mvno} />}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const input = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-ink/30";

function useSaver() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return {
    msg,
    async run(fn: () => Promise<{ error: { message: string } | null } | void>) {
      setMsg(null);
      try {
        const res = await fn();
        if (res && res.error) throw new Error(res.error.message);
        setMsg({ ok: true, text: "Saved" });
      } catch (e) {
        setMsg({ ok: false, text: (e as Error).message });
      }
    },
  };
}

function SaveMsg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  return msg ? <span className={cx("text-sm", msg.ok ? "text-accent" : "text-danger")}>{msg.text}</span> : null;
}

function BotSettings({ mvno }: { mvno: Mvno }) {
  const [form, setForm] = useState({
    bot_name: mvno.bot_name,
    greeting: mvno.greeting,
    bot_persona: mvno.bot_persona,
    sla_first_response_mins: mvno.sla_first_response_mins,
    csat_every_days: mvno.csat_every_days ?? 14,
    brand_color: mvno.brand_color,
    business_hours: mvno.business_hours ?? { tz: "Africa/Kampala", open: "08:00", close: "20:00", days: [0, 1, 2, 3, 4, 5, 6] },
  });
  const hours = form.business_hours;
  const setHours = (h: Partial<typeof hours>) => setForm({ ...form, business_hours: { ...hours, ...h } });
  const saver = useSaver();
  return (
    <form
      className="space-y-4 card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void saver.run(async () => {
          const res = await supabaseBrowser().from("mvnos").update(form).eq("id", mvno.id).select().single();
          if (res.data) patch((s) => s.mvnos.set(mvno.id, res.data as Mvno));
          if (!res.error && !res.data) return { error: { message: "Only tenant admins can change these settings" } };
          return res;
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Bot name">
          <input className={input} value={form.bot_name} onChange={(e) => setForm({ ...form, bot_name: e.target.value })} />
        </Field>
        <Field label="Brand colour">
          <input type="color" className="h-9 w-full rounded-lg border border-line bg-surface" value={form.brand_color} onChange={(e) => setForm({ ...form, brand_color: e.target.value })} />
        </Field>
      </div>
      <Field label="Greeting" hint="First thing new customers see, above the main menu.">
        <input className={input} value={form.greeting} onChange={(e) => setForm({ ...form, greeting: e.target.value })} />
      </Field>
      <Field label="Personality & tone" hint="Guides how the AI writes. Describe the brand voice, audience and languages.">
        <textarea rows={3} className={input} value={form.bot_persona} onChange={(e) => setForm({ ...form, bot_persona: e.target.value })} />
      </Field>
      <Field label="First-response SLA (minutes)" hint="Countdown starts when the bot hands a chat to the team.">
        <input
          type="number"
          min={1}
          className={cx(input, "w-32")}
          value={form.sla_first_response_mins}
          onChange={(e) => setForm({ ...form, sla_first_response_mins: Number(e.target.value) })}
        />
      </Field>
      <Field label="Ask customers for a rating at most every (days)" hint="After a chat is resolved, customers get the 😀 / 😐 / 😞 survey only if they weren't asked within this many days. 14 ≈ twice a month; 0 = after every chat.">
        <input
          type="number"
          min={0}
          max={365}
          className={cx(input, "w-32")}
          value={form.csat_every_days}
          onChange={(e) => setForm({ ...form, csat_every_days: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })}
        />
      </Field>
      <Field
        label="Team working hours"
        hint={`Outside these hours (${hours.tz}), or when no agent is online, the bot logs a ticket, tells the customer when we'll follow up, and assigns it to the first agent who comes online.`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <input type="time" className={cx(input, "w-32")} value={hours.open} onChange={(e) => setHours({ open: e.target.value })} aria-label="Opens at" />
          <span className="text-sm text-muted">to</span>
          <input type="time" className={cx(input, "w-32")} value={hours.close} onChange={(e) => setHours({ close: e.target.value })} aria-label="Closes at" />
          <div className="flex gap-1">
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => {
              const on = hours.days.includes(i);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setHours({ days: on ? hours.days.filter((x) => x !== i) : [...hours.days, i].sort() })}
                  className={cx("size-8 rounded-full text-xs font-medium ring-1 transition", on ? "bg-zinc-900 text-white ring-zinc-900" : "text-muted ring-black/10 hover:bg-zinc-100")}
                  aria-pressed={on}
                  aria-label={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][i]}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="primary">Save</Button>
        <SaveMsg msg={saver.msg} />
      </div>
    </form>
  );
}

function WhatsAppSettings({ mvno }: { mvno: Mvno }) {
  const simulated = !mvno.wa_phone_number_id || mvno.wa_phone_number_id.startsWith("SIM-");
  const [phoneNumberId, setPhoneNumberId] = useState(simulated ? "" : (mvno.wa_phone_number_id ?? ""));
  const [displayNumber, setDisplayNumber] = useState(mvno.wa_display_number ?? "");
  const [token, setToken] = useState("");
  const saver = useSaver();
  const webhook = typeof window !== "undefined" ? `${window.location.origin}/api/whatsapp/webhook` : "/api/whatsapp/webhook";

  async function save(toSimulator: boolean) {
    await saver.run(async () => {
      const { phoneNumberId: saved } = await api<{ phoneNumberId: string }>("/api/settings/whatsapp", {
        mvnoId: mvno.id,
        phoneNumberId: toSimulator ? null : phoneNumberId,
        displayNumber: displayNumber || undefined,
        accessToken: token || undefined,
      });
      patch((s) => s.mvnos.set(mvno.id, { ...mvno, wa_phone_number_id: saved, wa_display_number: displayNumber || mvno.wa_display_number }));
      setToken("");
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 card p-4">
        <span className="text-sm">Status:</span>
        {simulated ? <Badge tone="violet">Simulator</Badge> : <Badge tone="green">Meta Cloud API · {mvno.wa_phone_number_id}</Badge>}
      </div>
      <form
        className="space-y-4 card p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <Field label="Phone number ID" hint="Meta for Developers → your app → WhatsApp → API Setup → Phone number ID (not the phone number itself).">
          <input className={cx(input, "font-mono")} value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value.trim())} placeholder="e.g. 123456789012345" required />
        </Field>
        <Field label="Display number">
          <input className={input} value={displayNumber} onChange={(e) => setDisplayNumber(e.target.value)} placeholder="+1 555 0100" />
        </Field>
        <Field label="Access token (optional)" hint="Leave empty to use WHATSAPP_ACCESS_TOKEN from the server environment. Stored server-side only, never shown again.">
          <input type="password" className={cx(input, "font-mono")} value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAAG…" />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary">Connect number</Button>
          {!simulated && (
            <Button type="button" onClick={() => save(true)}>
              Switch back to simulator
            </Button>
          )}
          <SaveMsg msg={saver.msg} />
        </div>
      </form>
      <div className="card p-5 text-sm">
        <div className="mb-2 font-medium">Webhook</div>
        <p className="text-muted">In Meta → WhatsApp → Configuration, set:</p>
        <ul className="mt-2 space-y-1">
          <li>
            Callback URL: <code className="rounded bg-surface-2 px-1">{webhook}</code>{" "}
            <span className="text-muted">(must be public HTTPS, so use a tunnel in development)</span>
          </li>
          <li>
            Verify token: value of <code className="rounded bg-surface-2 px-1">WHATSAPP_VERIFY_TOKEN</code>
          </li>
          <li>
            Subscribe to the <code className="rounded bg-surface-2 px-1">messages</code> field
          </li>
        </ul>
      </div>
    </div>
  );
}

function CannedSettings({ mvno }: { mvno: Mvno }) {
  const [rows, setRows] = useState<CannedResponse[]>([]);
  const [draft, setDraft] = useState({ shortcut: "", title: "", body: "" });
  const saver = useSaver();
  useEffect(() => {
    void supabaseBrowser().from("canned_responses").select("*").eq("mvno_id", mvno.id).order("shortcut").then(({ data }) => setRows(data ?? []));
  }, [mvno.id]);

  return (
    <div className="space-y-4">
      <form
        className="space-y-3 card p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void saver.run(async () => {
            const res = await supabaseBrowser()
              .from("canned_responses")
              .insert({ ...draft, shortcut: draft.shortcut.replace(/^\//, "").toLowerCase(), mvno_id: mvno.id })
              .select()
              .single();
            if (res.data) {
              setRows((r) => [...r, res.data as CannedResponse].sort((a, b) => a.shortcut.localeCompare(b.shortcut)));
              setDraft({ shortcut: "", title: "", body: "" });
            }
            return res;
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
          <input className={input} placeholder="/shortcut" value={draft.shortcut} onChange={(e) => setDraft({ ...draft, shortcut: e.target.value })} required />
          <input className={input} placeholder="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required />
        </div>
        <textarea rows={2} className={input} placeholder="Message. Variables: {{name}} {{agent}} {{brand}}" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} required />
        <div className="flex items-center gap-3">
          <Button variant="primary">
            <Plus className="size-4" /> Add reply
          </Button>
          <SaveMsg msg={saver.msg} />
        </div>
      </form>
      <ul className="card divide-y divide-line">
        {rows.map((r) => (
          <li key={r.id} className="flex items-start gap-3 p-4">
            <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">/{r.shortcut}</code>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{r.title}</div>
              <div className="text-sm text-muted">{r.body}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const { error } = await supabaseBrowser().from("canned_responses").delete().eq("id", r.id);
                if (!error) setRows((x) => x.filter((y) => y.id !== r.id));
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Who tickets can be escalated to by email (Finance, Network, Billing...). */
function EscalationSettings({ mvno }: { mvno: Mvno }) {
  const [rows, setRows] = useState<{ id: string; name: string; emails: string }[]>(() =>
    (mvno.escalation_contacts ?? []).map((c) => ({ id: c.id, name: c.name, emails: c.emails.join(", ") })),
  );
  const saver = useSaver();
  const update = (i: number, k: "name" | "emails", v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  return (
    <form
      className="space-y-4 card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void saver.run(async () => {
          const contacts: EscalationContact[] = [];
          for (const r of rows) {
            const emails = r.emails.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
            if (!r.name.trim() && !emails.length) continue;
            if (!r.name.trim()) return { error: { message: "Each contact needs a name, e.g. Finance" } };
            const bad = emails.find((x) => !EMAIL.test(x));
            if (bad) return { error: { message: `"${bad}" is not a valid email` } };
            if (!emails.length) return { error: { message: `Add at least one email for ${r.name}` } };
            contacts.push({ id: r.id, name: r.name.trim().slice(0, 60), emails: [...new Set(emails)].slice(0, 10) });
          }
          const res = await supabaseBrowser().from("mvnos").update({ escalation_contacts: contacts }).eq("id", mvno.id).select().single();
          if (res.data) patch((s) => s.mvnos.set(mvno.id, res.data as Mvno));
          if (!res.error && !res.data) return { error: { message: "Only tenant admins can change these settings" } };
          return res;
        });
      }}
    >
      <div>
        <div className="text-sm font-medium">Escalation contacts</div>
        <p className="mt-0.5 text-xs text-muted">
          Teams an agent can escalate a ticket to from the ticket view. They receive an email with the ticket details and recent chat. Agents can only pick from this
          list; supervisors and admins can also type a one-off address.
        </p>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={r.id} className="grid gap-2 sm:grid-cols-[180px_1fr_auto]">
            <input className={input} placeholder="Team, e.g. Finance" value={r.name} onChange={(e) => update(i, "name", e.target.value)} />
            <input className={input} placeholder="finance@company.com, recon@company.com" value={r.emails} onChange={(e) => update(i, "emails", e.target.value)} />
            <Button type="button" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove ${r.name || "contact"}`}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        {!rows.length && <p className="text-sm text-muted">No escalation contacts yet.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => setRows([...rows, { id: crypto.randomUUID(), name: "", emails: "" }])}>
          <Plus className="size-4" /> Add contact
        </Button>
        <Button variant="primary">Save</Button>
        <SaveMsg msg={saver.msg} />
      </div>
    </form>
  );
}
