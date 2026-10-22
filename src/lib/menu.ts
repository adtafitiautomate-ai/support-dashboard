// Main menu for "general business" tenants (e.g. an embassy). WhatsApp list rows allow
// at most 10 items, titles up to 24 characters and descriptions up to 72.

export type MenuAction = "answer" | "appointment" | "location" | "emergency" | "human";

export interface MenuItem {
  id: string;
  title: string; // ≤ 24 chars
  description?: string; // ≤ 72 chars
  action: MenuAction;
}

export const MENU_ACTIONS: { value: MenuAction; label: string }[] = [
  { value: "answer", label: "Answer from the knowledge base" },
  { value: "appointment", label: "Appointment request (becomes a ticket)" },
  { value: "location", label: "Office hours and location" },
  { value: "emergency", label: "Emergency help (urgent alert)" },
  { value: "human", label: "Talk to a person" },
];

export const DEFAULT_GENERAL_MENU: MenuItem[] = [
  { id: "national_id", title: "National ID", description: "Check your ID status and where to pick it up", action: "answer" },
  { id: "passports_visas", title: "Passports and visas", description: "Steps, requirements and official links", action: "answer" },
  { id: "documents", title: "Official documents", description: "Incl. emergency travel documents", action: "answer" },
  { id: "appointment", title: "Book an appointment", description: "Send a request; an officer confirms the slot", action: "appointment" },
  { id: "hours_location", title: "Office hours & location", description: "Address, opening hours and map", action: "location" },
  { id: "emergency", title: "Emergency help", description: "Urgent help for citizens in trouble", action: "emergency" },
  { id: "officer", title: "Talk to an officer", description: "Chat with a member of our team", action: "human" },
];

export const MAX_MENU_ITEMS = 10;
