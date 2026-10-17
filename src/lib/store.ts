"use client";

import { useSyncExternalStore } from "react";
import type { Contact, Conversation, Message, Membership, Mvno, Profile } from "./types";

// A tiny global store for the realtime inbox. Realtime events mutate it in place
// and bump a version; components subscribe with selectors.

export interface PresenceInfo {
  user_id: string;
  name: string;
  viewing: string | null;
  at: number;
}

interface State {
  me: Profile | null;
  memberships: Membership[];
  mvnos: Map<string, Mvno>;
  profiles: Map<string, Profile>;
  conversations: Map<string, Conversation>;
  contacts: Map<string, Contact>;
  messages: Map<string, Message[]>; // by conversation id, ascending
  presence: Map<string, PresenceInfo>; // by user id
  typing: Map<string, { userId: string; name: string; until: number }>; // by conversation id
  connected: boolean;
  version: number;
}

const state: State = {
  me: null,
  memberships: [],
  mvnos: new Map(),
  profiles: new Map(),
  conversations: new Map(),
  contacts: new Map(),
  messages: new Map(),
  presence: new Map(),
  typing: new Map(),
  connected: false,
  version: 0,
};

const listeners = new Set<() => void>();
let scheduled = false;

/** Batches bursts of realtime events into one render per frame. */
export function emit() {
  state.version++;
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    listeners.forEach((l) => l());
  });
}

export function getState() {
  return state;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Re-renders when the store version changes; selector output should be cheap. */
export function useStore<T>(selector: (s: State) => T): T {
  const version = useSyncExternalStore(
    subscribe,
    () => state.version,
    () => 0,
  );
  void version;
  return selector(state);
}

// ------------------------------------------------------------------ mutations

export function upsertConversation(c: Conversation) {
  const prev = state.conversations.get(c.id);
  if (prev && new Date(prev.updated_at) > new Date(c.updated_at)) return;
  state.conversations.set(c.id, prev ? { ...prev, ...c } : c);
  emit();
}

export function upsertContact(c: Contact) {
  state.contacts.set(c.id, c);
  emit();
}

export function setMessages(conversationId: string, list: Message[]) {
  state.messages.set(conversationId, list);
  emit();
}

export function upsertMessage(m: Message) {
  const list = state.messages.get(m.conversation_id);
  if (!list) return; // thread not loaded; it will fetch fresh when opened
  const idx = list.findIndex((x) => x.id === m.id);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...m };
  } else {
    // Drop the optimistic copy this server row replaces.
    const tmp = list.findIndex(
      (x) => x.id.startsWith("tmp-") && x.sender_id === m.sender_id && x.body === m.body && x.is_internal === m.is_internal,
    );
    if (tmp >= 0) list.splice(tmp, 1);
    list.push(m);
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  state.messages.set(m.conversation_id, [...list]);
  emit();
}

export function removeMessage(conversationId: string, id: string) {
  const list = state.messages.get(conversationId);
  if (!list) return;
  state.messages.set(
    conversationId,
    list.filter((m) => m.id !== id),
  );
  emit();
}

export function setTyping(conversationId: string, userId: string, name: string, on: boolean) {
  if (on) state.typing.set(conversationId, { userId, name, until: Date.now() + 4000 });
  else if (state.typing.get(conversationId)?.userId === userId) state.typing.delete(conversationId);
  emit();
}

export function patch(fn: (s: State) => void) {
  fn(state);
  emit();
}
