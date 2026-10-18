"use client";

import { Bot, Flame } from "lucide-react";
import { getState, useStore } from "@/lib/store";
import type { Conversation } from "@/lib/types";
import { Avatar, cx, relTime, useNow } from "@/components/ui";
import { formatPhone } from "@/lib/format";
import { SlaChip } from "./sla";

export type InboxView = "live" | "mine" | "unassigned" | "all" | "bot" | "resolved";

export const VIEWS: { id: InboxView; label: string }[] = [
  { id: "live", label: "All chats" },
  { id: "unassigned", label: "Queue" },
  { id: "mine", label: "Mine" },
  { id: "all", label: "With agents" },
  { id: "bot", label: "With bot" },
  { id: "resolved", label: "Resolved" },
];

const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

export function inView(c: Conversation, view: InboxView, me: string | undefined) {
  switch (view) {
    case "live":
      return c.status !== "resolved";
    case "mine":
      return (c.status === "open" || c.status === "pending") && c.assignee_id === me;
    case "unassigned":
      return c.status === "open" && !c.assignee_id;
    case "all": // "With agents"
      return c.status === "open" || c.status === "pending";
    case "bot":
      return c.status === "bot";
    case "resolved":
      return c.status === "resolved";
  }
}

export function filterConversations(s: ReturnType<typeof getState>, view: InboxView, mvno: string, query: string) {
  const q = query.trim().toLowerCase();
  const me = s.me?.id;
  const out: Conversation[] = [];
  for (const c of s.conversations.values()) {
    if (!inView(c, view, me)) continue;
    if (mvno !== "all" && c.mvno_id !== mvno) continue;
    if (q) {
      const contact = s.contacts.get(c.contact_id);
      const hay = `${contact?.name ?? ""} ${contact?.wa_id ?? ""} ${c.subject ?? ""} ${c.last_message_preview ?? ""} ${c.ticket_no ? `#${c.ticket_no}` : ""}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push(c);
  }
  // The queue is triaged: urgency first, then oldest waiting. Other views: most recent first.
  if (view === "unassigned") {
    out.sort(
      (a, b) =>
        priorityRank[a.priority] - priorityRank[b.priority] ||
        (a.sla_due_at ?? a.last_message_at).localeCompare(b.sla_due_at ?? b.last_message_at),
    );
  } else out.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
  return out;
}

export function ConversationList(props: { list: Conversation[]; view: InboxView; selected: string | null; onSelect: (id: string) => void }) {
  const now = useNow(10_000);
  const s = useStore((s) => s);
  const multi = s.mvnos.size > 1;
  const viewers = new Map<string, string[]>();
  for (const p of s.presence.values()) {
    if (p.viewing && p.user_id !== s.me?.id) viewers.set(p.viewing, [...(viewers.get(p.viewing) ?? []), p.name]);
  }

  return (
    <aside className="card flex w-full shrink-0 flex-col overflow-hidden lg:w-[330px]">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
        <span className="text-[13px] font-medium text-muted">{VIEWS.find((v) => v.id === props.view)?.label}</span>
        <span className="text-xs text-muted tabular-nums">{props.list.length}</span>
      </div>
      <ul className="flex-1 overflow-y-auto px-2 pb-2">
        {props.list.length === 0 && (
          <li className="p-8 text-center text-sm text-muted">{props.view === "unassigned" ? "Queue is clear 🎉" : "Nothing here"}</li>
        )}
        {props.list.map((c) => {
          const contact = s.contacts.get(c.contact_id);
          const mvno = s.mvnos.get(c.mvno_id);
          const assignee = c.assignee_id ? s.profiles.get(c.assignee_id) : null;
          const watching = viewers.get(c.id);
          const active = c.id === props.selected;
          return (
            <li key={c.id}>
              <button
                onClick={() => props.onSelect(c.id)}
                className={cx(
                  "relative flex w-full gap-3 rounded-2xl px-2.5 py-2.5 text-left transition",
                  active ? "bg-white shadow-sm" : "hover:bg-white/50",
                )}
              >
                {(c.priority === "urgent" || c.priority === "high") && (
                  <span className={cx("absolute top-3 bottom-3 left-0 w-[3px] rounded-full", c.priority === "urgent" ? "bg-danger" : "bg-warn")} />
                )}
                <Avatar name={contact?.name ?? contact?.wa_id ?? "?"} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={cx("truncate text-[14px]", c.unread_count ? "font-semibold" : "font-medium")}>
                      {contact?.name ?? (contact ? formatPhone(contact.wa_id) : "…")}
                    </span>
                    {c.priority === "urgent" && <Flame className="size-3.5 shrink-0 text-danger" />}
                    <span className="ml-auto shrink-0 text-[11px] text-muted tabular-nums">{relTime(c.last_message_at, now)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    {c.status === "bot" && <Bot className="size-3.5 shrink-0 text-muted" />}
                    <span className={cx("truncate text-[13px]", c.unread_count ? "text-ink" : "text-muted")}>
                      {c.subject ?? c.last_message_preview ?? "…"}
                    </span>
                    {c.unread_count > 0 && (
                      <span className="ml-auto grid size-5 shrink-0 place-items-center rounded-full bg-danger text-[11px] font-semibold text-white">
                        {c.unread_count}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    {mvno && multi && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                        <span className="size-1.5 rounded-full" style={{ background: mvno.brand_color }} />
                        {mvno.name}
                      </span>
                    )}
                    {c.ticket_no && <span className="text-[11px] text-muted">#{c.ticket_no}</span>}
                    {c.sentiment === "negative" && (
                      <span className="text-[11px]" title="Negative sentiment">
                        😠
                      </span>
                    )}
                    {c.status === "open" && <SlaChip conversation={c} now={now} compact />}
                    {c.csat_score && <span className="text-[11px] text-muted">★ {c.csat_score}</span>}
                    <span className="ml-auto flex items-center gap-1">
                      {watching && (
                        <span className="text-[10px] text-muted" title={`${watching.join(", ")} viewing`}>
                          👀 {watching.length}
                        </span>
                      )}
                      {assignee && <Avatar name={assignee.full_name} size={18} />}
                    </span>
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
