import type { Mvno } from "@/lib/types";

/**
 * Features a tenant can have. Each one switches on its staff pages, inbox panel sections and reports.
 * The bot still follows the tenant's kind; modules only shape what staff see.
 */
export const MODULES = {
  billing: { label: "Live balance & line", hint: "Balance and line status in the inbox (needs billing connected)" },
  topups: { label: "Top-ups", hint: "Bundles and airtime bought in chat, with reports" },
  deliveries: { label: "SIM delivery", hint: "Delivery requests in the inbox and reports" },
  appointments: { label: "Appointments", hint: "Appointment requests from the bot, confirmed by staff" },
  id_register: { label: "ID register", hint: "Upload lists of cards received; customers check their name" },
  waiting_list: { label: "Waiting list", hint: "People asking to be told when their card arrives" },
  campaigns: { label: "Campaigns", hint: "Send templates or messages to customers" },
} as const;
export type ModuleKey = keyof typeof MODULES;
export const MODULE_KEYS = Object.keys(MODULES) as ModuleKey[];

/** What each kind of tenant had before modules existed: the defaults until an admin changes them. */
export function defaultModules(kind: Mvno["kind"]): ModuleKey[] {
  return kind === "general" ? ["appointments", "id_register", "waiting_list", "campaigns"] : ["billing", "topups", "deliveries", "campaigns"];
}

export function modulesOf(m: Pick<Mvno, "kind" | "modules">): Set<ModuleKey> {
  return new Set(m.modules ?? defaultModules(m.kind));
}

export const hasModule = (m: Pick<Mvno, "kind" | "modules">, key: ModuleKey) => modulesOf(m).has(key);

/** Telecoms' campaign audience is limited to their own number ranges; other tenants reach anyone who messaged them. */
export const usesNumberRanges = (m: Pick<Mvno, "kind">) => m.kind !== "general";
