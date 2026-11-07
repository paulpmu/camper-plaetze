// Persönliche Daten: Favoriten, Notizen, Logbuch, eigene Plätze und Fotos – gespeichert in der Datenbank
// des Camper-Planers (Cloudflare D1/R2), pro angemeldeter Person. Offline bleiben Änderungen in einer
// Warteschlange auf dem Gerät und werden beim nächsten Netzempfang gesendet.
window.PRIV = (() => {
  "use strict";

  const CACHE = "priv-cache-v2";
  const QUEUE = "priv-warteschlange";
  let data = { eigene: [], merk: {} };
  let ich = null;        // { email, name, rolle, fotos }
  let status = "";       // Grund, falls der Server nicht erreichbar ist
  let ready = false;

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* privater Modus */ } },
  };

  class Offline extends Error {}

  async function api(path, opts = {}) {
    const init = { method: opts.method || "GET", credentials: "same-origin", cache: "no-store", headers: {} };
    if (opts.form) init.body = opts.form;
    else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers["Content-Type"] = "application/json"; }
    let r;
    // Netzfehler oder abgelaufene Anmeldung (Umleitung zu Cloudflare) erscheinen hier als TypeError
    try { r = await fetch("api/" + path, init); } catch { throw new Offline("offline"); }
    if (r.redirected || !(r.headers.get("Content-Type") || "").includes("json")) {
      throw new Error(r.status === 404 ? "404 Server-Teil nicht vorhanden" : `${r.status} Anmeldung abgelaufen – App neu laden`);
    }
    const out = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${out.fehler || ""}`.trim());
    return out;
  }

  // ---------------------------------------------------------------- Laden
  async function load() {
    data = { eigene: [], merk: {}, ...store.get(CACHE, {}) };
    ich = store.get("priv-ich", null);
    try {
      ich = await api("ich");
      store.set("priv-ich", ich);
      await flush();
      data = await api("daten");
      applyQueue();
      store.set(CACHE, data);
      ready = true;
      status = "";
      return { ok: true };
    } catch (err) {
      status = err instanceof Offline ? "offline – zuletzt geladener Stand" : err.message;
      return { ok: false, reason: status };
    }
  }

  // ---------------------------------------------------------------- Schreiben mit Warteschlange
  function merge(change) {
    for (const [k, v] of Object.entries(change.merk || {})) { if (v === null) delete data.merk[k]; else data.merk[k] = v; }
    for (const [id, v] of Object.entries(change.eigene || {})) {
      data.eigene = data.eigene.filter((e) => e.id !== id);
      if (v !== null) data.eigene.push(v);
    }
  }
  // Noch nicht gesendete Änderungen über einen frisch geladenen Stand legen
  function applyQueue() { store.get(QUEUE, []).forEach(merge); }

  async function write(change) {
    if (!can()) throw new Error(ich ? "Als Gast können Sie nur ansehen" : "Nicht angemeldet");
    merge(change);
    store.set(CACHE, data);
    const queue = store.get(QUEUE, []);
    if (queue.length) { queue.push(change); store.set(QUEUE, queue); flush(); return { offline: true }; }
    try {
      await api("daten", { method: "POST", body: change });
      return { offline: false };
    } catch (err) {
      if (!(err instanceof Offline)) throw err;
      store.set(QUEUE, [...store.get(QUEUE, []), change]);
      return { offline: true };
    }
  }

  let flushing = null;
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      let queue = store.get(QUEUE, []);
      while (queue.length) {
        try { await api("daten", { method: "POST", body: queue[0] }); }
        catch (err) {
          if (err instanceof Offline) break;
          console.warn("Änderung verworfen:", err.message, queue[0]); // vom Server abgelehnt, etwa ungültig
        }
        queue = store.get(QUEUE, []).slice(1);
        store.set(QUEUE, queue);
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }
  window.addEventListener("online", () => flush());
  const pending = () => store.get(QUEUE, []).length;

  // ---------------------------------------------------------------- Merkliste
  const mkey = (zielId, placeId) => `${zielId}/${placeId}`;
  function merk(zielId, placeId) { return data.merk[mkey(zielId, placeId)] || {}; }
  async function setMerk(zielId, placeId, name, changes) {
    const k = mkey(zielId, placeId);
    const next = { ...(data.merk[k] || {}), ...changes, name };
    const leer = !next.fav && !next.visited && !next.note && !next.rating;
    return write({ merk: { [k]: leer ? null : next } });
  }
  // Ganze Merkliste senden, etwa nach dem Ergänzen von Koordinaten
  async function saveMerk() { return write({ merk: { ...data.merk } }); }

  // ---------------------------------------------------------------- Eigene Plätze
  function eigene(zielId, bbox) {
    const inside = (e) => bbox && e.lat >= bbox[0] && e.lat <= bbox[2] && e.lng >= bbox[1] && e.lng <= bbox[3];
    return data.eigene.filter((e) => e.ziel === zielId || inside(e));
  }
  async function saveEigen(entry) { return write({ eigene: { [entry.id]: { ...entry } } }); }
  async function deleteEigen(id) { return write({ eigene: { [id]: null } }); }

  // ---------------------------------------------------------------- Fotos
  // Verkleinert ein Bild im Browser (spart Speicher und Datenvolumen unterwegs)
  async function verkleinern(file, max, qualitaet) {
    const bmp = await createImageBitmap(file);
    const f = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * f); c.height = Math.round(bmp.height * f);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", qualitaet));
    return { blob, breite: c.width, hoehe: c.height };
  }
  async function fotoHochladen(bezug, file, extra = {}) {
    if (!can()) throw new Error("Als Gast können Sie keine Fotos speichern");
    const gross = await verkleinern(file, 2048, 0.85);
    const klein = await verkleinern(file, 400, 0.75);
    const form = new FormData();
    form.append("datei", gross.blob, "foto.jpg");
    form.append("klein", klein.blob, "klein.jpg");
    form.append("bezug", bezug);
    form.append("breite", gross.breite);
    form.append("hoehe", gross.hoehe);
    if (file.lastModified) form.append("aufgenommen", new Date(file.lastModified).toISOString());
    for (const [k, v] of Object.entries(extra)) if (v != null) form.append(k, v);
    try { return await api("medien", { method: "POST", form }); }
    catch (err) { throw err instanceof Offline ? new Error("Offline – Fotos bitte später hochladen") : err; }
  }
  const fotos = (bezug) => api("medien?bezug=" + encodeURIComponent(bezug));
  const fotoLoeschen = (id) => api("medien/" + encodeURIComponent(id), { method: "DELETE" });
  const fotoUrl = (id, klein) => `api/medien/${encodeURIComponent(id)}${klein ? "?klein" : ""}`;

  // ---------------------------------------------------------------- Personen (Admin)
  const personen = () => api("personen");
  const personSetzen = (p) => api("personen", { method: "POST", body: p });
  const personEntfernen = (email) => api("personen/" + encodeURIComponent(email), { method: "DELETE" });

  // ---------------------------------------------------------------- Übernahme aus dem privaten GitHub-Repository
  // Liest eigene.json und merkliste.json aus <owner>/camper-plaetze-privat mit dem GitHub-Schlüssel
  async function ausGithubUebernehmen(repo) {
    const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
    const lies = async (f) => {
      try { return JSON.parse(b64decode((await GH.api(`https://api.github.com/repos/${repo}/contents/${f}?ref=main`)).content)); }
      catch (err) { if (String(err.message).startsWith("404")) return null; throw err; }
    };
    const merkAlt = (await lies("merkliste.json")) || {};
    const eigeneAlt = (await lies("eigene.json")) || [];
    const change = { merk: { ...merkAlt }, eigene: Object.fromEntries(eigeneAlt.filter((e) => e && e.id).map((e) => [e.id, e])) };
    await write(change);
    return { merk: Object.keys(change.merk).length, eigene: Object.keys(change.eigene).length };
  }

  function can() { return !!ich && (ich.rolle === "admin" || ich.rolle === "mitreisend"); }

  return {
    load, merk, setMerk, saveMerk, eigene, saveEigen, deleteEigen, can, flush, pending,
    fotoHochladen, fotos, fotoLoeschen, fotoUrl, personen, personSetzen, personEntfernen, ausGithubUebernehmen,
    get ready() { return ready; }, get data() { return data; }, get ich() { return ich; }, get status() { return status; },
    get admin() { return !!ich && ich.rolle === "admin"; },
  };
})();
