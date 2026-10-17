"use client";

import { Timer } from "lucide-react";
import type { Conversation } from "@/lib/types";
import { cx } from "@/components/ui";

/** First-response SLA countdown for conversations waiting on a human. */
export function SlaChip({ conversation: c, now, compact }: { conversation: Conversation; now: number; compact?: boolean }) {
  if (!c.sla_due_at || c.first_response_at) return null;
  const left = Math.round((new Date(c.sla_due_at).getTime() - now) / 1000);
  const breached = left < 0;
  const soon = !breached && left < 120;
  const abs = Math.abs(left);
  const label = abs >= 3600 ? `${Math.floor(abs / 3600)}h${Math.floor((abs % 3600) / 60)}m` : abs >= 60 ? `${Math.floor(abs / 60)}m` : `${abs}s`;
  return (
    <span
      title={breached ? "First-response SLA breached" : "Time left to first response"}
      className={cx(
        "inline-flex items-center gap-0.5 rounded px-1 text-[11px] font-medium tabular-nums",
        breached ? "bg-red-500/12 text-danger" : soon ? "bg-amber-500/15 text-warn" : "text-muted",
      )}
    >
      <Timer className="size-3" />
      {breached ? `+${label}` : label}
      {!compact && (breached ? " overdue" : " left")}
    </span>
  );
}
