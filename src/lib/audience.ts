/** "07243", "+256 7243", "2567243" → "2567243" (international digits, Uganda default). "" if invalid. */
export function toIntlPrefix(input: string) {
  const d = input.replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("256")) return d;
  if (d.startsWith("0")) return `256${d.slice(1)}`;
  return d.startsWith("7") ? `256${d}` : d;
}

/** "2567243" → "07243" for display. */
export function toLocalPrefix(p: string) {
  return p.startsWith("256") ? `0${p.slice(3)}` : `+${p}`;
}
