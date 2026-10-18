"use client";

import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  emit,
  getState,
  patch,
  setTyping,
  upsertContact,
  upsertConversation,
  upsertMessage,
  type PresenceInfo,
} from "@/lib/store";
import type { Contact, Conversation, Membership, Message, Mvno, Profile } from "@/lib/types";

interface Workspace {
  ready: boolean;
  setViewing: (conversationId: string | null) => void;
  sendTyping: (conversationId: string) => void;
  /** Called on every row-change event so pages can update or refetch. */
  onEvent: (fn: Listener) => () => void;
}

type Listener = (table: string, record: Record<string, unknown>) => void;

// One realtime connection per browser tab.
const rt = {
  channels: new Map<string, RealtimeChannel>(),
  viewing: null as string | null,
  listeners: new Set<Listener>(),
  lastTypingSent: 0,
};

const Ctx = createContext<Workspace | null>(null);

export function useWorkspace() {
  const ws = use(Ctx);
  if (!ws) throw new Error("useWorkspace outside WorkspaceProvider");
  return ws;
}

type DbEvent = { payload?: { record?: Record<string, unknown>; table?: string } };

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = supabaseBrowser();
    let cancelled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    async function boot() {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) {
        window.location.assign(new URL("/login", window.location.origin));
        return;
      }
      const uid = auth.user.id;

      const [me, memberships, mvnos, profiles, convs] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", uid).single(),
        supabase.from("mvno_members").select("*"),
        supabase.from("mvnos").select("*").order("name"),
        supabase.from("profiles").select("*"),
        supabase
          .from("conversations")
          .select("*, contact:contacts(*)")
          .or(`status.neq.resolved,resolved_at.gte.${new Date(Date.now() - 7 * 86_400_000).toISOString()}`)
          .order("last_message_at", { ascending: false })
          .limit(500),
      ]);
      if (cancelled) return;

      patch((s) => {
        s.me = me.data as Profile;
        s.memberships = (memberships.data ?? []) as Membership[];
        s.mvnos = new Map(((mvnos.data ?? []) as Mvno[]).map((m) => [m.id, m]));
        s.profiles = new Map(((profiles.data ?? []) as Profile[]).map((p) => [p.id, p]));
        for (const row of convs.data ?? []) {
          const { contact, ...c } = row as Conversation & { contact: Contact };
          s.conversations.set(c.id, c);
          if (contact) s.contacts.set(contact.id, contact);
        }
      });

      // Mark online + heartbeat so auto-assignment only routes to live agents.
      const touch = (status?: Profile["status"]) =>
        supabase
          .from("profiles")
          .update({ last_seen_at: new Date().toISOString(), ...(status ? { status } : {}) })
          .eq("id", uid)
          .then(() => undefined);
      if (getState().me?.status === "offline") {
        await touch("online");
        patch((s) => s.me && (s.me.status = "online"));
      } else await touch();
      // Pick up requests that came in while nobody was online.
      if (getState().me?.status === "online") void claimFollowups();
      heartbeat = setInterval(() => void touch(), 60_000);

      await supabase.realtime.setAuth();
      for (const mvno of getState().mvnos.values()) {
        const ch = supabase.channel(`mvno:${mvno.id}`, {
          config: { private: true, presence: { key: uid } },
        });
        ch.on("broadcast", { event: "*" }, (msg) => handleBroadcast(msg.event, msg as DbEvent & { payload?: unknown }))
          .on("presence", { event: "sync" }, () => {
            const merged = new Map<string, PresenceInfo>();
            for (const c of rt.channels.values()) {
              for (const [key, metas] of Object.entries(c.presenceState<PresenceInfo>())) {
                const latest = metas[metas.length - 1];
                if (latest) merged.set(key, latest);
              }
            }
            patch((s) => (s.presence = merged));
          })
          .subscribe((status) => {
            if (status === "SUBSCRIBED") {
              patch((s) => (s.connected = true));
              void ch.track(presencePayload());
            }
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") patch((s) => (s.connected = false));
          });
        rt.channels.set(mvno.id, ch);
      }
      setReady(true);
    }

    function presencePayload(): PresenceInfo {
      const me = getState().me;
      return { user_id: me?.id ?? "", name: me?.full_name ?? "", viewing: rt.viewing, at: Date.now() };
    }

    function handleBroadcast(event: string, msg: { payload?: unknown }) {
      if (event === "typing") {
        const p = msg.payload as { conversationId: string; userId: string; name: string };
        if (p.userId !== getState().me?.id) setTyping(p.conversationId, p.userId, p.name, true);
        return;
      }
      const record = (msg as DbEvent).payload?.record;
      if (!record) return;
      const [table] = event.split(":");
      if (table === "conversations") {
        const c = record as unknown as Conversation;
        upsertConversation(c);
        if (!getState().contacts.has(c.contact_id)) {
          void supabase
            .from("contacts")
            .select("*")
            .eq("id", c.contact_id)
            .single()
            .then(({ data }) => data && upsertContact(data as Contact));
        }
      } else if (table === "messages") {
        const m = record as unknown as Message;
        upsertMessage(m);
        // Once a colleague's reply lands, their typing indicator is done.
        if (m.direction === "out" && m.sender_type === "agent") setTyping(m.conversation_id, m.sender_id ?? "", "", false);
      } else if (table === "contacts") {
        upsertContact(record as unknown as Contact);
      }
      rt.listeners.forEach((fn) => fn(table, record));
    }

    void boot();
    const onUnload = () => {
      // Best effort: tell routing we're gone.
      void supabase.from("profiles").update({ status: "offline" }).eq("id", getState().me?.id ?? "");
    };
    window.addEventListener("pagehide", onUnload);

    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      window.removeEventListener("pagehide", onUnload);
      for (const ch of rt.channels.values()) void supabase.removeChannel(ch);
      rt.channels.clear();
    };
  }, []);

  // Expire stale typing indicators.
  useEffect(() => {
    const t = setInterval(() => {
      const s = getState();
      let changed = false;
      for (const [k, v] of s.typing) {
        if (v.until < Date.now()) {
          s.typing.delete(k);
          changed = true;
        }
      }
      if (changed) emit();
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const ws: Workspace = useMemo(() => ({ ready, setViewing, sendTyping, onEvent }), [ready]);

  return <Ctx value={ws}>{children}</Ctx>;
}

function setViewing(conversationId: string | null) {
  rt.viewing = conversationId;
  const me = getState().me;
  for (const ch of rt.channels.values()) {
    void ch.track({ user_id: me?.id ?? "", name: me?.full_name ?? "", viewing: conversationId, at: Date.now() });
  }
}

function sendTyping(conversationId: string) {
  if (Date.now() - rt.lastTypingSent < 2000) return;
  rt.lastTypingSent = Date.now();
  const conv = getState().conversations.get(conversationId);
  const me = getState().me;
  if (!conv || !me) return;
  void rt.channels.get(conv.mvno_id)?.send({
    type: "broadcast",
    event: "typing",
    payload: { conversationId, userId: me.id, name: me.full_name },
  });
}

function onEvent(fn: Listener) {
  rt.listeners.add(fn);
  return () => {
    rt.listeners.delete(fn);
  };
}

/** Assigns me the oldest waiting tickets (up to my chat limit) and shows a summary banner. */
export async function claimFollowups() {
  try {
    const r = await fetch("/api/queue/claim", { method: "POST" });
    if (!r.ok) return;
    const j = (await r.json()) as { claimed: { followup_reason?: string | null }[]; waiting: number };
    if (!j.claimed.length && !j.waiting) return;
    patch((s) => {
      s.followups = {
        claimed: j.claimed.length,
        afterHours: j.claimed.filter((c) => c.followup_reason === "after_hours").length,
        waiting: j.waiting,
      };
    });
  } catch {
    // Best effort: the queue is still visible in the inbox.
  }
}
