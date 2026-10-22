import "server-only";
import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";

// vtiger CRM (8.x) web-service client. The integration user can read Organizations and
// create/update Tickets only (its profile has no delete rights).

const cfg = () => {
  const url = process.env.VTIGER_URL?.replace(/\/+$/, "");
  const user = process.env.VTIGER_USER;
  const key = process.env.VTIGER_API_KEY;
  return url && user && key ? { endpoint: `${url}/webservice.php`, url, user, key } : null;
};
/** vtiger is configured AND switched on for this tenant (Admin → tenant). Other tenants never see it. */
export const vtigerConfigured = () => !!cfg();
export const vtigerEnabled = (mvno: { vtiger_enabled?: boolean | null }) => !!cfg() && mvno.vtiger_enabled === true;
export const vtigerRecordUrl = (id: string) => {
  const c = cfg();
  return c ? `${c.url}/index.php?module=HelpDesk&view=Detail&record=${id.split("x")[1]}` : null;
};

let session: { name: string; at: number } | null = null;
// vtiger keeps ONE login challenge per user: parallel logins overwrite each other's token
// and fail ("Invalid username or password"). Concurrent callers share one login.
let loggingIn: Promise<string> | null = null;

async function call<T>(params: Record<string, string>, post = false): Promise<T> {
  const c = cfg();
  if (!c) throw new Error("vtiger is not configured");
  const res = post
    ? await fetch(c.endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), cache: "no-store" })
    : await fetch(`${c.endpoint}?${new URLSearchParams(params)}`, { cache: "no-store" });
  const j = (await res.json().catch(() => null)) as { success?: boolean; result?: T; error?: { code?: string; message?: string } } | null;
  if (!j?.success) {
    const e = new Error(j?.error?.message ?? `vtiger request failed (${res.status})`) as Error & { code?: string };
    e.code = j?.error?.code;
    throw e;
  }
  return j.result as T;
}

async function sessionName(fresh = false) {
  if (!fresh && session && Date.now() - session.at < 10 * 60_000) return session.name;
  if (loggingIn) return loggingIn;
  loggingIn = (async () => {
    const c = cfg()!;
    const ch = await call<{ token: string }>({ operation: "getchallenge", username: c.user });
    const login = await call<{ sessionName: string }>(
      { operation: "login", username: c.user, accessKey: crypto.createHash("md5").update(ch.token + c.key).digest("hex") },
      true,
    );
    session = { name: login.sessionName, at: Date.now() };
    return session.name;
  })();
  try {
    return await loggingIn;
  } finally {
    loggingIn = null;
  }
}

/** Runs a call with a session, signing in again once if the session expired. */
async function withSession<T>(fn: (s: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await sessionName());
  } catch (e) {
    if ((e as { code?: string }).code !== "INVALID_SESSIONID") throw e;
    return fn(await sessionName(true));
  }
}

const query = <T>(q: string) => withSession((s) => call<T[]>({ operation: "query", sessionName: s, query: q }));

export type VtigerOptions = {
  organizations: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  people: { id: string; name: string }[];
  priorities: string[];
  severities: string[];
  categories: string[];
};

let optionsCache: { at: number; data: VtigerOptions } | null = null;

const CACHE_MS = 30 * 60_000;

/**
 * Everything the escalate form needs (read-only). Cached in memory and in the database for
 * 30 minutes, so a freshly started server doesn't have to sign in to vtiger to show the form.
 */
export async function vtigerOptions(): Promise<VtigerOptions> {
  if (optionsCache && Date.now() - optionsCache.at < CACHE_MS) return optionsCache.data;
  const db = supabaseAdmin();
  const { data: cached } = await db.from("app_cache").select("value, updated_at").eq("key", "vtiger_options").maybeSingle();
  if (cached && Date.now() - new Date(cached.updated_at).getTime() < CACHE_MS) {
    optionsCache = { at: new Date(cached.updated_at).getTime(), data: cached.value as VtigerOptions };
    return optionsCache.data;
  }
  const [orgs, groups, describe] = await Promise.all([
    query<{ id: string; accountname: string }>("SELECT id, accountname FROM Accounts ORDER BY accountname LIMIT 200;"),
    query<{ id: string; groupname: string }>("SELECT id, groupname FROM Groups;"),
    withSession((s) => call<{ fields: { name: string; type: { picklistValues?: { value: string }[] } }[] }>({ operation: "describe", sessionName: s, elementType: "HelpDesk" })),
  ]);
  const pick = (n: string) => describe.fields.find((f) => f.name === n)?.type.picklistValues?.map((p) => p.value) ?? [];
  const data: VtigerOptions = {
    organizations: orgs.map((o) => ({ id: o.id, name: o.accountname.trim() })),
    groups: groups.map((g) => ({ id: g.id, name: g.groupname.trim() })).sort((a, b) => a.name.localeCompare(b.name)),
    // People the integration user may assign to (it can't list vtiger users itself).
    people: (process.env.VTIGER_ASSIGNEES ?? "")
      .split(",")
      .map((p) => p.split(":").map((x) => x.trim()))
      .filter(([n, id]) => n && /^19x\d+$/.test(id ?? ""))
      .map(([name, id]) => ({ id, name })),
    priorities: pick("ticketpriorities"),
    severities: pick("ticketseverities"),
    categories: pick("ticketcategories"),
  };
  optionsCache = { at: Date.now(), data };
  await db.from("app_cache").upsert({ key: "vtiger_options", value: data, updated_at: new Date().toISOString() });
  return data;
}

/** Creates one HelpDesk ticket. Returns its id and ticket number. */
export async function createVtigerTicket(fields: {
  title: string;
  organizationId: string;
  assignedTo: string;
  priority: string;
  severity?: string;
  category?: string;
  description: string;
  requestor?: string;
}) {
  const element = {
    ticket_title: fields.title.slice(0, 250),
    parent_id: fields.organizationId,
    assigned_user_id: fields.assignedTo,
    ticketpriorities: fields.priority,
    ticketstatus: "Open",
    ...(fields.severity ? { ticketseverities: fields.severity } : {}),
    ...(fields.category ? { ticketcategories: fields.category } : {}),
    description: fields.description.slice(0, 30_000),
    ...(fields.requestor ? { cf_861: fields.requestor.slice(0, 250) } : {}),
  };
  return withSession((s) =>
    call<{ id: string; ticket_no: string }>({ operation: "create", sessionName: s, elementType: "HelpDesk", element: JSON.stringify(element) }, true),
  );
}

/** Suggests a vtiger category from the chat's subject/summary/category. */
export function suggestCategory(categories: string[], text: string, tenantName: string) {
  const t = text.toLowerCase();
  const has = (c: string) => categories.find((x) => x.toUpperCase() === c);
  const rules: [RegExp, string][] = [
    [/\bpin\b/, "PIN RESET"],
    [/\bkyc\b|registration|register|national id|\bnin\b/, "KYC"],
    [/agent.*(float|commission|wallet|cash)|float|commission/, "AGENT - MOBILE MONEY"],
    [/agent.*sim|sim (card|swap|replacement)|lost (line|sim|phone)|stolen/, "AGENT - SIM CARDS"],
    [/pesa|sente|mobile money|withdraw|deposit|send money|transaction|reversal|wallet|agropay/, "MOBILE MONEY"],
    [/\bapp\b|application/, `${tenantName.toUpperCase().replace(/MOBILE$/, "").trim()} APP`],
    [/sms fail|sms not|can't send sms|cannot send sms/, "SMS FAILURE"],
    [/\bsms\b/, "SMS"],
    [/landline|fixed line/, "LANDLINE"],
    [/data|internet|bundle|mb\b|gb\b|apn|browsing|network/, "MOBILE DATA"],
    [/call|voice|minutes|airtime/, "MOBILE VOICE"],
  ];
  for (const [re, c] of rules) if (re.test(t) && has(c)) return has(c)!;
  return "";
}
