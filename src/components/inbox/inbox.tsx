"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessagesSquare, PenSquare, Radio, Search } from "lucide-react";
import { useStore } from "@/lib/store";
import { useWorkspace } from "@/components/workspace";
import { PageHeader } from "@/components/app-shell";
import { cx, Empty, Kbd } from "@/components/ui";
import { ConversationList, filterConversations, inView, VIEWS, type InboxView } from "./conversation-list";
import { Thread } from "./thread";
import { ContextPanel } from "./context-panel";
import { NewConversation } from "./new-conversation";

export function Inbox() {
  const { setViewing } = useWorkspace();
  const [view, setView] = useState<InboxView>("unassigned");
  const [mvnoFilter, setMvnoFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  // Deep link: /inbox?c=<conversationId>. Inbox only renders client-side (behind the workspace gate).
  const [selected, setSelected] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("c"),
  );
  const [showPanel, setShowPanel] = useState(true);
  const [composing, setComposing] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  const select = useCallback(
    (id: string | null) => {
      setSelected(id);
      setViewing(id);
      const url = new URL(window.location.href);
      if (id) url.searchParams.set("c", id);
      else url.searchParams.delete("c");
      window.history.replaceState(null, "", url);
    },
    [setViewing],
  );

  useEffect(() => () => setViewing(null), [setViewing]);

  const s = useStore((s) => s);
  const list = useMemo(
    () => filterConversations(s, view, mvnoFilter, query),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.version, view, mvnoFilter, query],
  );
  const counts = Object.fromEntries(
    VIEWS.map((v) => [v.id, [...s.conversations.values()].filter((c) => inView(c, v.id, s.me?.id) && (mvnoFilter === "all" || c.mvno_id === mvnoFilter)).length]),
  ) as Record<InboxView, number>;
  const mvnos = [...s.mvnos.values()];

  // j / k move through the list, Esc closes, Ctrl/⌘+K searches, ] toggles the profile card.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "j" || e.key === "k") {
        const idx = list.findIndex((c) => c.id === selected);
        const next = list[Math.min(list.length - 1, Math.max(0, idx + (e.key === "j" ? 1 : -1)))];
        if (next) select(next.id);
      } else if (e.key === "Escape") select(null);
      else if (e.key === "]") setShowPanel((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, selected, select]);

  const conversation = selected ? s.conversations.get(selected) : undefined;

  return (
    <div className="flex h-full flex-col px-6 pb-5">
      <PageHeader
        title="Messages"
        subtitle={
          <>
            <Radio className="size-3.5 text-emerald-500" /> Real-time WhatsApp conversations across {mvnos.length} MVNO{mvnos.length === 1 ? "" : "s"}
          </>
        }
        actions={
          <button
            onClick={() => setComposing(true)}
            className="flex items-center gap-2 rounded-full bg-surface px-4 py-2.5 text-sm font-medium text-ink shadow-md ring-1 ring-black/10 transition hover:bg-surface-2"
          >
            New message <PenSquare className="size-4" />
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="flex w-full max-w-xs items-center gap-2 rounded-full bg-surface px-3.5 py-2 shadow-sm ring-1 ring-black/5 dark:ring-white/5">
          <Search className="size-4 text-muted" />
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
          />
          <Kbd>Ctrl K</Kbd>
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {mvnos.length > 1 && (
            <select
              value={mvnoFilter}
              onChange={(e) => setMvnoFilter(e.target.value)}
              className="h-9 rounded-full bg-surface px-3 text-sm shadow-sm ring-1 ring-black/5 outline-none dark:ring-white/5"
            >
              <option value="all">All MVNOs</option>
              {mvnos.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          <div className="flex glass rounded-full p-1">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                className={cx(
                  "flex items-center gap-1 rounded-full px-3 py-1 text-[13px] font-medium transition",
                  view === v.id ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink",
                )}
              >
                {v.label}
                <span className="text-[11px] tabular-nums opacity-60">{counts[v.id]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <ConversationList list={list} view={view} selected={selected} onSelect={select} />
        <section className="card flex min-w-0 flex-1 flex-col overflow-hidden">
          {conversation ? (
            <Thread key={conversation.id} conversation={conversation} onTogglePanel={() => setShowPanel((v) => !v)} />
          ) : (
            <Empty icon={<MessagesSquare className="size-6" />} title="Pick a conversation" hint="Use j / k to move through the list. New chats appear instantly." />
          )}
        </section>
        {conversation && showPanel && <ContextPanel key={conversation.contact_id} conversation={conversation} />}
      </div>

      {composing && (
        <NewConversation
          onClose={() => setComposing(false)}
          onCreated={(id) => {
            setComposing(false);
            setView("mine");
            select(id);
          }}
        />
      )}
    </div>
  );
}
