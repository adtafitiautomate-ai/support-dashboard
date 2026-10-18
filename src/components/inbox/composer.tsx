"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LayoutList, Loader2, MapPin, Send, Sparkles, Store, Zap } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { removeMessage, upsertMessage, useStore } from "@/lib/store";
import type { Bundle, CannedResponse, Conversation, Message, Outlet } from "@/lib/types";
import type { OutboundMessage } from "@/lib/whatsapp/types";
import { api, Button, cx, Kbd, useNow } from "@/components/ui";
import { bundleSummary, formatMoney, haversineKm } from "@/lib/format";
import { useWorkspace } from "@/components/workspace";
import { Dropdown, MenuItem } from "./thread";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const cannedCache = new Map<string, CannedResponse[]>();

export function Composer({ conversation: c }: { conversation: Conversation }) {
  const { sendTyping } = useWorkspace();
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<null | "send" | "ai">(null);
  const [error, setError] = useState<string | null>(null);
  const [canned, setCanned] = useState<CannedResponse[]>(cannedCache.get(c.mvno_id) ?? []);
  const [pick, setPick] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const contact = useStore((s) => s.contacts.get(c.contact_id));
  const mvno = useStore((s) => s.mvnos.get(c.mvno_id));
  const me = useStore((s) => s.me);

  const now = useNow(30_000);
  const windowOpen = !!c.last_inbound_at && now - new Date(c.last_inbound_at).getTime() < WINDOW_MS;

  useEffect(() => {
    if (cannedCache.has(c.mvno_id)) return;
    void supabaseBrowser()
      .from("canned_responses")
      .select("*")
      .eq("mvno_id", c.mvno_id)
      .order("shortcut")
      .then(({ data }) => {
        cannedCache.set(c.mvno_id, data ?? []);
        setCanned(data ?? []);
      });
  }, [c.mvno_id]);

  // Auto-grow.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(200, el.scrollHeight) + "px";
  }, [text]);

  const slash = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const matches = useMemo(
    () => (slash === null ? [] : canned.filter((r) => r.shortcut.includes(slash) || r.title.toLowerCase().includes(slash)).slice(0, 6)),
    [slash, canned],
  );

  function fill(template: string) {
    const firstName = contact?.name?.split(" ")[0] ?? "there";
    return template
      .replaceAll("{{name}}", firstName)
      .replaceAll("{{agent}}", me?.full_name.split(" ")[0] ?? "")
      .replaceAll("{{brand}}", mvno?.name ?? "");
  }

  async function send(out?: OutboundMessage) {
    const body = text.trim();
    if (!out && !body) return;
    setError(null);
    setBusy("send");
    const internal = !out && mode === "note";

    // Optimistic bubble: the agent sees their message instantly.
    const tmp: Message = {
      id: `tmp-${crypto.randomUUID()}`,
      conversation_id: c.id,
      mvno_id: c.mvno_id,
      direction: "out",
      sender_type: "agent",
      sender_id: me?.id ?? null,
      type: internal ? "note" : (out?.type ?? "text"),
      body: out ? ("text" in out ? out.text : "body" in out ? out.body : "…") : body,
      payload: out ? { out } : {},
      is_internal: internal,
      wa_message_id: null,
      status: "queued",
      error: null,
      created_at: new Date().toISOString(),
    };
    upsertMessage(tmp);
    if (!out) setText("");

    try {
      const { message } = await api<{ message: Message }>(`/api/conversations/${c.id}/messages`, out ? { out } : { text: body, internal });
      removeMessage(c.id, tmp.id);
      upsertMessage(message);
    } catch (e) {
      removeMessage(c.id, tmp.id);
      if (!out) setText(body);
      setError((e as Error).message);
    } finally {
      setBusy(null);
      ta.current?.focus();
    }
  }

  async function aiDraft() {
    setBusy("ai");
    setError(null);
    try {
      const { draft } = await api<{ draft: string }>(`/api/conversations/${c.id}/actions`, {
        action: "suggest",
        instruction: text.trim() || undefined,
      });
      setText(draft);
      setMode("reply");
      ta.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // ---------------------------------------------------------- quick actions (rich WhatsApp messages)
  async function sendBundles() {
    const { data } = await supabaseBrowser().from("bundles").select("*").eq("mvno_id", c.mvno_id).eq("active", true).order("sort");
    const bundles = (data ?? []) as Bundle[];
    await send({
      type: "list",
      body: "Here are our bundles. Pick one and I'll set it up for you 👇",
      button: "See bundles",
      sections: [
        {
          title: "Bundles",
          rows: bundles.slice(0, 10).map((b) => ({
            id: `bundle:${b.id}`,
            title: b.name.slice(0, 24),
            description: `${formatMoney(b.price, mvno?.currency ?? "")} · ${bundleSummary(b)}`,
          })),
        },
      ],
    });
  }

  async function sendOutlets() {
    const loc = contact?.last_location;
    if (!loc) {
      await send({ type: "location_request", body: "Please share your location 📍 so I can find the nearest shop or agent." });
      return;
    }
    const { data } = await supabaseBrowser().from("outlets").select("*").eq("mvno_id", c.mvno_id).not("lat", "is", null);
    const nearest = ((data ?? []) as Outlet[])
      .filter((o): o is Outlet & { lat: number; lng: number } => o.lat !== null && o.lng !== null)
      .map((o) => ({ ...o, km: haversineKm(loc, o) }))
      .sort((a, b) => a.km - b.km)[0];
    if (nearest) await send({ type: "location", lat: nearest.lat, lng: nearest.lng, name: nearest.name, address: `${nearest.address} · ${nearest.hours ?? ""}` });
  }

  const menuOut: OutboundMessage = {
    type: "buttons",
    body: "Is there anything else I can help with? You can also use our self-service menu anytime.",
    buttons: [
      { id: "menu:main", title: "Open menu" },
      { id: "menu:balance", title: "Check balance" },
    ],
  };

  if (!windowOpen && c.status !== "resolved") return <TemplateSender c={c} onSend={send} busy={busy === "send"} error={error} />;

  return (
    <div
      className={cx(
        "m-3 mt-0 rounded-2xl border bg-surface shadow-sm transition-colors",
        mode === "note" ? "border-amber-400/50 bg-bubble-note" : "border-line focus-within:border-ink/20",
      )}
    >
      <div className="flex items-center gap-1 px-3 pt-2">
        {(["reply", "note"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cx(
              "rounded-md px-2 py-1 text-xs font-medium",
              mode === m ? (m === "note" ? "bg-amber-500/15 text-warn" : "bg-surface-2 text-ink") : "text-muted hover:text-ink",
            )}
          >
            {m === "reply" ? "Reply" : "Internal note"}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1 text-[11px] text-muted">
          <Kbd>/</Kbd> saved replies · <Kbd>Enter</Kbd> send · <Kbd>Shift+Enter</Kbd> new line
        </span>
      </div>

      <div className="relative px-3 py-2">
        {matches.length > 0 && (
          <div className="absolute right-3 bottom-full left-3 mb-1 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
            {matches.map((r, i) => (
              <button
                key={r.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText(fill(r.body));
                }}
                className={cx("block w-full px-3 py-2 text-left", i === pick && "bg-surface-2")}
              >
                <div className="text-xs font-medium">
                  /{r.shortcut} <span className="text-muted">· {r.title}</span>
                </div>
                <div className="truncate text-xs text-muted">{fill(r.body)}</div>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          autoFocus
          onChange={(e) => {
            setText(e.target.value);
            setPick(0);
            if (mode === "reply") sendTyping(c.id);
          }}
          onKeyDown={(e) => {
            if (matches.length) {
              if (e.key === "ArrowDown") return (e.preventDefault(), setPick((p) => Math.min(matches.length - 1, p + 1)));
              if (e.key === "ArrowUp") return (e.preventDefault(), setPick((p) => Math.max(0, p - 1)));
              if (e.key === "Enter" || e.key === "Tab") return (e.preventDefault(), setText(fill(matches[pick].body)));
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={mode === "note" ? "Add a note for your team (not sent to the customer)…" : `Reply to ${contact?.name?.split(" ")[0] ?? "customer"} on WhatsApp…`}
          className="w-full resize-none bg-transparent px-1 py-1 text-[14px] outline-none placeholder:text-muted"
        />
      </div>

      <div className="flex items-center gap-1.5 px-3 pb-2.5">
        <Button size="sm" variant="ghost" onClick={aiDraft} disabled={!!busy} title="Draft a reply with AI. Type a short instruction first to steer it.">
          {busy === "ai" ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          AI draft
        </Button>
        <Dropdown
          label={
            <>
              <Zap className="size-3.5" /> Quick actions
            </>
          }
          buttonClass="h-7 px-2 text-xs"
        >
          {(close) => (
            <>
              <MenuItem onClick={() => (close(), void sendBundles())}>
                <LayoutList className="size-4" /> Send bundle catalogue
              </MenuItem>
              <MenuItem onClick={() => (close(), void sendOutlets())}>
                <Store className="size-4" /> Send nearest shop / agent
              </MenuItem>
              <MenuItem onClick={() => (close(), void send({ type: "location_request", body: "Please share your location 📍" }))}>
                <MapPin className="size-4" /> Ask for location
              </MenuItem>
              <MenuItem onClick={() => (close(), void send(menuOut))}>
                <Zap className="size-4" /> Send self-service menu
              </MenuItem>
            </>
          )}
        </Dropdown>
        {error && <span className="truncate text-xs text-danger">{error}</span>}
        <button
          onClick={() => send()}
          disabled={!text.trim() || busy === "send"}
          title={mode === "note" ? "Add note" : "Send"}
          className={cx(
            "ml-auto grid size-9 place-items-center rounded-full text-white shadow-sm transition hover:scale-105 disabled:opacity-40 disabled:hover:scale-100",
            mode === "note" ? "bg-warn" : "bg-accent",
          )}
        >
          {busy === "send" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </button>
      </div>
    </div>
  );
}

function TemplateSender({
  c,
  onSend,
  busy,
  error,
}: {
  c: Conversation;
  onSend: (out: OutboundMessage) => Promise<void>;
  busy: boolean;
  error: string | null;
}) {
  const [name, setName] = useState("hello_world");
  const [lang, setLang] = useState("en_US");
  return (
    <div className="m-3 mt-0 rounded-2xl border border-line bg-surface p-3 shadow-sm">
      <div className="mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-warn">
        The 24-hour customer service window closed{c.last_inbound_at ? ` (last message ${new Date(c.last_inbound_at).toLocaleString("en-GB")})` : ""}.
        WhatsApp only allows approved templates until the customer replies.
      </div>
      <div className="flex items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className="flex-1 rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-sm" placeholder="Template name" />
        <input value={lang} onChange={(e) => setLang(e.target.value)} className="w-24 rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-sm" placeholder="Language" />
        <Button variant="primary" disabled={busy || !name} onClick={() => onSend({ type: "template", name, language: lang })}>
          <Send className="size-4" /> Send template
        </Button>
      </div>
      {error && <div className="mt-1 text-xs text-danger">{error}</div>}
    </div>
  );
}
