import type { Mvno } from "@/lib/types";

type Hours = Mvno["business_hours"];
const DEFAULT: Hours = { tz: "Africa/Kampala", open: "08:00", close: "20:00", days: [0, 1, 2, 3, 4, 5, 6] };
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Day of week (0 = Sunday) and minutes since midnight in the MVNO's time zone. */
function localNow(tz: string, at: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, mins: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function isOpen(hours: Hours | null | undefined, at = new Date()) {
  const h = { ...DEFAULT, ...hours };
  const { day, mins } = localNow(h.tz, at);
  const open = toMin(h.open);
  const close = toMin(h.close);
  if (open === close) return h.days.includes(day); // 24h on open days
  if (open < close) return h.days.includes(day) && mins >= open && mins < close;
  // Overnight shift (e.g. 20:00–02:00): after midnight counts as the previous day's shift.
  return (h.days.includes(day) && mins >= open) || (h.days.includes((day + 6) % 7) && mins < close);
}

/** "later today at 08:00", "tomorrow at 08:00" or "on Monday at 08:00". */
export function nextOpening(hours: Hours | null | undefined, at = new Date()) {
  const h = { ...DEFAULT, ...hours };
  if (!h.days.length) return null;
  const { day, mins } = localNow(h.tz, at);
  for (let i = 0; i < 8; i++) {
    const d = (day + i) % 7;
    if (!h.days.includes(d)) continue;
    if (i === 0 && mins >= toMin(h.open)) continue;
    const when = i === 0 ? "later today" : i === 1 ? "tomorrow" : `on ${DAY_NAMES[d]}`;
    return `${when} at ${h.open}`;
  }
  return null;
}

/** "08:00–20:00, every day" / "08:00–17:00, Monday to Friday" for customer messages. */
export function describeHours(hours: Hours | null | undefined) {
  const h = { ...DEFAULT, ...hours };
  const days = [...h.days].sort();
  const span =
    days.length === 7
      ? "every day"
      : days.join() === "1,2,3,4,5"
        ? "Monday to Friday"
        : days.join() === "1,2,3,4,5,6"
          ? "Monday to Saturday"
          : days.map((d) => DAY_NAMES[d].slice(0, 3)).join(", ");
  return `${h.open}–${h.close}, ${span}`;
}
