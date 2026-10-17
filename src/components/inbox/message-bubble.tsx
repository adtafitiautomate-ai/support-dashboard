"use client";

import { AlertCircle, Bot, Check, CheckCheck, Clock, List, MapPin, StickyNote } from "lucide-react";
import type { Message } from "@/lib/types";
import type { OutboundMessage } from "@/lib/whatsapp/types";
import { cx } from "@/components/ui";

export function MessageBubble({ m, authorName }: { m: Message; authorName?: string }) {
  if (m.type === "event") {
    return (
      <div className="my-2 flex justify-center">
        <span className="rounded-full bg-surface/80 px-3 py-1 text-[11px] text-muted shadow-sm ring-1 ring-line">
          {m.body} · {time(m.created_at)}
        </span>
      </div>
    );
  }

  if (m.is_internal) {
    return (
      <div className="my-1.5 flex justify-end">
        <div className="max-w-[72%] rounded-xl border border-amber-400/40 bg-bubble-note px-3 py-2 shadow-sm">
          <div className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-warn">
            <StickyNote className="size-3" /> Note · {authorName ?? "Agent"}
          </div>
          <div className="text-[13.5px] whitespace-pre-wrap">{m.body}</div>
          <div className="mt-0.5 text-right text-[10px] text-muted">{time(m.created_at)}</div>
        </div>
      </div>
    );
  }

  const inbound = m.direction === "in";
  const out = (m.payload as { out?: OutboundMessage }).out;
  const loc = (m.payload as { location?: { lat: number; lng: number; name?: string; address?: string } }).location;

  return (
    <div className={cx("my-1 flex", inbound ? "justify-start" : "justify-end", m.id.startsWith("tmp-") && "opacity-70")}>
      <div
        className={cx(
          "max-w-[72%] rounded-xl px-3 py-1.5 shadow-sm",
          inbound ? "rounded-tl-sm bg-bubble-in" : "rounded-tr-sm bg-bubble-out",
          m.status === "failed" && "ring-1 ring-danger",
        )}
      >
        {!inbound && (
          <div className="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-muted">
            {m.sender_type === "bot" ? (
              <>
                <Bot className="size-3" /> Bot
              </>
            ) : (
              (authorName ?? "Agent")
            )}
          </div>
        )}

        {loc ? (
          <a
            href={`https://www.google.com/maps?q=${loc.lat},${loc.lng}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 py-1 text-[13.5px] hover:underline"
          >
            <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent">
              <MapPin className="size-4" />
            </span>
            <span>
              <span className="block font-medium">{loc.name ?? "Shared location"}</span>
              <span className="block text-xs text-muted">
                {loc.address ?? `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`}
              </span>
            </span>
          </a>
        ) : out?.type === "location" ? (
          <a
            href={`https://www.google.com/maps?q=${out.lat},${out.lng}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 py-1 text-[13.5px] hover:underline"
          >
            <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent">
              <MapPin className="size-4" />
            </span>
            <span>
              <span className="block font-medium">{out.name}</span>
              <span className="block text-xs text-muted">{out.address}</span>
            </span>
          </a>
        ) : (
          <div className="text-[13.5px] break-words whitespace-pre-wrap">
            {(m.type === "button_reply" || m.type === "list_reply") && <span className="mr-1 text-muted">↩︎</span>}
            <WhatsAppText text={m.body ?? ""} />
          </div>
        )}

        {out?.type === "buttons" && (
          <div className="mt-1.5 flex flex-col gap-1 border-t border-line/60 pt-1.5">
            {out.buttons.map((b) => (
              <span key={b.id} className="text-center text-[12.5px] font-medium text-sky-600 dark:text-sky-400">
                {b.title}
              </span>
            ))}
          </div>
        )}
        {out?.type === "list" && (
          <details className="mt-1.5 border-t border-line/60 pt-1.5">
            <summary className="flex cursor-pointer list-none items-center justify-center gap-1 text-[12.5px] font-medium text-sky-600 dark:text-sky-400">
              <List className="size-3.5" /> {out.button}
            </summary>
            <div className="mt-1 space-y-1.5">
              {out.sections.map((s) => (
                <div key={s.title}>
                  <div className="text-[10.5px] font-semibold tracking-wide text-muted uppercase">{s.title}</div>
                  {s.rows.map((r) => (
                    <div key={r.id} className="text-xs">
                      <span className="font-medium">{r.title}</span>
                      {r.description && <span className="text-muted"> · {r.description}</span>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </details>
        )}
        {out?.type === "location_request" && (
          <div className="mt-1.5 border-t border-line/60 pt-1.5 text-center text-[12.5px] font-medium text-sky-600 dark:text-sky-400">
            📍 Send location
          </div>
        )}

        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-muted">
          {time(m.created_at)}
          {!inbound && <Ticks status={m.status} />}
        </div>
        {m.status === "failed" && m.error && <div className="mt-0.5 text-[11px] text-danger">{m.error}</div>}
      </div>
    </div>
  );
}

function Ticks({ status }: { status: Message["status"] }) {
  if (status === "queued") return <Clock className="size-3" />;
  if (status === "sent") return <Check className="size-3.5" />;
  if (status === "delivered") return <CheckCheck className="size-3.5" />;
  if (status === "read") return <CheckCheck className="size-3.5 text-sky-500" />;
  if (status === "failed") return <AlertCircle className="size-3.5 text-danger" />;
  return null;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Renders WhatsApp's *bold*, _italic_ and ~strike~ markup. */
function WhatsAppText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\*.+\*$/.test(p) ? (
          <strong key={i}>{p.slice(1, -1)}</strong>
        ) : /^_.+_$/.test(p) ? (
          <em key={i}>{p.slice(1, -1)}</em>
        ) : /^~.+~$/.test(p) ? (
          <s key={i}>{p.slice(1, -1)}</s>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
