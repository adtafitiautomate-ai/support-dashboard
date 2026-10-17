export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export function formatData(mb: number) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)}GB`;
  return `${mb}MB`;
}

export function formatMoney(amount: number, currency: string) {
  return `${currency} ${Number(amount).toLocaleString("en", { maximumFractionDigits: 2 })}`;
}

export function bundleSummary(b: { data_mb: number; minutes: number; sms: number; validity_days: number }) {
  const parts: string[] = [];
  if (b.data_mb) parts.push(formatData(b.data_mb));
  if (b.minutes) parts.push(b.minutes >= 99999 ? "unlimited min" : `${b.minutes} min`);
  if (b.sms) parts.push(`${b.sms} SMS`);
  parts.push(b.validity_days === 1 ? "24h" : `${b.validity_days} days`);
  return parts.join(" · ");
}

export function initials(name: string | null | undefined) {
  return (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

export function formatPhone(waId: string) {
  return waId.startsWith("+") ? waId : `+${waId}`;
}
