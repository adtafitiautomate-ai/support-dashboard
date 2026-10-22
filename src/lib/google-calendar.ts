import "server-only";
import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Google Calendar through a service account the tenant shared its calendar with
// ("Make changes to events"). No user sign-in involved.

type ServiceAccount = { client_email: string; private_key: string };

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const tokens = new Map<string, { token: string; exp: number }>();

async function accessToken(sa: ServiceAccount) {
  const hit = tokens.get(sa.client_email);
  if (hit && hit.exp - Date.now() > 60_000) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }),
  );
  const sig = b64url(crypto.createSign("RSA-SHA256").update(`${head}.${claims}`).sign(sa.private_key));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` }),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!j.access_token) throw new Error(`Google sign-in failed: ${j.error_description ?? j.error ?? res.status}`);
  tokens.set(sa.client_email, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

/** The tenant's calendar connection, or null when it isn't set up. */
async function calendarFor(mvnoId: string) {
  const db = supabaseAdmin();
  const [{ data: m }, { data: sa }] = await Promise.all([
    db.from("mvnos").select("google_calendar_id").eq("id", mvnoId).single(),
    db.rpc("get_google_sa", { p_mvno: mvnoId }),
  ]);
  const key = sa as ServiceAccount | null;
  if (!m?.google_calendar_id || !key?.client_email || !key.private_key) return null;
  return { calendarId: m.google_calendar_id as string, sa: key };
}

async function gcal<T>(c: { calendarId: string; sa: ServiceAccount }, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.calendarId)}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await accessToken(c.sa)}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const j = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Google Calendar: ${j.error?.message ?? res.status}`);
  return j;
}

/** Checks the connection: returns the calendar's name. */
export async function testCalendar(mvnoId: string) {
  const c = await calendarFor(mvnoId);
  if (!c) throw new Error("Add the calendar ID and the service account key first");
  const cal = await gcal<{ summary: string; timeZone: string }>(c, "");
  return { name: cal.summary, timeZone: cal.timeZone, serviceAccount: c.sa.client_email };
}

/** Adds a confirmed appointment to the calendar. Returns the event id, or null when no calendar is set up. */
export async function addAppointmentEvent(
  mvnoId: string,
  e: { title: string; description: string; location?: string | null; start: string; minutes: number; timeZone: string },
) {
  const c = await calendarFor(mvnoId);
  if (!c) return null;
  const end = new Date(new Date(e.start).getTime() + e.minutes * 60_000).toISOString();
  const ev = await gcal<{ id: string }>(c, "/events", {
    method: "POST",
    body: JSON.stringify({
      summary: e.title,
      description: e.description,
      location: e.location ?? undefined,
      start: { dateTime: new Date(e.start).toISOString(), timeZone: e.timeZone },
      end: { dateTime: end, timeZone: e.timeZone },
    }),
  });
  return ev.id;
}

export async function removeAppointmentEvent(mvnoId: string, eventId: string) {
  const c = await calendarFor(mvnoId);
  if (!c) return;
  await gcal(c, `/events/${encodeURIComponent(eventId)}`, { method: "DELETE" }).catch((err) => {
    if (!/404|410|deleted|Not Found/i.test(String(err))) throw err;
  });
}
