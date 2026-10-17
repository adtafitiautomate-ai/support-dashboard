import { errorResponse, HttpError, requireAgent } from "@/lib/inbox/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { parseCsv } from "@/lib/csv";

// Header aliases → outlet fields.
const ALIASES: Record<string, string[]> = {
  name: ["name", "agent name", "agent", "outlet", "outlet name", "business name", "shop name"],
  kind: ["type", "kind", "category", "outlet type"],
  address: ["address", "location", "street", "area", "place", "landmark"],
  district: ["district", "town", "city", "region"],
  lat: ["lat", "latitude", "y"],
  lng: ["lng", "lon", "long", "longitude", "x"],
  phone: ["phone", "phone number", "contact", "tel", "mobile", "msisdn"],
  hours: ["hours", "opening hours", "open", "working hours"],
  services: ["services", "service", "offers"],
};

const norm = (s: string) => s.toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();

function kindOf(v: string): "agent" | "store" | "kiosk" {
  const k = norm(v);
  if (/service|centre|center|store|shop|branch|office/.test(k)) return "store";
  if (/kiosk/.test(k)) return "kiosk";
  return "agent";
}

async function requireManager(mvnoId: string) {
  const { supabase, profile } = await requireAgent();
  if (profile.is_platform_admin) return;
  const { data } = await supabase.from("mvno_members").select("role").eq("mvno_id", mvnoId).eq("user_id", profile.id).maybeSingle();
  if (!data || (data.role !== "admin" && data.role !== "supervisor")) throw new HttpError(403, "Only supervisors and admins can manage locations");
}

/** POST multipart: file (CSV), mvnoId, mode = "add" | "replace". */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const mvnoId = String(form.get("mvnoId") ?? "");
    const mode = form.get("mode") === "replace" ? "replace" : "add";
    await requireManager(mvnoId);

    const file = form.get("file");
    if (!(file instanceof File) || !file.size) throw new HttpError(400, "Choose a CSV file");
    if (file.size > 5 * 1024 * 1024) throw new HttpError(413, "CSV is too large (5 MB max)");

    const [header, ...lines] = parseCsv(await file.text());
    if (!header || !lines.length) throw new HttpError(400, "The CSV is empty");
    const col: Record<string, number> = {};
    header.forEach((h, i) => {
      const key = Object.entries(ALIASES).find(([, names]) => names.includes(norm(h)))?.[0];
      if (key && col[key] === undefined) col[key] = i;
    });
    for (const required of ["name", "lat", "lng"]) {
      if (col[required] === undefined) throw new HttpError(400, `Missing a "${required}" column. Expected headers like: name, type, address, district, latitude, longitude, phone, hours, services`);
    }

    const get = (r: string[], k: string) => (col[k] === undefined ? "" : (r[col[k]] ?? "").trim());
    const skipped: { line: number; reason: string }[] = [];
    const rows: Record<string, unknown>[] = [];
    lines.forEach((r, i) => {
      const line = i + 2;
      const name = get(r, "name");
      const lat = Number(get(r, "lat"));
      const lng = Number(get(r, "lng"));
      if (!name) return skipped.push({ line, reason: "no name" });
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
        return skipped.push({ line, reason: `invalid coordinates for "${name}"` });
      }
      const address = [get(r, "address"), get(r, "district")].filter(Boolean).join(", ");
      rows.push({
        mvno_id: mvnoId,
        name: name.slice(0, 120),
        kind: kindOf(get(r, "kind") || "agent"),
        address: address || name,
        lat,
        lng,
        phone: get(r, "phone") || null,
        hours: get(r, "hours") || null,
        services: get(r, "services")
          ? get(r, "services").split(/[;|/]/).map((s) => norm(s).replace(/ /g, "_")).filter(Boolean)
          : kindOf(get(r, "kind") || "agent") === "store"
            ? ["sim_swap", "esim", "mobile_money", "bundles"]
            : ["mobile_money", "airtime", "bundles"],
      });
    });
    if (!rows.length) throw new HttpError(400, `No valid rows. ${skipped.slice(0, 3).map((s) => `Line ${s.line}: ${s.reason}`).join("; ")}`);

    const db = supabaseAdmin();
    let removed = 0;
    if (mode === "replace") {
      // Only replace the kinds present in this file (e.g. an agents list never wipes service centres).
      const kinds = [...new Set(rows.map((r) => r.kind as string))];
      const { data } = await db.from("outlets").delete().eq("mvno_id", mvnoId).in("kind", kinds).select("id");
      removed = data?.length ?? 0;
    } else {
      // "add" updates outlets with the same name instead of duplicating them.
      const names = rows.map((r) => r.name as string);
      for (let i = 0; i < names.length; i += 200) {
        await db.from("outlets").delete().eq("mvno_id", mvnoId).in("name", names.slice(i, i + 200));
      }
    }
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("outlets").insert(rows.slice(i, i + 500));
      if (error) throw error;
    }
    return Response.json({ imported: rows.length, removed, skipped });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE ?id=<outletId> */
export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    const { data: outlet } = await supabaseAdmin().from("outlets").select("mvno_id").eq("id", id).maybeSingle();
    if (!outlet) throw new HttpError(404, "Location not found");
    await requireManager(outlet.mvno_id);
    await supabaseAdmin().from("outlets").delete().eq("id", id);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
