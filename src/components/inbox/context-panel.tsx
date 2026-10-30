"use client";

import { useEffect, useState } from "react";
import { BellRing, CalendarCheck, IdCard, Loader2, MapPin, Package, Phone, RefreshCw, Smartphone, Sparkles, Tag, Wallet, X } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { upsertContact, upsertConversation, useStore } from "@/lib/store";
import type { Conversation, Delivery, Recharge } from "@/lib/types";
import { api, Avatar, Badge, cx, relTime, useNow } from "@/components/ui";
import { formatData, formatMoney, formatPhone } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { modulesOf } from "@/lib/modules";

type Account =
  | { connected: false; currency: string }
  | {
      connected: true;
      balance: { airtime: number; dataMb: number; minutes: number; sms: number; expiresAt: string; activeBundle: string | null };
      line: { state: string; kyc: string; simType: string; network: string };
      currency: string;
    };

type Tab = "overview" | "account" | "history";
type Appt = { id: string; service: string; preferred: string | null; full_name: string | null; status: string; scheduled_at: string | null; created_at: string };
type Watch = { id: string; full_name: string; status: "waiting" | "notified" | "needs_template"; created_at: string; notified_at: string | null };
type IdCheck = { id: string; body: string; created_at: string };
const APPT_TONE: Record<string, "green" | "amber" | "red" | "neutral" | "blue"> = { requested: "amber", confirmed: "green", completed: "blue", no_show: "red", cancelled: "neutral" };
const DELIVERY_STATUSES: Delivery["status"][] = ["requested", "scheduled", "out_for_delivery", "delivered", "failed", "cancelled"];

export function ContextPanel({ conversation: c }: { conversation: Conversation }) {
  const now = useNow(30_000);
  const { onEvent } = useWorkspace();
  const contact = useStore((s) => s.contacts.get(c.contact_id));
  const mvno = useStore((s) => s.mvnos.get(c.mvno_id));
  const [tab, setTab] = useState<Tab>("overview");
  const [account, setAccount] = useState<Account | null>(null);
  const [recharges, setRecharges] = useState<Recharge[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [history, setHistory] = useState<Conversation[]>([]);
  const [appts, setAppts] = useState<Appt[]>([]);
  const [watch, setWatch] = useState<Watch[]>([]);
  const [idChecks, setIdChecks] = useState<IdCheck[]>([]);
  // What this tenant's Account tab shows (a string keeps the effect's dependency stable).
  const modKey = mvno ? [...modulesOf(mvno)].sort().join(",") : "";
  const [summarizing, setSummarizing] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");

  useEffect(() => {
    const supabase = supabaseBrowser();
    const mods = new Set(modKey.split(","));
    const load = () => {
      if (mods.has("topups")) void supabase.from("recharges").select("*").eq("contact_id", c.contact_id).order("created_at", { ascending: false }).limit(5).then(({ data }) => setRecharges(data ?? []));
      if (mods.has("deliveries")) void supabase.from("deliveries").select("*").eq("contact_id", c.contact_id).order("created_at", { ascending: false }).limit(5).then(({ data }) => setDeliveries(data ?? []));
      if (mods.has("appointments"))
        void supabase
          .from("appointments")
          .select("id, service, preferred, full_name, status, scheduled_at, created_at")
          .eq("contact_id", c.contact_id)
          .order("created_at", { ascending: false })
          .limit(5)
          .then(({ data }) => setAppts(data ?? []));
      if (mods.has("waiting_list") || mods.has("id_register"))
        void supabase.from("id_watch").select("id, full_name, status, created_at, notified_at").eq("contact_id", c.contact_id).order("created_at", { ascending: false }).then(({ data }) => setWatch(data ?? []));
    };
    load();
    void supabase
      .from("conversations")
      .select("*")
      .eq("contact_id", c.contact_id)
      .order("created_at", { ascending: false })
      .limit(10)
      .then(({ data }) => {
        setHistory(data ?? []);
        // The bot notes every ID check in the chat ("National ID check for "…": found …").
        if (mods.has("id_register") && data?.length)
          void supabase
            .from("messages")
            .select("id, body, created_at")
            .in("conversation_id", data.map((h) => h.id))
            .eq("type", "event")
            .like("body", "National ID check for%")
            .order("created_at", { ascending: false })
            .limit(5)
            .then(({ data: m }) => setIdChecks((m ?? []) as IdCheck[]));
      });
    if (mods.has("billing"))
      void fetch(`/api/contacts/${c.contact_id}/account`)
        .then((r) => (r.ok ? r.json() : null))
        .then(setAccount);
    // Live: refresh when this customer's records change.
    return onEvent((table, record) => {
      if (["recharges", "deliveries", "appointments", "id_watch"].includes(table) && record.contact_id === c.contact_id) load();
    });
  }, [c.contact_id, onEvent, modKey]);
  const mods = new Set(modKey.split(","));

  if (!contact) return null;

  async function summarize() {
    setSummarizing(true);
    setAiError(null);
    try {
      const { conversation } = await api<{ conversation: Conversation }>(`/api/conversations/${c.id}/actions`, { action: "summarize" });
      upsertConversation(conversation);
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setSummarizing(false);
    }
  }

  async function updateTags(tags: string[]) {
    upsertContact({ ...contact!, tags });
    await supabaseBrowser().from("contacts").update({ tags }).eq("id", contact!.id);
  }

  async function setDeliveryStatus(d: Delivery, status: Delivery["status"]) {
    setDeliveries((list) => list.map((x) => (x.id === d.id ? { ...x, status } : x)));
    await supabaseBrowser().from("deliveries").update({ status }).eq("id", d.id);
  }

  const sentimentEmoji = { positive: "🙂", neutral: "😐", negative: "😠" } as const;

  return (
    <aside className="card flex w-full shrink-0 flex-col overflow-hidden lg:w-[310px]">
      <div className="flex items-center justify-between px-4 pt-3.5">
        <span className="text-[13px] font-medium text-muted">Profile</span>
        <span className="text-[11px] text-muted">{c.ticket_no ? `Ticket #${c.ticket_no}` : "Bot chat"}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {/* Identity */}
        <div className="flex flex-col items-center pt-3 pb-4 text-center">
          <Avatar name={contact.name ?? contact.wa_id} size={76} />
          <div className="mt-2.5 text-[15px] font-semibold">{contact.name ?? "Unknown customer"}</div>
          <div className="text-xs text-muted">
            {mods.has("billing") && `${contact.plan ?? "Prepaid"} · `}
            {mvno?.name}
          </div>
        </div>

        <div className="space-y-2">
          <InfoBox icon={<Phone className="size-3.5" />} label="WhatsApp">
            {formatPhone(contact.wa_id)}
          </InfoBox>
          {contact.last_location && (
            <InfoBox icon={<MapPin className="size-3.5" />} label="Last location">
              <a
                href={`https://www.google.com/maps?q=${contact.last_location.lat},${contact.last_location.lng}`}
                target="_blank"
                rel="noreferrer"
                className="hover:underline"
              >
                Shared {relTime(contact.last_location.at, now)} ago ↗
              </a>
            </InfoBox>
          )}
          <InfoBox icon={<Tag className="size-3.5" />} label="Tags">
            <div className="flex flex-wrap items-center gap-1">
              {contact.tags.map((t) => (
                <Badge key={t} tone={t === "vip" ? "amber" : "blue"}>
                  {t}
                  <button onClick={() => updateTags(contact.tags.filter((x) => x !== t))} className="opacity-60 hover:opacity-100" aria-label={`Remove ${t}`}>
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const t = tagInput.trim().toLowerCase();
                  if (t && !contact.tags.includes(t)) void updateTags([...contact.tags, t]);
                  setTagInput("");
                }}
              >
                <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="+ add" className="w-14 bg-transparent text-xs outline-none placeholder:text-muted" />
              </form>
            </div>
          </InfoBox>
        </div>

        {/* Tabs */}
        <div className="mt-4 mb-3 grid grid-cols-3 rounded-full bg-surface-2 p-1 text-[12.5px] font-medium">
          {(["overview", "account", "history"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cx("rounded-full py-1.5 capitalize transition", tab === t ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink")}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "overview" && (
          <div className="space-y-3">
            <div className="rounded-2xl bg-surface-2 p-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted">
                <Sparkles className="size-3.5 text-violet-500" /> AI summary
                <button onClick={summarize} disabled={summarizing} className="ml-auto hover:text-ink" title="Regenerate">
                  {summarizing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                </button>
              </div>
              {c.subject && <div className="text-[13px] font-medium">{c.subject}</div>}
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
                {c.ai_summary ?? "Written automatically when the bot hands a chat to the team."}
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                {c.category && <Badge>{c.category}</Badge>}
                {c.sentiment && (
                  <Badge tone={c.sentiment === "negative" ? "red" : c.sentiment === "positive" ? "green" : "neutral"}>
                    {sentimentEmoji[c.sentiment]} {c.sentiment}
                  </Badge>
                )}
              </div>
              {aiError && <p className="mt-1 text-xs text-danger">{aiError}</p>}
            </div>
            <div className="rounded-2xl bg-surface-2 p-3 text-[13px]">
              <Row k="Opened" v={new Date(c.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} />
              {c.handoff_at && <Row k="Handed to team" v={`${relTime(c.handoff_at, now)} ago`} />}
              {c.first_response_at && c.handoff_at && (
                <Row k="First response" v={`${Math.max(1, Math.round((+new Date(c.first_response_at) - +new Date(c.handoff_at)) / 60000))} min`} />
              )}
              {c.csat_score && <Row k="CSAT" v={"★".repeat(c.csat_score) + "☆".repeat(5 - c.csat_score)} />}
            </div>
          </div>
        )}

        {tab === "account" && (
          <div className="space-y-3">
            {mods.has("appointments") && (
              <Section icon={<CalendarCheck className="size-3.5" />} title="Appointments">
                {appts.length === 0 && <div className="text-xs text-muted">None yet</div>}
                <ul className="space-y-2">
                  {appts.map((a) => (
                    <li key={a.id} className="rounded-xl bg-surface p-2 text-[13px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{a.service}</span>
                        <Badge tone={APPT_TONE[a.status] ?? "neutral"}>{a.status.replace("_", " ")}</Badge>
                      </div>
                      <div className="text-xs text-muted">
                        {a.scheduled_at
                          ? new Date(a.scheduled_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: mvno?.business_hours?.tz })
                          : `Asked for: ${a.preferred ?? "–"}`}
                      </div>
                    </li>
                  ))}
                </ul>
                <a href="/appointments" className="mt-2 block text-xs text-muted hover:text-ink">
                  Open appointments →
                </a>
              </Section>
            )}

            {(mods.has("waiting_list") || mods.has("id_register")) && (
              <Section icon={<BellRing className="size-3.5" />} title="ID waiting list">
                {watch.length === 0 && <div className="text-xs text-muted">Not on the waiting list</div>}
                <ul className="space-y-1.5">
                  {watch.map((w) => (
                    <li key={w.id} className="flex flex-wrap items-center gap-1.5 text-[13px]">
                      <span className="font-medium">{w.full_name}</span>
                      {w.status === "waiting" ? (
                        <Badge tone="amber">Waiting since {new Date(w.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</Badge>
                      ) : w.status === "notified" ? (
                        <Badge tone="green">Arrived · told</Badge>
                      ) : (
                        <Badge tone="red">Arrived · not told yet</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {mods.has("id_register") && (
              <Section icon={<IdCard className="size-3.5" />} title="ID checks">
                {idChecks.length === 0 && <div className="text-xs text-muted">No checks yet</div>}
                <ul className="space-y-1.5">
                  {idChecks.map((m) => {
                    const [, name, result] = /^National ID check for "(.*)": (.*)$/.exec(m.body) ?? [];
                    return (
                      <li key={m.id} className="flex items-center gap-2 text-[13px]">
                        <span className={cx("size-1.5 shrink-0 rounded-full", result?.startsWith("found") ? "bg-emerald-500" : "bg-amber-500")} />
                        <span className="min-w-0 flex-1 truncate">
                          {name ?? m.body}
                          <span className="block text-[11px] text-muted">{result === "none" ? "not on the list" : result}</span>
                        </span>
                        <span className="text-[11px] text-muted">{relTime(m.created_at, now)}</span>
                      </li>
                    );
                  })}
                </ul>
              </Section>
            )}

            {!["billing", "topups", "deliveries", "appointments", "waiting_list", "id_register"].some((k) => mods.has(k)) && (
              <p className="py-6 text-center text-xs text-muted">Nothing to show for this customer.</p>
            )}

            {mods.has("billing") && (
            <Section icon={<Wallet className="size-3.5" />} title="Live balance">
              {!account ? (
                <div className="h-16 animate-pulse rounded-xl bg-surface" />
              ) : !account.connected ? (
                <p className="text-[13px] text-muted">
                  Billing isn&apos;t connected for this tenant yet, so live balances aren&apos;t available. The bot sends customers the USSD codes instead.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Stat label="Airtime" value={formatMoney(account.balance.airtime, account.currency)} />
                    <Stat label="Data" value={formatData(account.balance.dataMb)} />
                    <Stat label="Minutes" value={String(account.balance.minutes)} />
                    <Stat label="SMS" value={String(account.balance.sms)} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge tone={account.line.state === "active" ? "green" : "red"}>Line {account.line.state}</Badge>
                    <Badge tone={account.line.kyc === "verified" ? "green" : "amber"}>KYC {account.line.kyc}</Badge>
                    <Badge>
                      <Smartphone className="size-3" /> {account.line.simType} · {account.line.network}
                    </Badge>
                  </div>
                </>
              )}
            </Section>
            )}

            {mods.has("topups") && (
            <Section icon={<Wallet className="size-3.5" />} title="Recent top-ups">
              {recharges.length === 0 && <div className="text-xs text-muted">None yet</div>}
              <ul className="space-y-2">
                {recharges.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-[13px]">
                    <span className={cx("size-1.5 rounded-full", r.status === "success" ? "bg-emerald-500" : r.status === "failed" ? "bg-danger" : "bg-amber-500")} />
                    <span className="flex-1">
                      {r.kind === "bundle" ? "Bundle" : "Airtime"} · {formatMoney(r.amount, mvno?.currency ?? "")}
                      <span className="block font-mono text-[10.5px] text-muted">
                        {r.reference} · {r.status}
                      </span>
                    </span>
                    <span className="text-[11px] text-muted">{relTime(r.created_at, now)}</span>
                  </li>
                ))}
              </ul>
            </Section>
            )}

            {mods.has("deliveries") && (
            <Section icon={<Package className="size-3.5" />} title="Deliveries">
              {deliveries.length === 0 && <div className="text-xs text-muted">None</div>}
              <ul className="space-y-2">
                {deliveries.map((d) => (
                  <li key={d.id} className="rounded-xl bg-surface p-2 text-[13px]">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{d.item.toUpperCase()}</span>
                      <span className="font-mono text-[11px] text-muted">{d.tracking_code}</span>
                    </div>
                    {d.address && <div className="truncate text-xs text-muted">{d.address}</div>}
                    <select
                      value={d.status}
                      onChange={(e) => setDeliveryStatus(d, e.target.value as Delivery["status"])}
                      className="mt-1 w-full rounded-lg border border-line bg-surface-2 px-1.5 py-1 text-xs"
                    >
                      {DELIVERY_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </Section>
            )}
          </div>
        )}

        {tab === "history" && (
          <ul className="space-y-1.5">
            {history
              .filter((h) => h.id !== c.id)
              .map((h) => (
                <li key={h.id}>
                  <a href={`/inbox?c=${h.id}`} className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px] hover:bg-accent-soft">
                    <span className="text-muted">{h.ticket_no ? `#${h.ticket_no}` : "Bot"}</span>
                    <span className="flex-1 truncate">{h.subject ?? h.last_message_preview}</span>
                    {h.csat_score && <span className="text-[11px] text-muted">★{h.csat_score}</span>}
                    <span className="text-[11px] text-muted">{relTime(h.created_at, now)}</span>
                  </a>
                </li>
              ))}
            {history.length <= 1 && <li className="py-6 text-center text-xs text-muted">First conversation 👋</li>}
          </ul>
        )}
        {tab === "history" && <EraseCustomer contactId={contact.id} mvnoId={c.mvno_id} />}
      </div>
    </aside>
  );
}

function InfoBox({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-surface-2 px-3 py-2.5">
      <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted">
        {icon} {label}
      </div>
      <div className="text-[13px] font-medium">{children}</div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-surface-2 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted">
        {icon} {title}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface px-2.5 py-1.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="text-[13px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-muted">{k}</span>
      <span>{v}</span>
    </div>
  );
}

/** Data-protection erasure request (supervisors/admins). Two-step confirm, then reloads the inbox. */
function EraseCustomer({ contactId, mvnoId }: { contactId: string; mvnoId: string }) {
  const canErase = useStore(
    (s) => !!s.me?.is_platform_admin || s.memberships.some((m) => m.user_id === s.me?.id && m.mvno_id === mvnoId && (m.role === "admin" || m.role === "supervisor")),
  );
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!canErase) return null;

  async function erase() {
    setStep("busy");
    setError(null);
    try {
      await api(`/api/contacts/${contactId}/erase`, {});
      window.location.assign(new URL("/inbox", window.location.origin));
    } catch (e) {
      setError((e as Error).message);
      setStep("confirm");
    }
  }

  return (
    <div className="mt-6 rounded-2xl border border-red-200 bg-red-50/60 p-3 text-[13px]">
      <div className="font-medium text-red-800">Erase customer data</div>
      <p className="mt-0.5 text-xs text-red-700/80">
        For data-protection deletion requests. Permanently deletes this customer&apos;s chats, messages, photos and profile. Top-up records are kept for finance, unlinked.
      </p>
      {step === "idle" ? (
        <button onClick={() => setStep("confirm")} className="mt-2 rounded-lg px-2.5 py-1 text-xs font-medium text-red-700 ring-1 ring-red-300 hover:bg-red-100">
          Erase…
        </button>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button onClick={erase} disabled={step === "busy"} className="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-60">
            {step === "busy" ? "Erasing…" : "Yes, erase permanently"}
          </button>
          <button onClick={() => setStep("idle")} className="text-xs text-muted hover:text-ink">
            Cancel
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
