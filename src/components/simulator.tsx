"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, List, MapPin, Send, Shuffle } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useStore } from "@/lib/store";
import type { Message } from "@/lib/types";
import type { ListSection, OutboundMessage } from "@/lib/whatsapp/types";
import { useWorkspace } from "./workspace";
import { api, Button, cx } from "./ui";

const PLACES = [
  { name: "Nairobi CBD", lat: -1.2864, lng: 36.8172 },
  { name: "Westlands", lat: -1.2676, lng: 36.8108 },
  { name: "Kibera", lat: -1.3133, lng: 36.7876 },
  { name: "Rongai", lat: -1.3936, lng: 36.7442 },
  { name: "Mombasa", lat: -4.0435, lng: 39.6682 },
];

const randomNumber = () => `2547${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

export function Simulator() {
  const { onEvent } = useWorkspace();
  const mvnos = useStore((s) => [...s.mvnos.values()]);
  const [mvnoId, setMvnoId] = useState(mvnos[0]?.id ?? "");
  const [from, setFrom] = useState("254712999001");
  const [name, setName] = useState("Test Customer");
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [sheet, setSheet] = useState<null | { kind: "list"; sections: ListSection[]; title: string } | { kind: "location" }>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const mvno = mvnos.find((m) => m.id === mvnoId);

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const { data: contact } = await supabase.from("contacts").select("id").eq("mvno_id", mvnoId).eq("wa_id", from).maybeSingle();
    if (!contact) return setMessages([]);
    const { data: convs } = await supabase.from("conversations").select("id").eq("contact_id", contact.id);
    const ids = (convs ?? []).map((c) => c.id);
    if (!ids.length) return setMessages([]);
    const { data } = await supabase
      .from("messages")
      .select("*")
      .in("conversation_id", ids)
      .eq("is_internal", false)
      .order("created_at", { ascending: true })
      .limit(300);
    setMessages(data ?? []);
  }, [mvnoId, from]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined = setTimeout(() => void load(), 0);
    const off = onEvent((table, record) => {
      if (table === "messages" && record.mvno_id === mvnoId) {
        clearTimeout(t);
        t = setTimeout(() => void load(), 60);
      }
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [load, onEvent, mvnoId]);

  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length]);

  async function send(input: { text?: string; replyId?: string; location?: { lat: number; lng: number; name?: string } }) {
    setError(null);
    setSheet(null);
    try {
      await api("/api/simulator", { mvnoId, from, name, ...input });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto px-6 pb-6 lg:flex-row">
      <div className="card h-fit space-y-4 p-6 lg:w-80">
        <div>
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight">Simulator</h1>
          <p className="mt-1 text-sm text-muted">
            Chat as a customer to test the bot and inbox end to end, with no phone needed. MVNOs wired to a real Meta number still work here; replies just won&apos;t reach a real handset.
          </p>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-muted">MVNO (WhatsApp number)</span>
          <select value={mvnoId} onChange={(e) => setMvnoId(e.target.value)} className="w-full rounded-lg border border-line bg-surface-2 px-2 py-1.5">
            {mvnos.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} Â· {m.wa_display_number}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-muted">Customer WhatsApp number</span>
          <div className="flex gap-1">
            <input value={from} onChange={(e) => setFrom(e.target.value.replace(/\D/g, ""))} className="w-full rounded-lg border border-line bg-surface-2 px-2 py-1.5 font-mono" />
            <Button onClick={() => setFrom(randomNumber())} title="New customer">
              <Shuffle className="size-4" />
            </Button>
          </div>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-muted">Profile name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-line bg-surface-2 px-2 py-1.5" />
        </label>
        <div className="rounded-lg bg-surface-2 p-3 text-xs text-muted">
          <div className="mb-1 font-medium text-ink">Try:</div>
          â€œhiâ€ Â· â€œnataka bundle ya wikiâ€ Â· â€œmy data isn&apos;t workingâ€ Â· â€œwhere is the nearest shop?â€ Â· â€œI was charged but got nothingâ€ Â· â€œtrack my SIM deliveryâ€ Â· â€œtalk to a personâ€
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>

      <div className="grid flex-1 place-items-center">
        <div className="relative flex h-[720px] max-h-[calc(100dvh-3rem)] w-[380px] max-w-full flex-col overflow-hidden rounded-[2.5rem] border-[10px] border-zinc-900 bg-chat shadow-2xl">
          <div className="flex items-center gap-2 px-3 py-2.5 text-white" style={{ background: "#075E54" }}>
            <ChevronLeft className="size-5" />
            <div className="grid size-8 place-items-center rounded-full text-sm font-semibold" style={{ background: mvno?.brand_color }}>
              {mvno?.name[0]}
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold">{mvno?.name} âœ“</div>
              <div className="text-[11px] opacity-80">Business account</div>
            </div>
          </div>

          <div ref={scroller} className="chat-wallpaper flex-1 space-y-1 overflow-y-auto px-2.5 py-3">
            {messages.map((m) => (
              <PhoneBubble key={m.id} m={m} onReply={(replyId, title) => send({ replyId, text: title })} onList={(sections, title) => setSheet({ kind: "list", sections, title })} onLocation={() => setSheet({ kind: "location" })} />
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              void send({ text: text.trim() });
              setText("");
            }}
            className="flex items-center gap-1.5 bg-chat p-2"
          >
            <button type="button" onClick={() => setSheet({ kind: "location" })} className="grid size-9 place-items-center rounded-full bg-surface text-muted" title="Share location">
              <MapPin className="size-4" />
            </button>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message" className="flex-1 rounded-full bg-surface px-4 py-2 text-sm outline-none" />
            <button className="grid size-9 place-items-center rounded-full text-white" style={{ background: "#00A884" }}>
              <Send className="size-4" />
            </button>
          </form>

          {sheet && (
            <div className="absolute inset-0 flex items-end bg-black/40" onClick={() => setSheet(null)}>
              <div className="max-h-[70%] w-full overflow-y-auto rounded-t-2xl bg-surface p-3" onClick={(e) => e.stopPropagation()}>
                {sheet.kind === "list" ? (
                  <>
                    <div className="mb-2 text-center text-sm font-semibold">{sheet.title}</div>
                    {sheet.sections.map((s) => (
                      <div key={s.title} className="mb-2">
                        <div className="px-2 py-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{s.title}</div>
                        {s.rows.map((r) => (
                          <button key={r.id} onClick={() => send({ replyId: r.id, text: r.title })} className="block w-full rounded-lg px-2 py-2 text-left hover:bg-surface-2">
                            <div className="text-sm">{r.title}</div>
                            {r.description && <div className="text-xs text-muted">{r.description}</div>}
                          </button>
                        ))}
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="mb-2 text-center text-sm font-semibold">Share location</div>
                    {PLACES.map((p) => (
                      <button key={p.name} onClick={() => send({ location: p })} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-surface-2">
                        <MapPin className="size-4 text-accent" /> {p.name}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PhoneBubble({
  m,
  onReply,
  onList,
  onLocation,
}: {
  m: Message;
  onReply: (id: string, title: string) => void;
  onList: (sections: ListSection[], title: string) => void;
  onLocation: () => void;
}) {
  if (m.type === "event") return null;
  const mine = m.direction === "in"; // the customer's own message
  const out = (m.payload as { out?: OutboundMessage }).out;
  return (
    <div className={cx("flex", mine ? "justify-end" : "justify-start")}>
      <div className="max-w-[85%]">
        <div className={cx("rounded-lg px-2.5 py-1.5 text-[13.5px] shadow-sm", mine ? "bg-bubble-out" : "bg-bubble-in")}>
          {out?.type === "location" ? (
            <div>
              <div className="mb-1 grid h-20 place-items-center rounded bg-accent-soft text-accent">
                <MapPin className="size-6" />
              </div>
              <div className="font-medium">{out.name}</div>
              <div className="text-xs text-muted">{out.address}</div>
            </div>
          ) : (
            <div className="whitespace-pre-wrap">{(m.body ?? "").replace(/\*([^*\n]+)\*/g, "$1")}</div>
          )}
          <div className="text-right text-[10px] text-muted">{new Date(m.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</div>
        </div>
        {out?.type === "buttons" &&
          out.buttons.map((b) => (
            <button key={b.id} onClick={() => onReply(b.id, b.title)} className="mt-0.5 block w-full rounded-lg bg-bubble-in py-1.5 text-center text-[13px] font-medium text-sky-600 shadow-sm hover:brightness-95 dark:text-sky-400">
              {b.title}
            </button>
          ))}
        {out?.type === "list" && (
          <button onClick={() => onList(out.sections, out.button)} className="mt-0.5 flex w-full items-center justify-center gap-1 rounded-lg bg-bubble-in py-1.5 text-[13px] font-medium text-sky-600 shadow-sm hover:brightness-95 dark:text-sky-400">
            <List className="size-3.5" /> {out.button}
          </button>
        )}
        {out?.type === "location_request" && (
          <button onClick={onLocation} className="mt-0.5 flex w-full items-center justify-center gap-1 rounded-lg bg-bubble-in py-1.5 text-[13px] font-medium text-sky-600 shadow-sm hover:brightness-95 dark:text-sky-400">
            <MapPin className="size-3.5" /> Send location
          </button>
        )}
      </div>
    </div>
  );
}
