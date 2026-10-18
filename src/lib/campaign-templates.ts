// Shared (client + server) shapes for WhatsApp template campaigns.

export type HeaderFormat = "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";

export interface ParsedTemplate {
  name: string;
  language: string;
  category: string;
  named: boolean; // {{first_name}} instead of {{1}}
  header?: { format: HeaderFormat; text?: string; vars: string[] };
  body: { text: string; vars: string[] };
  footer?: string;
  buttons: { type: string; text: string; url?: string; urlVar?: string; index: number }[];
  /** Why this template can't be sent from here, if it can't. */
  unsupported?: string;
}

/** A variable's value: fixed text, or each customer's first name (with fallback text). */
export type VarValue = { mode: "text"; text: string } | { mode: "name"; fallback: string };

const VAR = /\{\{\s*([\w]+)\s*\}\}/g;
export const varsIn = (s?: string) => [...new Set([...(s ?? "").matchAll(VAR)].map((m) => m[1]))];

type MetaComponent = {
  type: string;
  format?: string;
  text?: string;
  buttons?: { type: string; text?: string; url?: string }[];
};

export function parseTemplate(t: { name: string; language: string; category: string; parameter_format?: string; components: MetaComponent[] }): ParsedTemplate {
  const header = t.components.find((c) => c.type === "HEADER");
  const body = t.components.find((c) => c.type === "BODY");
  const footer = t.components.find((c) => c.type === "FOOTER");
  const btns = t.components.find((c) => c.type === "BUTTONS")?.buttons ?? [];
  const out: ParsedTemplate = {
    name: t.name,
    language: t.language,
    category: t.category,
    named: t.parameter_format === "NAMED",
    header: header ? { format: (header.format ?? "TEXT") as HeaderFormat, text: header.text, vars: varsIn(header.text) } : undefined,
    body: { text: body?.text ?? "", vars: varsIn(body?.text) },
    footer: footer?.text,
    buttons: btns.map((b, index) => ({ type: b.type, text: b.text ?? "", url: b.url, urlVar: b.type === "URL" ? varsIn(b.url)[0] : undefined, index })),
  };
  const odd = t.components.find((c) => !["HEADER", "BODY", "FOOTER", "BUTTONS"].includes(c.type));
  if (odd) out.unsupported = `${odd.type.toLowerCase()} templates aren't supported here yet`;
  else if (header?.format === "LOCATION") out.unsupported = "location headers aren't supported here yet";
  else if (btns.some((b) => !["URL", "QUICK_REPLY", "PHONE_NUMBER"].includes(b.type))) out.unsupported = "this button type isn't supported here yet";
  return out;
}

/** Every variable the sender has to fill in, in display order. */
export function templateFields(t: ParsedTemplate) {
  return [
    ...(t.header?.format === "TEXT" ? t.header.vars.map((v) => ({ key: `header.${v}`, label: `Header {{${v}}}` })) : []),
    ...t.body.vars.map((v) => ({ key: `body.${v}`, label: `{{${v}}}` })),
    ...t.buttons.filter((b) => b.urlVar).map((b) => ({ key: `button.${b.index}`, label: `Link button "${b.text}": end of URL` })),
  ];
}

/** The message text a customer will see, with the values filled in (for previews). */
export function renderPreview(t: ParsedTemplate, values: Record<string, VarValue>, name = "Joan") {
  const fill = (s: string, part: string) =>
    s.replace(VAR, (_, k: string) => {
      const v = values[`${part}.${k}`];
      return !v ? `{{${k}}}` : v.mode === "name" ? name || v.fallback : v.text || `{{${k}}}`;
    });
  return {
    header: t.header?.format === "TEXT" ? fill(t.header.text ?? "", "header") : undefined,
    body: fill(t.body.text, "body"),
    footer: t.footer,
  };
}
