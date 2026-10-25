// Direkte Steuerung über die GitHub-API mit einem persönlichen Schlüssel, der nur auf diesem Gerät gespeichert ist.
window.GH = (() => {
  "use strict";

  const KEY = "gh-token";
  let repoName = "";

  function token() {
    try { return localStorage.getItem(KEY) || ""; } catch { return ""; }
  }
  function setToken(t) {
    try { t ? localStorage.setItem(KEY, t.trim()) : localStorage.removeItem(KEY); } catch { /* privater Modus */ }
  }
  function setRepo(r) { if (r) repoName = r; }
  function repo() {
    if (repoName) return repoName;
    const owner = location.hostname.split(".")[0];
    const name = location.pathname.split("/").filter(Boolean)[0];
    return owner && name ? `${owner}/${name}` : "";
  }

  async function api(path, opts = {}) {
    const headers = { Accept: "application/vnd.github+json", ...(opts.headers || {}) };
    if (token()) headers.Authorization = `Bearer ${token()}`;
    if (opts.body && typeof opts.body !== "string") { opts.body = JSON.stringify(opts.body); headers["Content-Type"] = "application/json"; }
    const url = path.startsWith("http") ? path : `https://api.github.com/repos/${repo()}${path}`;
    const r = await fetch(url, { ...opts, headers, cache: "no-store" });
    if (!r.ok) {
      let msg = `${r.status}`;
      try { msg += " " + (await r.json()).message; } catch { /* leer */ }
      throw new Error(msg);
    }
    return r.status === 204 ? null : r.json();
  }

  // Prüft Schlüssel und Rechte; gibt den Benutzernamen zurück
  async function check() {
    const user = await api("https://api.github.com/user");
    const rep = await api("");
    if (!rep.permissions || !rep.permissions.push) throw new Error("Schlüssel hat keine Schreibrechte für dieses Repository");
    return user.login;
  }

  function dispatch(inputs) {
    return api("/actions/workflows/update.yml/dispatches", { method: "POST", body: { ref: "main", inputs } });
  }

  function createIssue(title, body) {
    return api("/issues", { method: "POST", body: { title, body } });
  }

  const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
  const b64encode = (s) => { let bin = ""; new TextEncoder().encode(s).forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin); };

  // Ändert Felder einer Zieldatei (ziele/<id>.json) direkt im Repository
  async function updateZiel(id, changes, message) {
    const path = `/contents/ziele/${encodeURIComponent(id)}.json`;
    const file = await api(`${path}?ref=main`);
    const cfg = JSON.parse(b64decode(file.content));
    Object.assign(cfg, changes);
    await api(path, {
      method: "PUT",
      body: { message, content: b64encode(JSON.stringify(cfg, null, 1) + "\n"), sha: file.sha, branch: "main" },
    });
  }

  return { token, setToken, setRepo, repo, api, check, dispatch, createIssue, updateZiel };
})();
