"use client";

import { useEffect, useState } from "react";
import { Bot, MessageSquareText, Plus, Smartphone, Trash2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { patch, useStore } from "@/lib/store";
import type { CannedResponse, Mvno } from "@/lib/types";
import { api, Badge, Button, cx } from "./ui";
import { PageHeader } from "./app-shell";

type Tab = "bot" | "whatsapp" | "canned";

const TABS: { id: Tab; label: string; icon: typeof Bot }[] = [
  { id: "bot", label: "Bot & SLA", icon: Bot },
  { id: "whatsapp", label: "WhatsApp number", icon: Smartphone },
  { id: "canned", label: "Saved replies", icon: MessageSquareText },
];

export function SettingsView() {
  const mvnos = useStore((s) => [...s.mvnos.values()]);
  const [mvnoId, setMvnoId] = useState(mvnos[0]?.id ?? "");
  const [tab, setTab] = useState<Tab>("bot");
  const mvno = mvnos.find((m) => m.id === mvnoId);

  return (
    <div className="h-full overflow-y-auto px-6 pb-6">
      <div className="mx-auto max-w-4xl">
        <PageHeader
          title="Settings"
          subtitle="Bot personality, SLAs, WhatsApp connection and saved replies, per MVNO"
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
    brand_color: mvno.brand_color,
  });
  const saver = useSaver();
  return (
    <form
      className="space-y-4 card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void saver.run(async () => {
          const res = await supabaseBrowser().from("mvnos").update(form).eq("id", mvno.id).select().single();
          if (res.data) patch((s) => s.mvnos.set(mvno.id, res.data as Mvno));
          if (!res.error && !res.data) return { error: { message: "Only MVNO admins can change these settings" } };
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
        {simulated ? <Badge tone="violet">Simulator</Badge> : <Badge tone="green">Meta Cloud API Â· {mvno.wa_phone_number_id}</Badge>}
      </div>
      <form
        className="space-y-4 card p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <Field label="Phone number ID" hint="Meta for Developers â†’ your app â†’ WhatsApp â†’ API Setup â†’ Phone number ID (not the phone number itself).">
          <input className={cx(input, "font-mono")} value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value.trim())} placeholder="e.g. 123456789012345" required />
        </Field>
        <Field label="Display number">
          <input className={input} value={displayNumber} onChange={(e) => setDisplayNumber(e.target.value)} placeholder="+1 555 0100" />
        </Field>
        <Field label="Access token (optional)" hint="Leave empty to use WHATSAPP_ACCESS_TOKEN from the server environment. Stored server-side only, never shown again.">
          <input type="password" className={cx(input, "font-mono")} value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAAGâ€¦" />
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
        <p className="text-muted">In Meta â†’ WhatsApp â†’ Configuration, set:</p>
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
