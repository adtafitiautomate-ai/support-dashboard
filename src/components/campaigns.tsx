"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCheck, ChevronDown, ExternalLink, Image as ImageIcon, Loader2, Megaphone, Phone, Plus, Reply, Send, Upload, Users, X } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { renderPreview, templateFields, type ParsedTemplate, type VarValue } from "@/lib/campaign-templates";
import { classifyMedia } from "@/lib/whatsapp/outbound-media";
import { hasModule } from "@/lib/modules";
import type { Mvno } from "@/lib/types";
import { api, Badge, cx, relTime, useNow } from "./ui";

type Stats = { total: number; queued: number; sent: number; delivered: number; read: number; failed: number; skipped: number };
export type AudienceMode = "all" | "selected" | "waiting" | "id_untold" | "id_arrived" | "appointments";
const AUDIENCE_LABEL: Record<AudienceMode, string> = {
  all: "everyone",
  selected: "selected customers",
  waiting: "ID waiting list",
  id_untold: "ID arrived, not told",
  id_arrived: "ID arrived",
  appointments: "appointments",
};
type Campaign = {
  id: string;
  name: string;
  kind?: "template" | "text";
  body?: string | null;
  audience?: { mode: AudienceMode; date?: string } | null;
  template_name: string | null;
  template_category: string | null;
  status: "sending" | "done" | "cancelled";
  created_at: string;
  finished_at: string | null;
  by: string | null;
  stats: Stats | null;
};

const field = "w-full rounded-xl border border-line bg-white px-3 py-2 text-sm outline-none focus:border-black/30";

/** Campaign history + builder for one tenant. */
export function CampaignsPanel({
  mvno,
  preset,
  mvnoId,
  mvnoName,
  canSend,
  audienceCount,
  selected,
  onClearSelection,
}: {
  mvno: Mvno;
  preset?: AudienceMode | null; // opened from another page with an audience in mind
  mvnoId: string;
  mvnoName: string;
  canSend: boolean;
  audienceCount: number;
  selected: string[];
  onClearSelection: () => void;
}) {
  const now = useNow(15_000);
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(selected.length > 0 || !!preset);

  const load = useCallback(async () => {
    const r = await fetch(`/api/campaigns?mvno=${mvnoId}`);
    const j = await r.json();
    if (!r.ok) return setError(j.error ?? "Could not load campaigns");
    setCampaigns(j.campaigns);
  }, [mvnoId]);

  // Poll while anything is sending (each poll also lets the server keep sending).
  const sending = campaigns?.some((c) => c.status === "sending");
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    const iv = sending ? setInterval(() => void load(), 4000) : undefined;
    return () => (clearTimeout(t), iv && clearInterval(iv));
  }, [load, sending]);

  return (
    <div className="space-y-4">
      {error && <div className="rounded-xl bg-red-50 px-4 py-2 text-sm text-danger ring-1 ring-red-200">{error}</div>}

      {canSend ? (
        building ? (
          <CampaignBuilder
            mvno={mvno}
            preset={preset ?? null}
            mvnoId={mvnoId}
            mvnoName={mvnoName}
            audienceCount={audienceCount}
            selected={selected}
            onClearSelection={onClearSelection}
            onClose={() => setBuilding(false)}
            onSent={async () => {
              setBuilding(false);
              onClearSelection();
              await load();
            }}
          />
        ) : (
          <button
            onClick={() => setBuilding(true)}
            className="card flex w-full items-center gap-3 p-4 text-left transition hover:bg-white/80"
          >
            <span className="grid size-10 place-items-center rounded-full bg-zinc-900 text-white">
              <Plus className="size-5" />
            </span>
            <span>
              <span className="block font-semibold">New campaign</span>
              <span className="block text-xs text-muted">Send an approved WhatsApp template, or a message, to your {mvnoName} customers</span>
            </span>
          </button>
        )
      ) : (
        <p className="card p-4 text-sm text-muted">Only tenant admins can send campaigns. You can follow their results here.</p>
      )}

      <section className="card p-4 sm:p-5">
        <h3 className="mb-3 text-sm font-semibold">Campaigns</h3>
        {!campaigns ? (
          <div className="grid h-24 place-items-center">
            <Loader2 className="size-5 animate-spin text-muted" />
          </div>
        ) : !campaigns.length ? (
          <p className="py-8 text-center text-sm text-muted">No campaigns yet.</p>
        ) : (
          <ul className="space-y-3">
            {campaigns.map((c) => (
              <CampaignRow key={c.id} c={c} now={now} canSend={canSend} onChanged={load} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CampaignRow({ c, now, canSend, onChanged }: { c: Campaign; now: number; canSend: boolean; onChanged: () => void }) {
  const s = c.stats ?? { total: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 };
  const out = s.sent + s.delivered + s.read; // left our side successfully
  const done = out + s.failed + s.skipped;
  const [failed, setFailed] = useState<{ wa_id: string; name: string | null; error: string | null }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const pct = (n: number) => (s.total ? Math.round((n / s.total) * 100) : 0);

  return (
    <li className="rounded-2xl bg-white/60 p-3 ring-1 ring-black/5 sm:p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 font-medium">
            {c.name}
            {c.status === "sending" ? <Badge tone="blue">Sending…</Badge> : c.status === "cancelled" ? <Badge tone="amber">Cancelled</Badge> : <Badge tone="green">Sent</Badge>}
            {c.kind === "text" ? <Badge>message</Badge> : c.template_category && <Badge>{c.template_category.toLowerCase()}</Badge>}
            {c.audience && c.audience.mode !== "all" && <Badge tone="blue">{AUDIENCE_LABEL[c.audience.mode] ?? c.audience.mode}</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {c.kind === "text" ? <span className="italic">“{(c.body ?? "").slice(0, 60)}{(c.body ?? "").length > 60 ? "…" : ""}”</span> : <>Template <code>{c.template_name}</code></>} · {s.total.toLocaleString()} customers · {relTime(c.created_at, now)} ago
            {c.by ? ` by ${c.by}` : ""}
          </div>
        </div>
        {c.status === "sending" && canSend && (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api(`/api/campaigns/${c.id}`, { action: "cancel" }).catch(() => undefined);
              setBusy(false);
              onChanged();
            }}
            className="rounded-lg px-2 py-1 text-xs font-medium text-danger hover:bg-red-50"
          >
            Stop sending
          </button>
        )}
      </div>

      {/* Progress: delivered + read, sent, failed */}
      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-zinc-100">
        <div className="bg-emerald-500" style={{ width: `${pct(s.read)}%` }} />
        <div className="bg-emerald-300" style={{ width: `${pct(s.delivered)}%` }} />
        <div className="bg-sky-300" style={{ width: `${pct(s.sent)}%` }} />
        <div className="bg-red-400" style={{ width: `${pct(s.failed)}%` }} />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-5">
        <Stat label="Sent" value={out} />
        <Stat label="Delivered" value={s.delivered + s.read} />
        <Stat label="Read" value={s.read} />
        <Stat label="Failed" value={s.failed} tone={s.failed ? "red" : undefined} />
        <Stat label={c.status === "sending" ? "Waiting" : "Skipped"} value={c.status === "sending" ? s.total - done : s.skipped} />
      </div>

      {c.kind === "text" && s.skipped > 0 && c.status !== "sending" && (
        <p className="mt-2 text-xs text-muted">{s.skipped.toLocaleString()} skipped: they hadn&apos;t written in the last 24 hours, so only a template can reach them.</p>
      )}
      {s.failed > 0 && (
        <details
          className="mt-2 text-xs"
          onToggle={async (e) => {
            if ((e.target as HTMLDetailsElement).open && !failed) {
              const r = await fetch(`/api/campaigns/${c.id}`);
              if (r.ok) setFailed((await r.json()).failed);
            }
          }}
        >
          <summary className="cursor-pointer font-medium text-muted hover:text-ink">Why some failed</summary>
          {!failed ? (
            <Loader2 className="mt-2 size-4 animate-spin text-muted" />
          ) : (
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {failed.map((f) => (
                <li key={f.wa_id} className="rounded-lg bg-red-50/70 px-2 py-1">
                  <span className="font-medium">+{f.wa_id}</span>
                  {f.name ? ` (${f.name})` : ""}: <span className="text-red-700">{f.error ?? "unknown error"}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </li>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "red" }) {
  return (
    <div className="rounded-xl bg-zinc-50 px-2 py-1.5">
      <div className={cx("text-base font-semibold tabular-nums", tone === "red" && "text-danger")}>{value.toLocaleString()}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}

// ------------------------------------------------------------------ builder

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

function CampaignBuilder({
  mvno,
  preset,
  mvnoId,
  mvnoName,
  audienceCount,
  selected,
  onClearSelection,
  onClose,
  onSent,
}: {
  mvno: Mvno;
  preset: AudienceMode | null;
  mvnoId: string;
  mvnoName: string;
  audienceCount: number;
  selected: string[];
  onClearSelection: () => void;
  onClose: () => void;
  onSent: () => void;
}) {
  const [templates, setTemplates] = useState<ParsedTemplate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [tKey, setTKey] = useState("");
  const [vars, setVars] = useState<Record<string, VarValue>>({});
  const [media, setMedia] = useState<{ path: string; mime: string; name: string; preview?: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [audience, setAudience] = useState<AudienceMode>(preset ?? (selected.length ? "selected" : "all"));
  const [apptDate, setApptDate] = useState(tomorrow);
  const [kind, setKind] = useState<"template" | "text">("template");
  const [text, setText] = useState("");
  // How many this audience reaches, and how many wrote in the last 24 hours (all a plain message can reach).
  const [reach, setReach] = useState<{ key: string; total: number; inWindow: number } | null>(null);
  const idList = hasModule(mvno, "waiting_list") || hasModule(mvno, "id_register");
  const audienceBody = audience === "selected" ? { mode: "selected", contactIds: selected } : audience === "appointments" ? { mode: "appointments", date: apptDate } : { mode: audience };
  const reachKey = JSON.stringify(audienceBody);
  useEffect(() => {
    if (audience === "selected" && !selected.length) return;
    const t = setTimeout(() => {
      api<{ total: number; inWindow: number }>("/api/campaigns/audience", { mvnoId, audience: JSON.parse(reachKey) })
        .then((r) => setReach({ key: reachKey, ...r }))
        .catch(() => setReach({ key: reachKey, total: 0, inWindow: 0 }));
    }, 250);
    return () => clearTimeout(t);
  }, [mvnoId, reachKey, audience, selected.length]);
  const counted = reach?.key === reachKey ? reach : null;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`/api/campaigns/templates?mvno=${mvnoId}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Could not load templates");
        setTemplates(j.templates);
      })
      .catch((e) => setLoadError((e as Error).message));
  }, [mvnoId]);

  const t = templates?.find((x) => `${x.name}|${x.language}` === tKey);
  const fields = useMemo(() => (t ? templateFields(t) : []), [t]);
  const preview = t ? renderPreview(t, vars) : null;
  const headerKind = t?.header && t.header.format !== "TEXT" ? t.header.format.toLowerCase() : null;
  const count = counted?.total ?? (audience === "selected" ? selected.length : audience === "all" ? audienceCount : 0);
  const reachable = kind === "text" ? (counted?.inWindow ?? 0) : count;
  const missing = !name.trim()
    ? "Give the campaign a name"
    : kind === "text"
      ? !text.trim()
        ? "Type the message"
        : !counted
          ? "Counting customers…"
          : !count
            ? "No customers to send to"
            : !reachable
              ? "None of them wrote in the last 24 hours: use a template"
              : null
      : !t
        ? "Choose a template"
        : t.unsupported
          ? t.unsupported
          : fields.find((f) => !vars[f.key] || (vars[f.key].mode === "text" && !(vars[f.key] as { text: string }).text.trim()))
            ? "Fill in every variable"
            : headerKind && !media
              ? `Upload the header ${headerKind}`
              : !count
                ? "No customers to send to"
                : null;

  function chooseTemplate(key: string) {
    setTKey(key);
    setConfirming(false);
    setMedia(null);
    const next = templates?.find((x) => `${x.name}|${x.language}` === key);
    // Sensible default: a single {{1}} in the greeting is almost always the customer's name.
    const init: Record<string, VarValue> = {};
    if (next) for (const f of templateFields(next)) init[f.key] = f.key.startsWith("body.") && next.body.vars.length === 1 ? { mode: "name", fallback: "Customer" } : { mode: "text", text: "" };
    setVars(init);
  }

  async function uploadHeader(file: File) {
    const c = classifyMedia(file.type, file.size);
    if ("error" in c) return setError(c.error);
    if (c.kind !== headerKind) return setError(`This template's header needs a ${headerKind}, not a ${c.kind}.`);
    setError(null);
    setUploading(true);
    try {
      const up = await api<{ path: string; token: string }>("/api/campaigns/media", { mvnoId, filename: file.name, mime: file.type, size: file.size });
      const { error: e } = await supabaseBrowser().storage.from("wa-media").uploadToSignedUrl(up.path, up.token, file, { contentType: file.type });
      if (e) throw new Error(e.message);
      setMedia({ path: up.path, mime: file.type, name: file.name, preview: c.kind === "image" ? URL.createObjectURL(file) : undefined });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function send() {
    if (kind === "template" && !t) return;
    setBusy(true);
    setError(null);
    try {
      await api(
        "/api/campaigns",
        kind === "text"
          ? { mvnoId, name: name.trim(), kind: "text", text: text.trim(), audience: audienceBody }
          : {
              mvnoId,
              name: name.trim(),
              kind: "template",
              templateName: t!.name,
              language: t!.language,
              variables: vars,
              headerMedia: media ? { path: media.path, mime: media.mime } : undefined,
              audience: audienceBody,
            },
      );
      onSent();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Megaphone className="size-4 text-muted" />
        <h3 className="font-semibold">New campaign</h3>
        <button onClick={onClose} className="ml-auto grid size-8 place-items-center rounded-full text-muted hover:bg-zinc-100" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="min-w-0 space-y-4">
          {/* 1. Name */}
          <Step n={1} title="Name it">
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder={idList ? "e.g. IDs arrived, November list" : "e.g. October data bundles promo"} maxLength={80} />
            <p className="mt-1 text-xs text-muted">For your team only; customers don&apos;t see it.</p>
          </Step>

          {/* 2. What to send */}
          <Step n={2} title="What to send">
            <div className="mb-3 grid grid-cols-2 gap-2">
              <Choice on={kind === "template"} onClick={() => (setKind("template"), setConfirming(false))} title="Approved template" sub="Reaches anyone, any time" />
              <Choice on={kind === "text"} onClick={() => (setKind("text"), setConfirming(false))} title="Message" sub="Only reaches people who wrote in the last 24 hours" />
            </div>
            {kind === "text" ? (
              <>
                <textarea
                  className={cx(field, "h-32 resize-y")}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={4096}
                  placeholder="e.g. Good news: your National ID card has arrived at the Embassy. Collection is Monday to Friday, 9am–3pm. Bring your registration slip."
                />
                <p className="mt-1 text-xs text-muted">
                  Sent exactly as written. WhatsApp only delivers a plain message to someone who wrote to {mvnoName} in the last 24 hours; everyone else is skipped. Use a template to reach them.
                </p>
              </>
            ) : loadError ? (
              <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>
            ) : !templates ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" /> Loading templates from WhatsApp…
              </div>
            ) : (
              <>
                <div className="relative">
                  <select className={cx(field, "appearance-none pr-8")} value={tKey} onChange={(e) => chooseTemplate(e.target.value)}>
                    <option value="">Select a template…</option>
                    {templates.map((x) => (
                      <option key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`} disabled={!!x.unsupported}>
                        {x.name} ({x.language}) · {x.category.toLowerCase()}
                        {x.unsupported ? " · not supported" : ""}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" />
                </div>
                <p className="mt-1 text-xs text-muted">
                  Only templates WhatsApp has approved for {mvnoName} are listed. Create new ones in WhatsApp Manager (Message templates); they appear here once approved.
                </p>
                {t?.category === "MARKETING" && (
                  <p className="mt-2 flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    Marketing messages are charged per delivered message by WhatsApp, and only go to people who agreed to hear from you. Customers can reply STOP to opt out.
                  </p>
                )}
              </>
            )}
          </Step>

          {/* 3. Fill in */}
          {kind === "template" && t && (headerKind || fields.length > 0) && (
            <Step n={3} title="Fill in the details">
              <div className="space-y-3">
                {headerKind && (
                  <div>
                    <span className="mb-1 block text-xs font-medium text-muted">Header {headerKind}</span>
                    {media ? (
                      <div className="flex items-center gap-2.5 rounded-xl bg-zinc-50 p-2 ring-1 ring-black/5">
                        {media.preview ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={media.preview} alt="" className="size-12 rounded-lg object-cover" />
                        ) : (
                          <span className="grid size-12 place-items-center rounded-lg bg-white">
                            <ImageIcon className="size-5 text-muted" />
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm">{media.name}</span>
                        <button onClick={() => setMedia(null)} className="grid size-7 place-items-center rounded-full text-muted hover:bg-white" aria-label="Remove">
                          <X className="size-4" />
                        </button>
                      </div>
                    ) : (
                      <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line px-3 py-4 text-sm text-muted hover:border-black/20">
                        {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                        Upload {headerKind === "image" ? "an image (JPG/PNG, max 5 MB)" : headerKind === "video" ? "a video (MP4, max 16 MB)" : "a document (PDF…)"}
                        <input
                          type="file"
                          className="hidden"
                          accept={headerKind === "image" ? "image/jpeg,image/png" : headerKind === "video" ? "video/mp4,video/3gpp" : "application/pdf"}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void uploadHeader(f);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    )}
                  </div>
                )}
                {fields.map((f) => {
                  const v = vars[f.key] ?? { mode: "text", text: "" };
                  const canName = !f.key.startsWith("button.");
                  return (
                    <div key={f.key}>
                      <span className="mb-1 block text-xs font-medium text-muted">{f.label}</span>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        {canName && (
                          <select
                            className={cx(field, "sm:w-48")}
                            value={v.mode}
                            onChange={(e) => setVars({ ...vars, [f.key]: e.target.value === "name" ? { mode: "name", fallback: "Customer" } : { mode: "text", text: "" } })}
                          >
                            <option value="text">Same text for everyone</option>
                            <option value="name">Customer&apos;s first name</option>
                          </select>
                        )}
                        {v.mode === "text" ? (
                          <input className={field} value={v.text} onChange={(e) => setVars({ ...vars, [f.key]: { mode: "text", text: e.target.value } })} placeholder="Type the text" />
                        ) : (
                          <input
                            className={field}
                            value={v.fallback}
                            onChange={(e) => setVars({ ...vars, [f.key]: { mode: "name", fallback: e.target.value } })}
                            placeholder="If we don't know their name, e.g. Customer"
                            title="Used when we don't have the customer's name"
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Step>
          )}

          {/* 4. Audience */}
          <Step n={kind === "template" && t && (headerKind || fields.length) ? 4 : 3} title="Who gets it">
            <div className="grid gap-2 sm:grid-cols-2">
              <Choice
                on={audience === "all"}
                onClick={() => setAudience("all")}
                title={mvno.kind === "general" ? "Everyone who messaged us" : `All saved customers (${audienceCount.toLocaleString()})`}
                sub={mvno.kind === "general" ? "Except people who opted out" : "Everyone in your number ranges who hasn't opted out"}
              />
              {idList && (
                <>
                  <Choice on={audience === "id_untold"} onClick={() => setAudience("id_untold")} title="ID arrived, not told yet" sub="On the waiting list; their card is in, but we couldn't message them" />
                  <Choice on={audience === "id_arrived"} onClick={() => setAudience("id_arrived")} title="ID arrived (everyone)" sub="Whether or not they were already told" />
                  <Choice on={audience === "waiting"} onClick={() => setAudience("waiting")} title="Still waiting for their ID" sub="On the waiting list, card not on a list yet" />
                </>
              )}
              {hasModule(mvno, "appointments") && (
                <Choice on={audience === "appointments"} onClick={() => setAudience("appointments")} title="Appointments on a day" sub="Confirmed appointments on the date you pick" />
              )}
              <Choice
                on={audience === "selected"}
                disabled={!selected.length}
                onClick={() => setAudience("selected")}
                title={`Selected customers (${selected.length})`}
                sub={selected.length ? "The ones you ticked on the Customers tab" : "Tick customers on the Customers tab first"}
              />
            </div>
            {audience === "selected" && selected.length > 0 && (
              <button onClick={onClearSelection} className="mt-1 text-xs text-muted hover:text-ink">
                Clear selection
              </button>
            )}
            {audience === "appointments" && (
              <input type="date" className={cx(field, "mt-2 w-48")} value={apptDate} onChange={(e) => setApptDate(e.target.value)} aria-label="Appointment date" />
            )}
            <p className="mt-2 text-xs text-muted">
              {!counted ? (
                <Loader2 className="inline size-3.5 animate-spin" />
              ) : kind === "text" ? (
                <>
                  <b className="text-ink">{counted.inWindow.toLocaleString()}</b> of {counted.total.toLocaleString()} can receive a message now (wrote in the last 24 hours)
                  {counted.total > counted.inWindow ? `; ${(counted.total - counted.inWindow).toLocaleString()} will be skipped, use a template to reach them.` : "."}
                </>
              ) : (
                <>
                  <b className="text-ink">{counted.total.toLocaleString()}</b> customer{counted.total === 1 ? "" : "s"} (people who opted out are left out).
                </>
              )}
            </p>
          </Step>
        </div>

        {/* Preview */}
        <div className="lg:sticky lg:top-0 lg:self-start">
          <div className="mb-2 text-xs font-medium text-muted">Preview (as Joan would see it)</div>
          <div className="rounded-2xl bg-[#efeae2] p-3">
            {kind === "text" ? (
              text.trim() ? (
                <div className="max-w-[260px] rounded-xl rounded-tl-sm bg-white px-3 py-2 text-[13px] whitespace-pre-wrap shadow-sm">
                  {text.trim()}
                  <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-zinc-400">
                    now <CheckCheck className="size-3 text-sky-500" />
                  </div>
                </div>
              ) : (
                <p className="py-10 text-center text-xs text-zinc-500">Type the message to see the preview</p>
              )
            ) : preview ? (
              <div className="max-w-[260px] rounded-xl rounded-tl-sm bg-white p-1.5 text-[13px] shadow-sm">
                {headerKind &&
                  (media?.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={media.preview} alt="" className="mb-1 max-h-40 w-full rounded-lg object-cover" />
                  ) : (
                    <div className="mb-1 grid h-28 place-items-center rounded-lg bg-zinc-100 text-xs text-muted">{headerKind}</div>
                  ))}
                <div className="px-1.5 pb-1">
                  {preview.header && <div className="mb-1 font-semibold">{preview.header}</div>}
                  <div className="whitespace-pre-wrap">{preview.body}</div>
                  {preview.footer && <div className="mt-1 text-[11px] text-zinc-500">{preview.footer}</div>}
                  <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-zinc-400">
                    now <CheckCheck className="size-3 text-sky-500" />
                  </div>
                </div>
                {t!.buttons.map((b) => (
                  <div key={b.index} className="flex items-center justify-center gap-1.5 border-t border-zinc-100 py-2 text-[13px] font-medium text-sky-600">
                    {b.type === "URL" ? <ExternalLink className="size-3.5" /> : b.type === "PHONE_NUMBER" ? <Phone className="size-3.5" /> : <Reply className="size-3.5" />}
                    {b.text}
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-10 text-center text-xs text-zinc-500">Choose a template to see the preview</p>
            )}
          </div>
        </div>
      </div>

      {error && <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {confirming ? (
          <>
            <span className="text-sm">
              {kind === "text" ? (
                <>
                  Send this message to <b>{reachable.toLocaleString()}</b> customer{reachable === 1 ? "" : "s"} now
                  {count > reachable ? ` (${(count - reachable).toLocaleString()} skipped)` : ""}?
                </>
              ) : (
                <>
                  Send <b>{t?.name}</b> to <b>{count.toLocaleString()}</b> customer{count === 1 ? "" : "s"} now?
                </>
              )}
            </span>
            <button
              onClick={send}
              disabled={busy}
              className="flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Yes, send
            </button>
            <button onClick={() => setConfirming(false)} className="rounded-full px-3 py-2 text-sm font-medium text-muted hover:bg-zinc-100">
              Back
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setConfirming(true)}
              disabled={!!missing}
              className="flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              <Users className="size-4" /> Review & send to {reachable.toLocaleString()}
            </button>
            {missing && <span className="text-xs text-muted">{missing}</span>}
          </>
        )}
      </div>
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className="grid size-5 place-items-center rounded-full bg-zinc-900 text-[11px] text-white">{n}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

function Choice({ on, disabled, onClick, title, sub }: { on: boolean; disabled?: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx("rounded-xl p-3 text-left ring-1 transition disabled:opacity-50", on ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white ring-black/10 hover:bg-zinc-50")}
    >
      <div className="text-sm font-medium">{title}</div>
      <div className={cx("text-xs", on ? "text-white/70" : "text-muted")}>{sub}</div>
    </button>
  );
}
