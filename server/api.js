// Server-Teil des Camper-Planers (Cloudflare Pages Functions).
// Datenbank D1 (Binding DB), Fotospeicher R2 (Binding MEDIEN, optional), Anmeldung über Cloudflare Access.
//
//   GET    /api/ich                 angemeldete Person mit Rolle
//   GET    /api/daten               eigene Merkliste und eigene Plätze
//   POST   /api/daten               { merk: {schlüssel: daten|null}, eigene: {id: daten|null} }
//   GET    /api/personen            alle Personen (Admin)
//   POST   /api/personen            { email, name, rolle } anlegen oder ändern (Admin)
//   DELETE /api/personen/<email>    Person entfernen (Admin)
//   GET    /api/medien?bezug=…      eigene Fotos zu einem Platz
//   POST   /api/medien              Foto hochladen (multipart: datei, klein, bezug, …)
//   GET    /api/medien/<id>[?klein] Foto oder Vorschau
//   DELETE /api/medien/<id>         Foto löschen

import { angemeldet } from "./auth.js";

const ROLLEN = ["admin", "mitreisend", "gast"];
const BILDTYPEN = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
const MAX_BILD = 15 * 1024 * 1024;
const MAX_EINTRAG = 20_000;

class Fehler extends Error {
  constructor(status, text) { super(text); this.status = status; }
}
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
const jetzt = () => new Date().toISOString();

async function body(request, max) {
  const text = await request.text();
  if (text.length > max) throw new Fehler(413, "Anfrage zu gross");
  try { return JSON.parse(text || "{}"); } catch { throw new Fehler(400, "Ungültiges JSON"); }
}

export async function onRequest(ctx) {
  const { request, env } = ctx;
  try {
    if (!env.DB) throw new Fehler(503, "Datenbank noch nicht eingerichtet");
    const url = new URL(request.url);
    // Schreibende Anfragen nur von der App selbst (Schutz gegen fremde Seiten, die im Namen der Person senden)
    if (request.method !== "GET" && request.headers.get("Origin") !== url.origin) throw new Fehler(403, "Ungültige Herkunft");
    if (!env.ACCESS_AUD && !env.DEV_EMAIL) throw new Fehler(503, "Anmeldeprüfung noch nicht eingerichtet");
    const email = await angemeldet(request, env);
    if (!email) throw new Fehler(401, "Nicht angemeldet");
    const ich = await person(env, email);
    const teile = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const route = `${request.method} ${teile[0] || ""}`;

    switch (route) {
      case "GET ich":
        await env.DB.prepare("UPDATE personen SET zuletzt = ? WHERE email = ?").bind(jetzt(), email).run();
        return json({ ...ich, fotos: !!env.MEDIEN });
      case "GET daten": return json(await datenLesen(env, email));
      case "POST daten": darf(ich, "mitreisend"); return json(await datenSchreiben(env, email, await body(request, 5_000_000)));
      case "GET personen": darf(ich, "admin"); return json(await personenListe(env));
      case "POST personen": darf(ich, "admin"); return json(await personSetzen(env, ich, await body(request, 10_000)));
      case "DELETE personen": darf(ich, "admin"); return json(await personEntfernen(env, ich, teile[1]));
      case "GET medien":
        return teile[1] ? medienHolen(env, email, teile[1], url.searchParams.has("klein")) : json(await medienListe(env, email, url.searchParams.get("bezug")));
      case "POST medien": darf(ich, "mitreisend"); return json(await medienHochladen(env, email, request));
      case "DELETE medien": darf(ich, "mitreisend"); return json(await medienLoeschen(env, email, teile[1]));
      default: throw new Fehler(404, "Unbekannte Adresse");
    }
  } catch (err) {
    if (err instanceof Fehler) return json({ fehler: err.message }, err.status);
    console.error(err);
    return json({ fehler: "Interner Fehler" }, 500);
  }
}

// ---------------------------------------------------------------- Personen und Rollen
async function person(env, email) {
  const admin = (env.ADMIN_EMAIL || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  let p = await env.DB.prepare("SELECT email, name, rolle FROM personen WHERE email = ?").bind(email).first();
  if (!p) {
    // Erste Anmeldung: Gast, ausser die Adresse ist als Admin hinterlegt
    p = { email, name: "", rolle: admin.includes(email) ? "admin" : "gast" };
    await env.DB.prepare("INSERT OR IGNORE INTO personen (email, name, rolle, erstellt) VALUES (?, ?, ?, ?)").bind(email, "", p.rolle, jetzt()).run();
  } else if (admin.includes(email) && p.rolle !== "admin") {
    // Die hinterlegte Admin-Adresse kann sich nie selbst aussperren
    p.rolle = "admin";
    await env.DB.prepare("UPDATE personen SET rolle = 'admin' WHERE email = ?").bind(email).run();
  }
  return p;
}

function darf(ich, mindestens) {
  const ok = mindestens === "admin" ? ich.rolle === "admin" : ich.rolle === "admin" || ich.rolle === "mitreisend";
  if (!ok) throw new Fehler(403, mindestens === "admin" ? "Nur für Admins" : "Als Gast können Sie nur ansehen");
}

async function personenListe(env) {
  const { results } = await env.DB.prepare("SELECT email, name, rolle, erstellt, zuletzt FROM personen ORDER BY rolle, email").all();
  return results;
}

async function personSetzen(env, ich, b) {
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw new Fehler(400, "Ungültige E-Mail-Adresse");
  if (!ROLLEN.includes(b.rolle)) throw new Fehler(400, "Ungültige Rolle");
  if (email === ich.email && b.rolle !== "admin") throw new Fehler(400, "Sie können sich nicht selbst die Admin-Rolle entziehen");
  const name = String(b.name || "").trim().slice(0, 100);
  await env.DB.prepare(`INSERT INTO personen (email, name, rolle, erstellt) VALUES (?, ?, ?, ?)
    ON CONFLICT (email) DO UPDATE SET name = excluded.name, rolle = excluded.rolle`).bind(email, name, b.rolle, jetzt()).run();
  return { ok: true };
}

async function personEntfernen(env, ich, email) {
  email = String(email || "").toLowerCase();
  if (email === ich.email) throw new Fehler(400, "Sie können sich nicht selbst entfernen");
  await env.DB.prepare("DELETE FROM personen WHERE email = ?").bind(email).run();
  return { ok: true };
}

// ---------------------------------------------------------------- Merkliste und eigene Plätze
async function datenLesen(env, email) {
  const [m, e] = await env.DB.batch([
    env.DB.prepare("SELECT schluessel, daten FROM merk WHERE email = ?").bind(email),
    env.DB.prepare("SELECT daten FROM eigene WHERE email = ? ORDER BY geaendert").bind(email),
  ]);
  const merk = {};
  for (const r of m.results) merk[r.schluessel] = JSON.parse(r.daten);
  return { merk, eigene: e.results.map((r) => JSON.parse(r.daten)) };
}

async function datenSchreiben(env, email, b) {
  const t = jetzt(), stmts = [];
  const pruefe = (k, v) => {
    if (typeof k !== "string" || !k || k.length > 300) throw new Fehler(400, "Ungültiger Schlüssel");
    if (v !== null && (typeof v !== "object" || Array.isArray(v))) throw new Fehler(400, "Ungültiger Eintrag");
    const s = v === null ? null : JSON.stringify(v);
    if (s && s.length > MAX_EINTRAG) throw new Fehler(400, "Eintrag zu gross");
    return s;
  };
  for (const [k, v] of Object.entries(b.merk || {})) {
    const s = pruefe(k, v);
    stmts.push(s === null
      ? env.DB.prepare("DELETE FROM merk WHERE email = ? AND schluessel = ?").bind(email, k)
      : env.DB.prepare("INSERT OR REPLACE INTO merk (email, schluessel, daten, geaendert) VALUES (?, ?, ?, ?)").bind(email, k, s, t));
  }
  for (const [k, v] of Object.entries(b.eigene || {})) {
    const s = pruefe(k, v);
    if (v && v.id !== k) throw new Fehler(400, "ID passt nicht zum Eintrag");
    stmts.push(s === null
      ? env.DB.prepare("DELETE FROM eigene WHERE email = ? AND id = ?").bind(email, k)
      : env.DB.prepare("INSERT OR REPLACE INTO eigene (email, id, daten, geaendert) VALUES (?, ?, ?, ?)").bind(email, k, s, t));
  }
  if (stmts.length > 10_000) throw new Fehler(400, "Zu viele Einträge auf einmal");
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return { ok: true, geschrieben: stmts.length };
}

// ---------------------------------------------------------------- Fotos
function speicher(env) {
  if (!env.MEDIEN) throw new Fehler(503, "Fotospeicher noch nicht eingerichtet");
  return env.MEDIEN;
}

async function medienListe(env, email, bezug) {
  if (!bezug) throw new Fehler(400, "bezug fehlt");
  const { results } = await env.DB.prepare(
    "SELECT id, bezug, typ, groesse, breite, hoehe, aufgenommen, lat, lng, notiz, erstellt FROM medien WHERE email = ? AND bezug = ? ORDER BY erstellt",
  ).bind(email, bezug).all();
  return results;
}

async function medienHochladen(env, email, request) {
  const r2 = speicher(env);
  const len = +request.headers.get("Content-Length") || 0;
  if (len > 2 * MAX_BILD) throw new Fehler(413, "Datei zu gross");
  let form;
  try { form = await request.formData(); } catch { throw new Fehler(400, "Ungültige Daten"); }
  const datei = form.get("datei"), klein = form.get("klein");
  const bezug = String(form.get("bezug") || "").slice(0, 300);
  if (!bezug || !datei || typeof datei === "string") throw new Fehler(400, "Datei oder bezug fehlt");
  if (!BILDTYPEN.includes(datei.type)) throw new Fehler(415, "Nur Bilder (JPEG, PNG, WebP, HEIC)");
  if (datei.size > MAX_BILD) throw new Fehler(413, "Bild grösser als 15 MB");
  const zahl = (k) => { const v = parseFloat(form.get(k)); return Number.isFinite(v) ? v : null; };
  const id = crypto.randomUUID();
  await r2.put(`medien/${id}`, datei.stream(), { httpMetadata: { contentType: datei.type } });
  if (klein && typeof klein !== "string" && BILDTYPEN.includes(klein.type) && klein.size < 2_000_000) {
    await r2.put(`medien/${id}-k`, klein.stream(), { httpMetadata: { contentType: klein.type } });
  }
  const eintrag = {
    id, bezug, typ: datei.type, groesse: datei.size, breite: zahl("breite"), hoehe: zahl("hoehe"),
    aufgenommen: String(form.get("aufgenommen") || "").slice(0, 40) || null, lat: zahl("lat"), lng: zahl("lng"),
    notiz: String(form.get("notiz") || "").slice(0, 2000), erstellt: jetzt(),
  };
  await env.DB.prepare(`INSERT INTO medien (id, email, bezug, typ, groesse, breite, hoehe, aufgenommen, lat, lng, notiz, erstellt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, email, eintrag.bezug, eintrag.typ, eintrag.groesse, eintrag.breite,
    eintrag.hoehe, eintrag.aufgenommen, eintrag.lat, eintrag.lng, eintrag.notiz, eintrag.erstellt).run();
  return eintrag;
}

async function eigenesMedium(env, email, id) {
  const m = await env.DB.prepare("SELECT id, typ FROM medien WHERE id = ? AND email = ?").bind(String(id || ""), email).first();
  if (!m) throw new Fehler(404, "Foto nicht gefunden");
  return m;
}

async function medienHolen(env, email, id, klein) {
  const r2 = speicher(env);
  const m = await eigenesMedium(env, email, id);
  const obj = (klein && await r2.get(`medien/${m.id}-k`)) || await r2.get(`medien/${m.id}`);
  if (!obj) throw new Fehler(404, "Datei fehlt im Speicher");
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType || m.typ, "Cache-Control": "private, max-age=31536000, immutable" },
  });
}

async function medienLoeschen(env, email, id) {
  const r2 = speicher(env);
  const m = await eigenesMedium(env, email, id);
  await r2.delete([`medien/${m.id}`, `medien/${m.id}-k`]);
  await env.DB.prepare("DELETE FROM medien WHERE id = ? AND email = ?").bind(m.id, email).run();
  return { ok: true };
}
