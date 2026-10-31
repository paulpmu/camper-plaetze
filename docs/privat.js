// Eigene Plätze, Favoriten, Notizen und Logbuch – gespeichert im privaten Repository (nur mit GitHub-Schlüssel).
window.PRIV = (() => {
  "use strict";

  const KEY_REPO = "gh-private-repo";
  const CACHE = "priv-cache";
  let data = { eigene: [], merk: {} };
  let sha = { eigene: null, merk: null };
  let ready = false;

  function repo() {
    try {
      const saved = localStorage.getItem(KEY_REPO);
      if (saved) return saved;
    } catch { /* privater Modus */ }
    const owner = GH.repo().split("/")[0];
    return owner ? `${owner}/camper-plaetze-privat` : "";
  }
  function setRepo(r) {
    try { r ? localStorage.setItem(KEY_REPO, r.trim()) : localStorage.removeItem(KEY_REPO); } catch { /* privater Modus */ }
  }
  const url = (file) => `https://api.github.com/repos/${repo()}/contents/${file}`;
  const FILES = { eigene: "eigene.json", merk: "merkliste.json" };

  const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
  const b64encode = (s) => { let bin = ""; new TextEncoder().encode(s).forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin); };

  function cache(write) {
    try {
      if (write) localStorage.setItem(CACHE, JSON.stringify(data));
      else data = { eigene: [], merk: {}, ...JSON.parse(localStorage.getItem(CACHE) || "{}") };
    } catch { /* privater Modus */ }
  }

  // Lädt beide Dateien; ohne Schlüssel oder offline bleibt der zuletzt gespeicherte Stand auf dem Gerät
  async function load() {
    cache(false);
    if (!GH.token() || !repo()) return { ok: false, reason: GH.token() ? "kein Repository" : "kein Schlüssel" };
    try {
      for (const [k, f] of Object.entries(FILES)) {
        try {
          const file = await GH.api(url(f) + "?ref=main");
          data[k] = JSON.parse(b64decode(file.content));
          sha[k] = file.sha;
        } catch (err) {
          if (!String(err.message).startsWith("404")) throw err;
          sha[k] = null;  // Datei existiert noch nicht
        }
      }
      ready = true;
      cache(true);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async function check() {
    const r = await GH.api(`https://api.github.com/repos/${repo()}`);
    if (!r.private) throw new Error("Repository ist nicht privat – bitte auf «Private» stellen");
    if (!r.permissions || !r.permissions.push) throw new Error("Schlüssel hat keine Schreibrechte für dieses Repository");
    return r.full_name;
  }

  async function save(k, message) {
    if (!GH.token()) throw new Error("GitHub-Schlüssel fehlt");
    const body = { message, content: b64encode(JSON.stringify(data[k], null, 1) + "\n") };
    if (sha[k]) body.sha = sha[k];
    try {
      const r = await GH.api(url(FILES[k]), { method: "PUT", body });
      sha[k] = r.content.sha;
    } catch (err) {
      if (String(err.message).startsWith("409") || String(err.message).startsWith("422")) {
        // Auf einem anderen Gerät geändert: neu laden und erneut versuchen
        const file = await GH.api(url(FILES[k]) + "?ref=main");
        sha[k] = file.sha;
        body.sha = file.sha;
        const r = await GH.api(url(FILES[k]), { method: "PUT", body });
        sha[k] = r.content.sha;
      } else throw err;
    }
    cache(true);
  }

  // ---------------------------------------------------------------- Merkliste
  const mkey = (zielId, placeId) => `${zielId}/${placeId}`;
  function merk(zielId, placeId) { return data.merk[mkey(zielId, placeId)] || {}; }
  async function setMerk(zielId, placeId, name, changes) {
    const k = mkey(zielId, placeId);
    const next = { ...(data.merk[k] || {}), ...changes, name };
    if (!next.fav && !next.visited && !next.note && !next.rating) delete data.merk[k];
    else data.merk[k] = next;
    await save("merk", `Merkliste: ${name}`);
  }

  // ---------------------------------------------------------------- Eigene Plätze
  function eigene(zielId) { return data.eigene.filter((e) => e.ziel === zielId); }
  async function saveEigen(entry) {
    const i = data.eigene.findIndex((e) => e.id === entry.id);
    if (i >= 0) data.eigene[i] = entry; else data.eigene.push(entry);
    await save("eigene", `Eigener Platz: ${entry.name}`);
  }
  async function deleteEigen(id) {
    const e = data.eigene.find((x) => x.id === id);
    data.eigene = data.eigene.filter((x) => x.id !== id);
    await save("eigene", `Eigener Platz gelöscht: ${e ? e.name : id}`);
  }

  return { repo, setRepo, load, check, merk, setMerk, eigene, saveEigen, deleteEigen, get ready() { return ready; }, get data() { return data; } };
})();
