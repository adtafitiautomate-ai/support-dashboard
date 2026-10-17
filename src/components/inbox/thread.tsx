"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Bot, CheckCircle2, ChevronDown, Clock3, PanelRight, RotateCcw, UserPlus } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { getState, setMessages, upsertConversation, useStore } from "@/lib/store";
import type { Conversation, Message, Priority } from "@/lib/types";
import { api, Avatar, Badge, Button, cx, Kbd, MvnoTag, useNow } from "@/components/ui";
import { formatPhone } from "@/lib/format";
import { MessageBubble } from "./message-bubble";
import { Composer } from "./composer";
import { SlaChip } from "./sla";

const statusTone = { bot: "violet", open: "green", pending: "amber", resolved: "neutral" } as const;

export function Thread({ conversation: c, onTogglePanel }: { conversation: Conversation; onTogglePanel: () => void }) {
  const now = useNow(1000);
  const s = useStore((s) => s);
  const contact = s.contacts.get(c.contact_id);
  const mvno = s.mvnos.get(c.mvno_id);
  const messages = s.messages.get(c.id);
  const typing = s.typing.get(c.id);
  const others = [...s.presence.values()].filter((p) => p.viewing === c.id && p.user_id !== s.me?.id);
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load history, then mark read.
  useEffect(() => {
    let alive = true;
    const supabase = supabaseBrowser();
    supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", c.id)
      .order("created_at", { ascending: false })
      .limit(300)
      .then(({ data }) => alive && data && setMessages(c.id, (data as Message[]).reverse()));
    return () => {
      alive = false;
    };
  }, [c.id]);

  useEffect(() => {
    if (c.unread_count > 0 && c.status !== "bot") {
      upsertConversation({ ...c, unread_count: 0 });
      void supabaseBrowser().from("conversations").update({ unread_count: 0 }).eq("id", c.id);
    }
  }, [c]);

  // Stick to the bottom as messages stream in, unless the agent scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [messages?.length, typing, atBottom]);

  async function act(body: Record<string, unknown>) {
    setError(null);
    try {
      const { conversation } = await api<{ conversation: Conversation }>(`/api/conversations/${c.id}/actions`, body);
      upsertConversation(conversation);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Keyboard shortcuts for the open thread.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "e" && c.status !== "resolved") void act({ action: "resolve", csat: true });
      if (e.key === "a" && c.assignee_id !== getState().me?.id) void act({ action: "assign", userId: getState().me?.id });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const assignee = c.assignee_id ? s.profiles.get(c.assignee_id) : null;
  const team = s.memberships.filter((m) => m.mvno_id === c.mvno_id).map((m) => s.profiles.get(m.user_id)).filter(Boolean);
  const load = (uid: string) =>
    [...s.conversations.values()].filter((x) => x.assignee_id === uid && (x.status === "open" || x.status === "pending")).length;

  let lastDay = "";

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-line/70 px-5 py-3">
        <Avatar name={contact?.name ?? contact?.wa_id ?? "?"} size={36} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{contact?.name ?? (contact && formatPhone(contact.wa_id))}</span>
            <Badge tone={statusTone[c.status]}>{c.status === "bot" ? "With bot" : c.status}</Badge>
            <SlaChip conversation={c} now={now} />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted">
            {contact && <span>{formatPhone(contact.wa_id)}</span>}
            {mvno && <MvnoTag name={mvno.name} color={mvno.brand_color} />}
            {c.ticket_no && <span>#{c.ticket_no}</span>}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <select
            value={c.priority}
            onChange={(e) => act({ action: "priority", priority: e.target.value as Priority })}
            className={cx(
              "h-8 rounded-lg border border-line bg-surface px-2 text-xs font-medium",
              c.priority === "urgent" && "text-danger",
              c.priority === "high" && "text-warn",
            )}
            title="Priority"
          >
            {["low", "normal", "high", "urgent"].map((p) => (
              <option key={p} value={p}>
                {p[0].toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>

          <Dropdown
            label={
              assignee ? (
                <>
                  <Avatar name={assignee.full_name} size={18} /> {assignee.full_name.split(" ")[0]}
                </>
              ) : (
                <>
                  <UserPlus className="size-4" /> Assign
                </>
              )
            }
          >
            {(close) => (
              <>
                {s.me && c.assignee_id !== s.me.id && (
                  <MenuItem onClick={() => (close(), act({ action: "assign", userId: s.me!.id }))}>
                    Assign to me <Kbd>a</Kbd>
                  </MenuItem>
                )}
                {team.map((p) => (
                  <MenuItem key={p!.id} onClick={() => (close(), act({ action: "assign", userId: p!.id }))}>
                    <Avatar name={p!.full_name} size={20} online={s.presence.has(p!.id) && p!.status === "online"} />
                    <span className="flex-1">{p!.full_name}</span>
                    <span className="text-[11px] text-muted">{load(p!.id)} open</span>
                  </MenuItem>
                ))}
                {c.assignee_id && <MenuItem onClick={() => (close(), act({ action: "assign", userId: null }))}>Unassign</MenuItem>}
              </>
            )}
          </Dropdown>

          {c.status === "resolved" ? (
            <Button onClick={() => act({ action: "reopen" })}>
              <RotateCcw className="size-4" /> Reopen
            </Button>
          ) : (
            <div className="flex">
              <Button variant="primary" className="rounded-r-none" onClick={() => act({ action: "resolve", csat: true })} title="Resolve and send CSAT survey (e)">
                <CheckCircle2 className="size-4" /> Resolve
              </Button>
              <Dropdown label={<ChevronDown className="size-4" />} buttonClass="rounded-l-none border-l-0 px-1.5" align="right" primary>
                {(close) => (
                  <>
                    <MenuItem onClick={() => (close(), act({ action: "resolve", csat: false }))}>
                      <CheckCircle2 className="size-4" /> Resolve without survey
                    </MenuItem>
                    {c.status !== "pending" && (
                      <MenuItem onClick={() => (close(), act({ action: "pending" }))}>
                        <Clock3 className="size-4" /> Waiting on customer
                      </MenuItem>
                    )}
                    {c.status !== "bot" && (
                      <MenuItem onClick={() => (close(), act({ action: "return_to_bot" }))}>
                        <Bot className="size-4" /> Hand back to bot
                      </MenuItem>
                    )}
                  </>
                )}
              </Dropdown>
            </div>
          )}
          <Button variant="ghost" onClick={onTogglePanel} title="Toggle details ( ] )">
            <PanelRight className="size-4" />
          </Button>
        </div>
      </header>

      {(others.length > 0 || error || c.status === "bot") && (
        <div className="space-y-1 border-b border-line/70 bg-surface-2/60 px-5 py-1.5 text-xs">
          {c.status === "bot" && (
            <div className="flex items-center gap-1.5 text-muted">
              <Bot className="size-3.5" /> The bot is handling this chat. Replying takes it over.
            </div>
          )}
          {others.length > 0 && (
            <div className="flex items-center gap-1.5 text-warn">
              👀 {others.map((o) => o.name.split(" ")[0]).join(", ")} {others.length > 1 ? "are" : "is"} also viewing this conversation
            </div>
          )}
          {error && <div className="text-danger">{error}</div>}
        </div>
      )}

      {/* Messages */}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
        className="chat-wallpaper relative flex-1 overflow-y-auto px-6 py-4"
      >
        {!messages && <div className="py-10 text-center text-sm text-muted">Loading…</div>}
        {messages?.map((m) => {
          const day = new Date(m.created_at).toDateString();
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <div key={m.id}>
              {showDay && (
                <div className="my-3 flex justify-center">
                  <span className="rounded-md bg-surface px-2 py-0.5 text-[11px] font-medium text-muted shadow-sm">
                    {dayLabel(m.created_at)}
                  </span>
                </div>
              )}
              <MessageBubble m={m} authorName={m.sender_id ? s.profiles.get(m.sender_id)?.full_name : undefined} />
            </div>
          );
        })}
        {typing && (
          <div className="my-1 flex justify-end">
            <div className="flex items-center gap-1.5 rounded-xl bg-bubble-out px-3 py-2 text-xs text-muted shadow-sm">
              {typing.name.split(" ")[0]} is typing
              <span className="flex gap-0.5">
                <span className="typing-dot size-1 rounded-full bg-muted" />
                <span className="typing-dot size-1 rounded-full bg-muted" />
                <span className="typing-dot size-1 rounded-full bg-muted" />
              </span>
            </div>
          </div>
        )}
        {!atBottom && (
          <button
            onClick={() => {
              setAtBottom(true);
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
            }}
            className="sticky bottom-2 left-full grid size-9 place-items-center rounded-full border border-line bg-surface shadow-md"
          >
            <ArrowDown className="size-4" />
          </button>
        )}
      </div>

      <Composer conversation={c} />
    </div>
  );
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function Dropdown({
  label,
  children,
  align = "left",
  buttonClass,
  primary,
}: {
  label: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
  buttonClass?: string;
  primary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <Button variant={primary ? "primary" : "secondary"} className={buttonClass} onClick={() => setOpen((o) => !o)}>
        {label}
      </Button>
      {open && (
        <div
          className={cx(
            "absolute top-9 z-40 min-w-56 rounded-xl border border-line bg-surface p-1 shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2">
      {children}
    </button>
  );
}
