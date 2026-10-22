"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Bot, Megaphone, MessageSquareText, Plus, Smartphone, Trash2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { patch, useStore } from "@/lib/store";
import type { CannedResponse, EscalationContact, Mvno } from "@/lib/types";
import { api, Badge, Button, cx } from "./ui";
import { PageHeader } from "./app-shell";
import { DEFAULT_GENERAL_MENU, MAX_MENU_ITEMS, MENU_ACTIONS, type MenuAction, type MenuItem } from "@/lib/menu";

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
        {mvno && tab === "bot" && mvno.kind === "general" && <GeneralSettings key={`g-${mvno.id}`} mvno={mvno} />}
        {mvno && tab === "bot" && mvno.kind === "general" && <CalendarSettings key={`c-${mvno.id}`} mvno={mvno} />}
        {mvno && tab === "bot" && <BrandingSettings key={`b-${mvno.id}`} mvno={mvno} />}
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
    closing_message: mvno.closing_message ?? "Thank you for contacting us. Have a blessed day!",
    bot_persona: mvno.bot_persona,
    sla_first_response_mins: mvno.sla_first_response_mins,
    csat_every_days: mvno.csat_every_days ?? 14,
    reminders_enabled: mvno.reminders_enabled ?? true,
    remind_agent_mins: mvno.remind_agent_mins ?? 10,
    remind_supervisor_mins: mvno.remind_supervisor_mins ?? 30,
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
      <Field label="Closing message" hint="Sent when a chat ends (with the rating question when one is due). Avoid time-of-day greetings so it works at any hour.">
        <input className={input} maxLength={300} value={form.closing_message} onChange={(e) => setForm({ ...form, closing_message: e.target.value })} />
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
        label="Reminders when a customer waits for a reply"
        hint="During working hours. The assigned agent is reminded first; supervisors and admins next (unassigned chats go straight to them). In the app's bell, and by email when email is set up."
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.reminders_enabled} onChange={(e) => setForm({ ...form, reminders_enabled: e.target.checked })} className="size-4" />
            On
          </label>
          <span className="text-muted">Agent after</span>
          <input
            type="number"
            min={1}
            max={1440}
            className={cx(input, "w-20")}
            value={form.remind_agent_mins}
            onChange={(e) => setForm({ ...form, remind_agent_mins: Math.max(1, Math.min(1440, Number(e.target.value) || 1)) })}
            aria-label="Remind the agent after (minutes)"
          />
          <span className="text-muted">min, supervisors after</span>
          <input
            type="number"
            min={1}
            max={1440}
            className={cx(input, "w-20")}
            value={form.remind_supervisor_mins}
            onChange={(e) => setForm({ ...form, remind_supervisor_mins: Math.max(1, Math.min(1440, Number(e.target.value) || 1)) })}
            aria-label="Alert supervisors after (minutes)"
          />
          <span className="text-muted">min</span>
        </div>
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

/** General-business tenants: their own WhatsApp menu, emergency message and sourced-answers rule. */
function GeneralSettings({ mvno }: { mvno: Mvno }) {
  const [items, setItems] = useState<MenuItem[]>(mvno.menu_items?.length ? mvno.menu_items : DEFAULT_GENERAL_MENU);
  const [emergency, setEmergency] = useState(mvno.emergency_message ?? "");
  const [strict, setStrict] = useState(mvno.strict_sources ?? true);
  const saver = useSaver();
  const update = (i: number, patchItem: Partial<MenuItem>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patchItem } : x)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
  };

  return (
    <form
      className="mb-4 space-y-5 card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void saver.run(async () => {
          const clean = items
            .map((x) => ({ ...x, title: x.title.trim().slice(0, 24), description: x.description?.trim().slice(0, 72) || undefined }))
            .filter((x) => x.title);
          if (!clean.length) return { error: { message: "Add at least one menu item" } };
          const res = await supabaseBrowser()
            .from("mvnos")
            .update({ menu_items: clean, emergency_message: emergency.trim() || null, strict_sources: strict })
            .eq("id", mvno.id)
            .select()
            .single();
          if (res.data) patch((s) => s.mvnos.set(mvno.id, res.data as Mvno));
          if (!res.error && !res.data) return { error: { message: "Only tenant admins can change these settings" } };
          return res;
        });
      }}
    >
      <div>
        <div className="text-sm font-medium">WhatsApp menu</div>
        <p className="mt-0.5 text-xs text-muted">Shown when customers say hi or type &ldquo;menu&rdquo;. Up to {MAX_MENU_ITEMS} rows; titles up to 24 characters. Customers can also just type a question.</p>
      </div>
      <ol className="space-y-2">
        {items.map((it, i) => (
          <li key={it.id} className="grid gap-2 rounded-xl bg-zinc-50 p-2.5 ring-1 ring-black/5 sm:grid-cols-[1fr_1.3fr_1fr_auto]">
            <input className={input} maxLength={24} value={it.title} onChange={(e) => update(i, { title: e.target.value })} placeholder="Title" aria-label="Menu title" />
            <input className={input} maxLength={72} value={it.description ?? ""} onChange={(e) => update(i, { description: e.target.value })} placeholder="Short description (optional)" aria-label="Menu description" />
            <select className={input} value={it.action} onChange={(e) => update(i, { action: e.target.value as MenuAction })} aria-label="What it does">
              {MENU_ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
            <div className="flex items-center justify-end gap-0.5">
              <Button type="button" variant="ghost" size="sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                <ArrowUp className="size-4" />
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label="Move down">
                <ArrowDown className="size-4" />
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label={`Remove ${it.title}`}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          </li>
        ))}
      </ol>
      {items.length < MAX_MENU_ITEMS && (
        <Button type="button" onClick={() => setItems([...items, { id: crypto.randomUUID().slice(0, 8), title: "", action: "answer" }])}>
          <Plus className="size-4" /> Add menu item
        </Button>
      )}

      <Field label="Emergency message" hint='Sent instantly when someone taps "Emergency help" or describes an emergency, before an officer is alerted. Include your 24-hour emergency number.'>
        <textarea rows={3} className={input} maxLength={1000} value={emergency} onChange={(e) => setEmergency(e.target.value)} placeholder="🚨 If you are in immediate danger, call the local emergency services. Our 24-hour emergency line: +…" />
      </Field>

      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" className="mt-0.5 size-4" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
        <span>
          <b className="font-medium">Sourced answers only</b>
          <span className="block text-xs text-muted">
            The bot only uses knowledge articles that have a source page and a last-verified date, adds both to every answer, and refuses anything it can&apos;t source.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-3">
        <Button variant="primary">Save menu & rules</Button>
        <SaveMsg msg={saver.msg} />
      </div>
    </form>
  );
}

/** The tenant's own logo, shown on emails sent on its behalf. */
function BrandingSettings({ mvno }: { mvno: Mvno }) {
  const [logo, setLogo] = useState<string | null>(mvno.logo_url ?? null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function upload(file: File) {
    if (!["image/png", "image/jpeg"].includes(file.type)) return setMsg({ ok: false, text: "Use a PNG or JPG image (PNG with a transparent background looks best)." });
    if (file.size > 1024 * 1024) return setMsg({ ok: false, text: "The logo must be under 1 MB." });
    setBusy(true);
    setMsg(null);
    try {
      const up = await api<{ path: string; token: string }>("/api/settings/logo", { action: "upload", mvnoId: mvno.id, mime: file.type, size: file.size });
      const { error } = await supabaseBrowser().storage.from("branding").uploadToSignedUrl(up.path, up.token, file, { contentType: file.type });
      if (error) throw new Error(error.message);
      const r = await api<{ logo_url: string }>("/api/settings/logo", { action: "save", mvnoId: mvno.id, path: up.path });
      setLogo(r.logo_url);
      patch((s) => s.mvnos.set(mvno.id, { ...mvno, logo_url: r.logo_url }));
      setMsg({ ok: true, text: "Logo saved" });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    await api("/api/settings/logo", { action: "remove", mvnoId: mvno.id }).catch(() => undefined);
    setLogo(null);
    patch((s) => s.mvnos.set(mvno.id, { ...mvno, logo_url: null }));
    setBusy(false);
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-4 card p-5">
      <div className="grid h-16 w-40 place-items-center rounded-xl bg-white ring-1 ring-black/5">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt={`${mvno.name} logo`} className="max-h-12 max-w-36 object-contain" />
        ) : (
          <span className="text-xs text-muted">No logo</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">Logo</div>
        <p className="text-xs text-muted">Shown at the top of emails sent for {mvno.name} (alerts, reminders, escalations, appointments). PNG or JPG under 1 MB; a wide logo with a transparent background works best.</p>
        {msg && <p className={cx("mt-1 text-xs", msg.ok ? "text-accent" : "text-danger")}>{msg.text}</p>}
      </div>
      <div className="flex items-center gap-2">
        <label className={cx("cursor-pointer rounded-full bg-zinc-900 px-4 py-2 text-xs font-medium text-white", busy && "opacity-50")}>
          {busy ? "Saving…" : logo ? "Replace" : "Upload logo"}
          <input
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
        </label>
        {logo && (
          <Button type="button" variant="ghost" size="sm" onClick={remove} disabled={busy}>
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

/** Google Calendar for confirmed appointments, and WhatsApp reminders. */
function CalendarSettings({ mvno }: { mvno: Mvno }) {
  const [f, setF] = useState({
    calendarId: mvno.google_calendar_id ?? "",
    minutes: mvno.appointment_minutes ?? 30,
    templateName: mvno.reminder_template_name ?? "",
    templateLang: mvno.reminder_template_lang ?? "en",
    idTemplate: mvno.id_ready_template_name ?? "",
  });
  const [keyJson, setKeyJson] = useState("");
  const [sa, setSa] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const saver = useSaver();
  useEffect(() => {
    void fetch(`/api/settings/calendar?mvno=${mvno.id}`)
      .then((r) => r.json())
      .then((j) => setSa(j.serviceAccount ?? null));
  }, [mvno.id]);

  return (
    <form
      className="mb-4 space-y-4 card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        setTest(null);
        void saver.run(async () => {
          await api("/api/settings/calendar", { action: "save", mvnoId: mvno.id, calendarId: f.calendarId || null, minutes: f.minutes, templateName: f.templateName || null, templateLang: f.templateLang, idTemplate: f.idTemplate || null, serviceAccountJson: keyJson || undefined });
          patch((s) => s.mvnos.set(mvno.id, { ...mvno, google_calendar_id: f.calendarId || null, appointment_minutes: f.minutes, reminder_template_name: f.templateName || null, reminder_template_lang: f.templateLang, id_ready_template_name: f.idTemplate || null }));
          if (keyJson) {
            try {
              setSa(JSON.parse(keyJson).client_email ?? sa);
            } catch {
              /* validated server-side */
            }
            setKeyJson("");
          }
        });
      }}
    >
      <div>
        <div className="text-sm font-medium">Google Calendar & reminders</div>
        <p className="mt-0.5 text-xs text-muted">Confirmed appointments are added to this calendar (and removed if cancelled). Customers get a WhatsApp reminder 24 hours and 2 hours before; staff get a 7:00 agenda.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
        <Field label="Calendar ID" hint="Google Calendar → the calendar's Settings → Integrate calendar → Calendar ID">
          <input className={input} value={f.calendarId} onChange={(e) => setF({ ...f, calendarId: e.target.value.trim() })} placeholder="…@group.calendar.google.com" />
        </Field>
        <Field label="Slot length (min)">
          <input type="number" min={5} max={480} className={input} value={f.minutes} onChange={(e) => setF({ ...f, minutes: Math.max(5, Math.min(480, Number(e.target.value) || 30)) })} />
        </Field>
      </div>
      <Field
        label={`Service account key${sa ? " (connected)" : ""}`}
        hint={sa ? `Connected as ${sa}. Upload a new .json key only to replace it.` : "Upload the .json key of a Google service account, then share the calendar with that account's email (\"Make changes to events\")."}
      >
        <input
          type="file"
          accept="application/json,.json"
          className="block w-full text-sm"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setKeyJson(await file.text());
          }}
        />
        {keyJson && <span className="mt-1 block text-xs text-accent">Key file loaded: click Save to store it securely.</span>}
      </Field>
      <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
        <Field label="Reminder template (optional)" hint="An approved WhatsApp template used when the customer's 24-hour window has closed. Variables: {{1}} name, {{2}} service, {{3}} date & time, {{4}} place. Without it, reminders only go to customers who wrote in the last 24 hours.">
          <input className={input} value={f.templateName} onChange={(e) => setF({ ...f, templateName: e.target.value.trim() })} placeholder="appointment_reminder" />
        </Field>
        <Field label="Language">
          <input className={input} value={f.templateLang} onChange={(e) => setF({ ...f, templateLang: e.target.value.trim() })} placeholder="en" />
        </Field>
      </div>
      <Field label="ID arrived template (optional)" hint="Approved WhatsApp template for telling people on the ID register waiting list that their card arrived, when their 24-hour window has closed. Variables: {{1}} first name, {{2}} batch. Same language as above.">
        <input className={input} value={f.idTemplate} onChange={(e) => setF({ ...f, idTemplate: e.target.value.trim() })} placeholder="national_id_ready" />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary">Save</Button>
        <Button
          type="button"
          onClick={async () => {
            setTest(null);
            try {
              const r = await api<{ name: string; timeZone: string }>("/api/settings/calendar", { action: "test", mvnoId: mvno.id });
              setTest({ ok: true, text: `Connected to "${r.name}" (${r.timeZone})` });
            } catch (err) {
              setTest({ ok: false, text: (err as Error).message });
            }
          }}
        >
          Test connection
        </Button>
        <SaveMsg msg={saver.msg} />
        {test && <span className={cx("text-sm", test.ok ? "text-accent" : "text-danger")}>{test.text}</span>}
      </div>
    </form>
  );
}
