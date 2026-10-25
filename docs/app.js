(() => {
  "use strict";

  const TYPE_LABEL = { wildplatz: "Wildplatz", camping: "Camping", stellplatz: "Stellplatz", andere: "Andere" };
  const INFRA_LABEL = { water: "💧 Wasser", dump_station: "🚽 Ver-/Entsorgung", electricity: "⚡ Strom", toilets: "🚻 WC", showers: "🚿 Dusche" };
  const PRECISION = {
    exakt: ["genaue Koordinaten", ""],
    genau: ["Platz verortet", ""],
    ort: ["ungefährer Standort (Ortsmitte)", "warn"],
    region: ["nur Region bekannt – nicht auf der Karte", "warn"],
  };
  const SCHEDULE = { taeglich: "täglich", woechentlich: "wöchentlich", manuell: "nur manuell" };
  const WEEKDAY = ["", "Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const DEFAULT_FILTER = { region: "", route: "", corridor: 30, sources: ["youtube", "osm"], types: ["wildplatz", "camping", "stellplatz", "andere"], rating: 0, age: 365, infra: [], no4wd: false, exact: false, safe: false, q: "" };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let index = { repo: "", ziele: [] };
  let ziel = null;          // aktuelles Ziel aus ziele.json
  let spots = [];
  let routes = [];
  let filter = load("filter", DEFAULT_FILTER);
  let me = null;
  let meMarker = null;
  let markers = new Map();
  const routeLayers = new Map();

  function load(key, def) {
    try { return { ...def, ...JSON.parse(localStorage.getItem(key)) }; } catch { return { ...def }; }
  }
  function loadStr(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, typeof val === "string" ? val : JSON.stringify(val)); } catch { /* privater Modus */ }
  }

  // ---------------------------------------------------------------- Karte
  const map = L.map("map", { zoomControl: false, tap: true }).setView([33, -6], 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a>',
  }).addTo(map);
  const routeGroup = L.layerGroup().addTo(map);
  const cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45, spiderfyOnMaxZoom: true });
  map.addLayer(cluster);

  const isOsm = (s) => s.source === "osm";
  function pinHtml(s) {
    if (isOsm(s)) return `<div class="pin osm"><b>P</b></div>`;
    return `<div class="pin ${s.type} ${s.precision === "ort" || s.precision === "region" ? "approx" : ""}"><b>${s.rating.toFixed(1).replace(".0", "")}</b></div>`;
  }
  function icon(s) {
    return L.divIcon({ className: "", html: pinHtml(s), iconSize: [30, 30], iconAnchor: [4, 30] });
  }

  // ---------------------------------------------------------------- Daten
  async function getJson(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }

  async function init() {
    try {
      index = await getJson("data/ziele.json");
      GH.setRepo(index.repo);
    } catch (e) {
      $("#count").textContent = "Daten nicht erreichbar (offline?)";
      return;
    }
    const [hz, hs] = decodeURIComponent(location.hash.slice(1)).split("/");
    const wanted = hz || loadStr("ziel");
    const z = index.ziele.find((x) => x.id === wanted) || index.ziele[0];
    renderZielList();
    if (z) await selectZiel(z.id, hs);
    else $("#count").textContent = "noch kein Ziel";
  }

  async function selectZiel(id, spotId) {
    const z = index.ziele.find((x) => x.id === id);
    if (!z) return;
    const changed = ziel && ziel.id !== id;
    ziel = z;
    save("ziel", id);
    $("#ziel-name").textContent = z.name;
    $("#count").textContent = "lädt …";
    if (changed) { filter.region = ""; filter.route = ""; }
    try {
      let osm;
      [spots, routes, osm] = await Promise.all([
        getJson(`data/${id}/spots.json`).catch(() => []),
        getJson(`data/${id}/routes.json`).then((r) => r.routes || []).catch(() => []),
        z.osm ? getJson(`data/${id}/osm.json`).catch(() => []) : [],
      ]);
      spots = spots.concat(osm);
    } catch { spots = []; routes = []; }
    if (filter.region && !z.regions.includes(filter.region)) filter.region = "";
    if (filter.route && !routes.some((r) => r.id === filter.route)) filter.route = "";

    markers = new Map();
    for (const s of spots) {
      if (s.lat == null) continue;
      const m = L.marker([s.lat, s.lng], { icon: icon(s), title: s.name });
      m.on("click", () => openDetail(s));
      markers.set(s.id, m);
    }
    $("#f-region").innerHTML = `<option value="">Alle Regionen</option>` + z.regions.map((r) => `<option>${esc(r)}</option>`).join("");
    $("#f-route").innerHTML = `<option value="">Keine Route</option>` + routes.map((r) => `<option value="${esc(r.id)}">${esc(r.name)} (${r.length_km} km)</option>`).join("");
    $("#route-filter").hidden = !routes.length;
    drawRoutes();
    syncFilterUI();
    renderZielList();
    $(".empty")?.remove();
    if (!spots.length) {
      document.body.insertAdjacentHTML("beforeend",
        `<div class="empty"><strong>Noch keine Plätze für ${esc(z.name)}</strong><p class="muted">${z.last_run ? "Der Abruf läuft. Neue Videos werden jede Nacht ausgewertet." : "Der erste Abruf steht noch aus. Er startet nachts automatisch oder kurz nach dem Anlegen des Ziels."}</p></div>`);
    }
    showMeta();
    render(false);
    const linked = spots.find((s) => s.id === spotId);
    if (linked) { map.setView([linked.lat, linked.lng], 13); openDetail(linked); }
    else fitView();
  }

  function fitView() {
    const visible = spots.filter(matches);
    const r = routes.find((x) => x.id === filter.route);
    const located = visible.filter((s) => s.lat != null);
    if (r) map.fitBounds(L.latLngBounds(r.coords), { padding: [40, 40] });
    else if (located.length) map.fitBounds(L.latLngBounds(located.map((s) => [s.lat, s.lng])), { padding: [40, 40], maxZoom: 12 });
    else if (ziel) { const [s, w, n, e] = ziel.bbox; map.fitBounds([[s, w], [n, e]]); }
  }

  function drawRoutes() {
    routeGroup.clearLayers();
    routeLayers.clear();
    for (const r of routes) {
      const active = filter.route === r.id;
      const line = L.polyline(r.coords, {
        color: r.color, weight: active ? 5 : 3, opacity: active ? 0.9 : 0.45, dashArray: active ? null : "6 8",
      }).bindTooltip(r.name, { sticky: true });
      line.on("click", () => { filter.route = r.id; syncFilterUI(); drawRoutes(); render(); fitView(); });
      routeGroup.addLayer(line);
      routeLayers.set(r.id, line);
    }
  }

  function showMeta() {
    if (!ziel || !ziel.last_run) { $("#meta").textContent = "Für dieses Ziel ist noch kein Abruf erfolgt."; return; }
    const d = new Date(ziel.last_run);
    $("#meta").textContent = `${ziel.name}: Stand ${d.toLocaleDateString("de-CH")} ${d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })} · ${ziel.spots} Plätze aus ${ziel.videos_total} ausgewerteten Videos` + (ziel.queue ? ` · ${ziel.queue} Videos in Warteschlange` : "");
  }

  function ageDays(s) { return (Date.now() - new Date(s.last_seen).getTime()) / 864e5; }
  function onRoute(s) { return filter.route ? (s.routes || {})[filter.route] : null; }

  function matches(s) {
    const f = filter;
    if (f.route) { const r = onRoute(s); if (!r || r[1] > f.corridor) return false; }
    if (f.region && s.region !== f.region) return false;
    if (!f.types.includes(s.type)) return false;
    if (!f.sources.includes(isOsm(s) ? "osm" : "youtube")) return false;
    if (f.rating && (s.rating == null || s.rating < f.rating)) return false;
    if (f.age && !isOsm(s) && ageDays(s) > f.age) return false;
    if (f.infra.some((k) => s.infrastructure[k] !== true)) return false;
    if (f.no4wd && s.four_wd === true) return false;
    if (f.exact && s.precision !== "exakt" && s.precision !== "genau") return false;
    if (f.safe && s.safety_rating != null && s.safety_rating < 3) return false;
    if (f.q) {
      const hay = [s.name, s.place, s.region, ...s.mentions.map((m) => m.channel + " " + m.title)].join(" ").toLowerCase();
      if (!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
  }

  function isDefault() {
    const { q, corridor, ...a } = filter; const { q: _q, corridor: _c, ...b } = DEFAULT_FILTER;
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function render() {
    const visible = spots.filter(matches);
    cluster.clearLayers();
    cluster.addLayers(visible.filter((s) => markers.has(s.id)).map((s) => markers.get(s.id)));
    $("#count").textContent = spots.length ? `${visible.length} von ${spots.length} Plätzen` : "keine Plätze";
    $("#filter-dot").hidden = isDefault();
    renderList(visible);
    save("filter", filter);
  }

  function distKm(s) {
    if (!me || s.lat == null) return null;
    const R = 6371, r = Math.PI / 180;
    const dLat = (s.lat - me[0]) * r, dLng = (s.lng - me[1]) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(me[0] * r) * Math.cos(s.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function renderList(visible) {
    const items = visible.filter((s) => s.lat != null).map((s) => ({ s, d: distKm(s), r: onRoute(s) }));
    const regionOnly = visible.filter((s) => s.lat == null);
    let label;
    if (filter.route) { items.sort((a, b) => a.r[0] - b.r[0]); label = "nach Streckenkilometer"; }
    else if (me) { items.sort((a, b) => a.d - b.d); label = "nach Entfernung"; }
    else { items.sort((a, b) => (b.s.rating ?? 0) - (a.s.rating ?? 0) || (b.s.last_seen || "").localeCompare(a.s.last_seen || "")); label = "nach Bewertung"; }
    $("#list-sort").textContent = label;
    $("#list").innerHTML = items.slice(0, 400).map(({ s, d, r }) => `
      <li data-id="${s.id}">
        ${pinHtml(s)}
        <div><div class="t">${esc(s.name)}</div><div class="s">${esc(TYPE_LABEL[s.type])} · ${esc(s.place)}</div></div>
        <div class="r">${r ? `km ${r[0]}<br>${r[1]} km abseits` : (d != null ? Math.round(d) + " km<br>" : "") + (isOsm(s) ? "OpenStreetMap" : fmtDate(s.last_seen))}</div>
      </li>`).join("") + (regionOnly.length ? `<li class="group muted">Nur Region bekannt (${regionOnly.length})</li>` + regionOnly.map((s) => `
      <li data-id="${s.id}">
        ${pinHtml(s)}
        <div><div class="t">${esc(s.name)}</div><div class="s">${esc(TYPE_LABEL[s.type])} · ${esc(s.region)}</div></div>
        <div class="r">${fmtDate(s.last_seen)}</div>
      </li>`).join("") : "") || `<li class="muted">Keine Plätze für diese Filter.</li>`;
  }

  // ---------------------------------------------------------------- Detail
  function stars(r) {
    const full = Math.round(r);
    return "★".repeat(full) + "☆".repeat(5 - full);
  }
  function fmtDate(d) {
    return new Date(d).toLocaleDateString("de-CH", { month: "short", year: "numeric" });
  }
  function fmtT(t) {
    const m = Math.floor(t / 60), s = String(t % 60).padStart(2, "0");
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  function openDetail(s) {
    const infra = Object.entries(INFRA_LABEL).map(([k, label]) => {
      const v = s.infrastructure[k];
      return `<span class="${v === true ? "" : v === false ? "no" : "unk"}">${label}${v == null ? " ?" : ""}</span>`;
    }).join("");
    const facts = [
      ["Zufahrt", [s.four_wd === true ? "Allrad nötig" : s.four_wd === false ? "ohne Allrad" : "", s.access_note].filter(Boolean).join(" – ")],
      ["Sicherheit", [s.safety_rating ? `${s.safety_rating}/5` : "", s.safety_note].filter(Boolean).join(" – ")],
      ["Polizei", s.police_contact === true ? "Kontakt erwähnt" : s.police_contact === false ? "kein Kontakt" : ""],
      ["Preis", s.price],
      ["Plätze", s.capacity],
      ["Geöffnet", s.opening_hours],
      ["Betreiber", s.operator],
      ["Beschreibung", s.description],
    ].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");

    const routeInfo = routes.filter((r) => (s.routes || {})[r.id]).map((r) => {
      const [km, off] = s.routes[r.id];
      return `<div class="route-info"><span class="route-swatch" style="background:${esc(r.color)}"></span>${esc(r.name)}: km ${km} von ${r.length_km}${off >= 1 ? `, ${off} km abseits` : ""}</div>`;
    }).join("");

    const ll = `${s.lat},${s.lng}`;
    const mentions = s.mentions.map((m) => {
      const url = `https://www.youtube.com/watch?v=${encodeURIComponent(m.video_id)}${m.t ? `&t=${m.t}s` : ""}`;
      return `<a class="mention" href="${url}" target="_blank" rel="noopener">
        <img loading="lazy" src="https://i.ytimg.com/vi/${encodeURIComponent(m.video_id)}/mqdefault.jpg" alt="">
        <div>
          <div class="mt">${esc(m.title)}</div>
          <div class="ms">${esc(m.channel)} · ${fmtDate(m.published)} · <span class="stars" style="font-size:12px">${stars(m.rating)}</span></div>
          ${m.quote ? `<q>${esc(m.quote)}</q>` : ""}
          <span class="play">▶ ${m.t ? "Ab " + fmtT(m.t) + " ansehen" : "Video ansehen"}</span>
        </div></a>`;
    }).join("");

    $("#detail").innerHTML = `
      <div class="d-head">
        <h3>${esc(s.name)}</h3>
        <div class="muted">${[s.place, s.region].filter(Boolean).map(esc).join(" · ")}</div>
      </div>
      <div class="badges">
        <span class="badge type ${s.type}">${TYPE_LABEL[s.type]}</span>
        ${isOsm(s) ? `<span class="badge">aus OpenStreetMap</span>` : `<span class="badge ${PRECISION[s.precision][1]}">${PRECISION[s.precision][0]}${s.coord_source ? " (" + esc(s.coord_source) + ")" : ""}</span>
        ${ageDays(s) > 365 ? `<span class="badge warn">Info älter als 1 Jahr</span>` : ""}`}
      </div>
      ${isOsm(s) ? "" : `<div class="stars">${stars(s.rating)}<small>${s.rating.toFixed(1)} · ${s.mentions.length} ${s.mentions.length === 1 ? "Video" : "Videos"} · zuletzt ${fmtDate(s.last_seen)}</small></div>`}
      ${s.recommendation ? `<div class="reco">${esc(s.recommendation)}</div>` : ""}
      ${routeInfo}
      <div class="infra">${infra}</div>
      ${facts ? `<dl class="facts">${facts}</dl>` : ""}
      ${s.lat == null ? "" : `<div class="links">
        <a class="btn" href="https://maps.apple.com/?daddr=${ll}&q=${encodeURIComponent(s.name)}" target="_blank" rel="noopener">Apple Karten</a>
        <a class="btn" href="https://www.google.com/maps/search/?api=1&query=${ll}" target="_blank" rel="noopener">Google Maps</a>
        <a class="btn ghost" href="https://park4night.com/en/search?lat=${s.lat}&lng=${s.lng}&z=14" target="_blank" rel="noopener">park4night</a>
        ${(ziel.links || []).map((l) => `<a class="btn ghost" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a>`).join("")}
        ${s.website ? `<a class="btn ghost" href="${esc(s.website)}" target="_blank" rel="noopener">Website</a>` : ""}
        ${isOsm(s) ? `<a class="btn ghost" href="https://www.openstreetmap.org/${esc(s.osm)}" target="_blank" rel="noopener">OpenStreetMap</a>` : ""}
        <button class="btn ghost" data-share>Teilen</button>
      </div>`}
      ${isOsm(s) ? `<p class="muted">Stellplatz aus OpenStreetMap. Angaben ohne Gewähr, Daten © OpenStreetMap-Mitwirkende (ODbL).</p>` : `<h4>Aus den Videos</h4>
      ${mentions}`}`;
    const share = $("#detail [data-share]");
    if (share) share.onclick = () => {
      const url = location.href.split("#")[0] + "#" + ziel.id + "/" + s.id;
      if (navigator.share) navigator.share({ title: s.name, url }).catch(() => {});
      else navigator.clipboard?.writeText(url);
    };
    history.replaceState(null, "", "#" + ziel.id + "/" + s.id);
    open("#sheet-detail");
  }

  // ---------------------------------------------------------------- Ziele & Anfragen
  function renderZielList() {
    const can = !!GH.token();
    $("#ziel-list").innerHTML = index.ziele.map((z) => `
      <li data-id="${esc(z.id)}" class="${ziel && z.id === ziel.id ? "on" : ""}">
        <div class="zrow" data-select>
          <span>${esc(z.name)}</span>
          <span class="r">${z.spots} Plätze${z.osm ? ` · ${z.osm} Stellplätze OSM` : ""}${z.routes.length ? ` · ${z.routes.length} Routen` : ""}<br>${z.last_run ? "Stand " + new Date(z.last_run).toLocaleDateString("de-CH") : "noch kein Abruf"}</span>
        </div>
        <div class="zctl">
          ${can ? `<select data-schedule aria-label="Zeitplan">
              ${Object.entries(SCHEDULE).map(([k, v]) => `<option value="${k}" ${z.schedule === k ? "selected" : ""}>${v}${k === "woechentlich" ? " (" + WEEKDAY[z.weekday || 1] + ")" : ""}</option>`).join("")}
            </select>
            <button class="btn small" data-run>Jetzt aktualisieren</button>`
          : `<span class="muted">Zeitplan: ${SCHEDULE[z.schedule] || "täglich"}${z.schedule === "woechentlich" ? " (" + WEEKDAY[z.weekday || 1] + ")" : ""}</span>`}
        </div>
      </li>`).join("") || `<li class="muted">Noch keine Ziele.</li>`;
  }
  $("#ziel-list").onclick = async (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const z = index.ziele.find((x) => x.id === li.dataset.id);
    if (e.target.closest("[data-select]")) { close(); selectZiel(z.id); return; }
    const run = e.target.closest("[data-run]");
    if (run) {
      run.disabled = true; run.textContent = "wird gestartet …";
      try { await GH.dispatch({ ziel: z.id }); toast(`Abruf für ${z.name} gestartet. Den Fortschritt sehen Sie unter i → Läufe.`); run.textContent = "gestartet ✓"; }
      catch (err) { toast("Start fehlgeschlagen: " + err.message); run.disabled = false; run.textContent = "Jetzt aktualisieren"; }
    }
  };
  $("#ziel-list").onchange = async (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const z = index.ziele.find((x) => x.id === li.dataset.id);
    if (e.target.matches("[data-schedule]")) {
      const schedule = e.target.value;
      e.target.disabled = true;
      try {
        await GH.updateZiel(z.id, { schedule }, `Zeitplan ${z.id}: ${schedule} (aus der Webapp)`);
        z.schedule = schedule;
        toast(`Zeitplan für ${z.name}: ${SCHEDULE[schedule]}. Gilt ab dem nächsten Lauf.`);
      } catch (err) { toast("Ändern fehlgeschlagen: " + err.message); e.target.value = z.schedule; }
      e.target.disabled = false;
    }
  };

  function toast(msg) {
    let t = $("#toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.className = "show";
    clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.className = ""), 4500);
  }
  window.toast = toast;

  function repo() { return GH.repo(); }

  $("#req-send").onclick = async () => {
    const text = $("#req-text").value.trim();
    if (!text) { $("#req-text").focus(); return; }
    if (!repo()) { alert("Repository unbekannt – die App muss über GitHub Pages laufen."); return; }
    const title = "[Ziel] " + text.split("\n")[0].slice(0, 70);
    const body = `${text}\n\n---\nGesendet aus der Webapp · aktuelles Ziel: ${ziel ? ziel.name + " (" + ziel.id + ")" : "–"}`;
    if (GH.token()) {
      $("#req-send").disabled = true;
      try {
        await GH.createIssue(title, body);
        toast("Anfrage gesendet. Die Antwort erscheint unten, meist nach 1–2 Minuten.");
        $("#req-text").value = ""; save("req-draft", "");
        setTimeout(loadRequests, 3000);
      } catch (err) { toast("Senden fehlgeschlagen: " + err.message); }
      $("#req-send").disabled = false;
      return;
    }
    const url = `https://github.com/${repo()}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener");
    $("#req-text").value = "";
    save("req-draft", "");
  };
  $("#req-text").oninput = (e) => save("req-draft", e.target.value);

  async function loadRequests() {
    if (!repo()) { $("#req-list").innerHTML = `<li class="muted">Erst über GitHub Pages verfügbar.</li>`; return; }
    try {
      const issues = (await GH.api(`/issues?state=all&per_page=30&sort=created`)).filter((i) => !i.pull_request && i.title.startsWith("[Ziel]")).slice(0, 6);
      $("#req-list").innerHTML = issues.map((i) => {
        const done = i.state === "closed";
        return `<li><a href="${esc(i.html_url)}" target="_blank" rel="noopener">
          <span class="st ${done ? "erledigt" : "offen"}">${done ? "erledigt" : i.comments ? "Rückfrage" : "in Arbeit"}</span>${esc(i.title.replace("[Ziel] ", ""))}</a>
          <div class="muted">${new Date(i.created_at).toLocaleString("de-CH", { dateStyle: "short", timeStyle: "short" })}${i.comments ? ` · ${i.comments} Antwort${i.comments > 1 ? "en" : ""}` : ""}</div></li>`;
      }).join("") || `<li class="muted">Noch keine Anfragen.</li>`;
    } catch {
      $("#req-list").innerHTML = `<li class="muted">Anfragen nicht abrufbar (offline oder GitHub-Limit).</li>`;
    }
  }

  // ---------------------------------------------------------------- Sheets
  let current = null;
  function open(id) {
    if (current && current !== id) $(current).hidden = true;
    current = id;
    $(id).hidden = false;
    $(id).scrollTop = 0;
    $("#backdrop").hidden = false;
  }
  function close() {
    if (current) $(current).hidden = true;
    if (current === "#sheet-detail" && ziel) history.replaceState(null, "", location.pathname + "#" + ziel.id);
    current = null;
    $("#backdrop").hidden = true;
  }
  $("#backdrop").onclick = close;
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = close));
  $("#btn-filter").onclick = () => open("#sheet-filter");
  $("#btn-list").onclick = () => open("#sheet-list");
  $("#btn-info").onclick = () => open("#sheet-info");
  $("#btn-ziel").onclick = () => {
    $("#req-text").value = loadStr("req-draft") || "";
    renderZielList();
    showTokenState();
    open("#sheet-ziel");
    loadRequests();
  };

  // ---------------------------------------------------------------- GitHub-Schlüssel
  async function showTokenState(verify = false) {
    const has = !!GH.token();
    $("#req-hint-direct").hidden = !has;
    $("#req-hint-link").hidden = has;
    $("#gh-token").value = "";
    $("#gh-token").placeholder = has ? "•••••••• (hinterlegt)" : "github_pat_…";
    if (!has) { $("#gh-status").textContent = "Kein Schlüssel hinterlegt. Mit Schlüssel können Sie Ziele direkt starten, Zeitpläne ändern und Anfragen ohne Umweg senden."; return; }
    $("#gh-status").textContent = verify ? "Prüfe …" : "Schlüssel hinterlegt.";
    if (!verify) return;
    try { $("#gh-status").textContent = `Verbunden als ${await GH.check()} – volle Steuerung aktiv.`; }
    catch (err) { $("#gh-status").textContent = "Schlüssel ungültig: " + err.message; }
  }
  $("#gh-save").onclick = async () => {
    const t = $("#gh-token").value.trim();
    if (t) GH.setToken(t);
    await showTokenState(true);
    renderZielList();
  };
  $("#gh-remove").onclick = () => { GH.setToken(""); showTokenState(); renderZielList(); };
  $("#list").onclick = (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const s = spots.find((x) => x.id === li.dataset.id);
    if (s.lat != null) map.setView([s.lat, s.lng], Math.max(map.getZoom(), 13));
    openDetail(s);
  };

  // Nach unten wischen schliesst ein Sheet
  document.querySelectorAll(".sheet").forEach((sh) => {
    let y0 = null;
    sh.addEventListener("touchstart", (e) => { y0 = sh.scrollTop <= 0 && e.target.tagName !== "TEXTAREA" ? e.touches[0].clientY : null; }, { passive: true });
    sh.addEventListener("touchend", (e) => { if (y0 != null && e.changedTouches[0].clientY - y0 > 90) close(); y0 = null; }, { passive: true });
  });

  // ---------------------------------------------------------------- Filter-UI
  function syncFilterUI() {
    $("#f-region").value = filter.region;
    $("#f-route").value = filter.route;
    $("#corridor-field").hidden = !filter.route;
    document.querySelectorAll("#f-corridor button").forEach((b) => b.classList.toggle("on", +b.dataset.v === filter.corridor));
    document.querySelectorAll("#f-type .chip").forEach((b) => b.classList.toggle("on", filter.types.includes(b.dataset.v)));
    document.querySelectorAll("#f-source .chip").forEach((b) => b.classList.toggle("on", filter.sources.includes(b.dataset.v)));
    document.querySelectorAll("#f-infra .chip").forEach((b) => b.classList.toggle("on", filter.infra.includes(b.dataset.v)));
    document.querySelectorAll("#f-rating button").forEach((b) => b.classList.toggle("on", +b.dataset.v === filter.rating));
    document.querySelectorAll("#f-age button").forEach((b) => b.classList.toggle("on", +b.dataset.v === filter.age));
    $("#f-no4wd").checked = filter.no4wd;
    $("#f-exact").checked = filter.exact;
    $("#f-safe").checked = filter.safe;
    $("#search").value = filter.q;
  }
  function toggleIn(arr, v) { return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]; }

  $("#f-route").onchange = (e) => { filter.route = e.target.value; syncFilterUI(); drawRoutes(); render(); fitView(); };
  $("#f-corridor").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; filter.corridor = +b.dataset.v; syncFilterUI(); render(); };
  $("#f-region").onchange = (e) => { filter.region = e.target.value; render(); fitView(); };
  $("#f-source").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; filter.sources = toggleIn(filter.sources, b.dataset.v); syncFilterUI(); render(); };
  $("#f-type").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; filter.types = toggleIn(filter.types, b.dataset.v); syncFilterUI(); render(); };
  $("#f-infra").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; filter.infra = toggleIn(filter.infra, b.dataset.v); syncFilterUI(); render(); };
  $("#f-rating").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; filter.rating = +b.dataset.v; syncFilterUI(); render(); };
  $("#f-age").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; filter.age = +b.dataset.v; syncFilterUI(); render(); };
  ["no4wd", "exact", "safe"].forEach((k) => ($(`#f-${k}`).onchange = (e) => { filter[k] = e.target.checked; render(); }));
  $("#search").oninput = (e) => { filter.q = e.target.value.trim(); render(); };
  $("#f-reset").onclick = () => { filter = structuredClone(DEFAULT_FILTER); syncFilterUI(); drawRoutes(); render(); fitView(); };

  // ---------------------------------------------------------------- Standort
  $("#btn-locate").onclick = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((p) => {
      me = [p.coords.latitude, p.coords.longitude];
      if (meMarker) meMarker.setLatLng(me);
      else meMarker = L.marker(me, { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [16, 16] }), interactive: false }).addTo(map);
      map.setView(me, Math.max(map.getZoom(), 10));
      render();
    }, () => alert("Standort nicht verfügbar. Bitte in den iPhone-Einstellungen Safari den Standortzugriff erlauben."), { enableHighAccuracy: true, timeout: 10000 });
  };

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  init();
})();
