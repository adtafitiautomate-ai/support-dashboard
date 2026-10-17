export type MemberRole = "admin" | "supervisor" | "agent";
export type AgentStatus = "online" | "away" | "offline";
export type ConversationStatus = "bot" | "open" | "pending" | "resolved";
export type Priority = "low" | "normal" | "high" | "urgent";
export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed" | "received";
export type SenderType = "contact" | "bot" | "agent" | "system";

export interface Mvno {
  id: string;
  slug: string;
  name: string;
  brand_color: string;
  currency: string;
  wallet_name: string;
  wallet_ussd: string | null;
  care_line: string | null;
  wa_phone_number_id: string | null;
  wa_display_number: string | null;
  bot_name: string;
  bot_persona: string;
  greeting: string;
  sla_first_response_mins: number;
  business_hours: { tz: string; open: string; close: string; days: number[] };
}

export interface Profile {
  id: string;
  full_name: string;
  avatar_url: string | null;
  is_platform_admin: boolean;
  status: AgentStatus;
  last_seen_at: string | null;
}

export interface Membership {
  mvno_id: string;
  user_id: string;
  role: MemberRole;
  max_concurrent: number;
}

export interface Contact {
  id: string;
  mvno_id: string;
  wa_id: string;
  name: string | null;
  msisdn: string | null;
  language: string;
  tags: string[];
  plan: string | null;
  notes: string | null;
  last_location: { lat: number; lng: number; at: string } | null;
  created_at: string;
  last_seen_at: string | null;
}

export interface BotState {
  flow?: string;
  step?: string;
  data?: Record<string, unknown>;
  awaiting?: "csat" | "location" | "address" | "msisdn" | "amount";
  ai_turns?: number;
}

export interface Conversation {
  id: string;
  ticket_no: number;
  mvno_id: string;
  contact_id: string;
  status: ConversationStatus;
  priority: Priority;
  assignee_id: string | null;
  category: string | null;
  subject: string | null;
  ai_summary: string | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  bot_state: BotState;
  unread_count: number;
  last_message_at: string;
  last_message_preview: string | null;
  last_inbound_at: string | null;
  handoff_at: string | null;
  first_response_at: string | null;
  sla_due_at: string | null;
  resolved_at: string | null;
  csat_score: number | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  mvno_id: string;
  direction: "in" | "out";
  sender_type: SenderType;
  sender_id: string | null;
  type: string;
  body: string | null;
  payload: Record<string, unknown>;
  is_internal: boolean;
  wa_message_id: string | null;
  status: MessageStatus;
  error: string | null;
  created_at: string;
}

export interface Bundle {
  id: string;
  mvno_id: string;
  code: string;
  name: string;
  category: "voice" | "data" | "combo" | "deal";
  ussd: string | null;
  price: number;
  data_mb: number;
  minutes: number;
  sms: number;
  validity_days: number;
  active: boolean;
  sort: number;
}

export interface Outlet {
  id: string;
  mvno_id: string;
  name: string;
  kind: "store" | "agent" | "kiosk";
  address: string;
  lat: number;
  lng: number;
  phone: string | null;
  hours: string | null;
  services: string[];
}

export interface Recharge {
  id: string;
  mvno_id: string;
  contact_id: string | null;
  msisdn: string;
  kind: "airtime" | "bundle";
  bundle_id: string | null;
  amount: number;
  method: string;
  status: "pending" | "success" | "failed";
  reference: string;
  created_at: string;
}

export interface Delivery {
  id: string;
  mvno_id: string;
  contact_id: string | null;
  item: "sim" | "esim" | "device" | "router";
  status: "requested" | "scheduled" | "out_for_delivery" | "delivered" | "failed" | "cancelled";
  address: string | null;
  lat: number | null;
  lng: number | null;
  scheduled_for: string | null;
  tracking_code: string;
  rider_name: string | null;
  rider_phone: string | null;
  created_at: string;
  updated_at: string;
}

export interface CannedResponse {
  id: string;
  mvno_id: string;
  shortcut: string;
  title: string;
  body: string;
}

export interface KbArticle {
  id: string;
  mvno_id: string;
  title: string;
  body: string;
  tags: string[];
}
