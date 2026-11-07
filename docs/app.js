(() => {
  "use strict";

  const TYPE_LABEL = { wildplatz: "Wildplatz", camping: "Camping", stellplatz: "Stellplatz", entsorgung: "Entsorgung", andere: "Andere" };
  const INFRA_LABEL = { water: "💧 Wasser", dump_station: "🚽 Ver-/Entsorgung", electricity: "⚡ Strom", toilets: "🚻 WC", showers: "🚿 Dusche" };
  const PRECISION = {
    exakt: ["genaue Koordinaten", ""],
    genau: ["Platz verortet", ""],
    ort: ["ungefährer Standort (Ortsmitte)", "warn"],
    region: ["nur Region bekannt – nicht auf der Karte", "warn"],
  };
  const SOURCES = {
    youtube: ["YouTube-Videos", "Overlander-Videos, ausgewertet von Claude", "ca. 1–4 USD/Monat"],
    osm_stellplatz: ["OSM Stellplätze", "Wohnmobil-Stellplätze aus OpenStreetMap", "gratis"],
    osm_camping: ["OSM Campingplätze", "Campingplätze aus OpenStreetMap (ohne reine Zeltplätze)", "gratis"],
    osm_entsorgung: ["OSM Entsorgung", "Ver- und Entsorgungsstationen aus OpenStreetMap", "gratis"],
    web: ["Reiseberichte", "Blogs und Foren, wöchentlich per Websuche gefunden und von Claude ausgewertet", "ca. 0.50–1 USD/Monat"],
    opendata: ["Offene Datensätze", "amtliche oder freie Stellplatzlisten (CSV/GeoJSON)", "gratis"],
    eigene: ["Eigene Plätze", "von Ihnen erfasst", "gratis"],
  };
  const DIRECTORY = ["osm_stellplatz", "osm_camping", "osm_entsorgung", "opendata"];
  const SCHEDULE = { taeglich: "täglich", woechentlich: "wöchentlich", manuell: "nur manuell" };
  const WEEKDAY = ["", "Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const DEFAULT_FILTER = {
    regions: [], route: "", corridor: 30, hideSources: [], hideTypes: [], rating: 0, age: 365, infra: [],
    no4wd: false, exact: false, safe: false, conf: "", onlyFav: false, q: "",
  };
  const DEFAULT_LAYERS = { eigene: true, fav: true, visited: false };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let index = { repo: "", ziele: [] };
  let active = [];          // gewählte Ziele (Objekte aus ziele.json); das erste ist das Hauptziel
  let ziel = null;          // Hauptziel (für Hash, neue eigene Plätze, Anfragen)
  let places = [];          // alle Plätze der gewählten Ziele + Ebene «Meine Plätze»
  let routes = [];
  const loaded = {};        // Ziel-ID → { places, routes }
  let filter = load("filter", DEFAULT_FILTER);
  let layers = load("layers", DEFAULT_LAYERS);
  let listMode = "alle";    // alle | favoriten | logbuch
  let me = null;
  let meMarker = null;
  let markers = new Map();

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

  const isOwn = (s) => s.sources.includes("eigene");
  const isDirectoryOnly = (s) => !s.mentions.length && !isOwn(s);
  const merkZiel = (s) => (s.own ? s.own.ziel : s.zid);
  const merk = (s) => PRIV.merk(merkZiel(s), s.id);
  const zielById = (id) => index.ziele.find((z) => z.id === id);
  const routeKey = (r) => `${r.zid}/${r.id}`;

  function pinHtml(s) {
    const m = merk(s);
    const marks = (m.fav ? `<i class="mk fav">★</i>` : "") + (m.visited ? `<i class="mk vis">✓</i>` : "");
    let cls, label;
    if (isOwn(s)) { cls = "own"; label = "♦"; }
    else if (isDirectoryOnly(s)) { cls = `dir ${s.type}`; label = { stellplatz: "P", camping: "C", entsorgung: "E" }[s.type] || "•"; }
    else { cls = `${s.type} ${s.precision === "ort" || s.precision === "region" ? "approx" : ""}`; label = s.rating.toFixed(1).replace(".0", ""); }
    return `<div class="pin ${cls} ${s.confirmed ? "confirmed" : ""}"><b>${label}</b>${marks}</div>`;
  }
  function icon(s) {
    return L.divIcon({ className: "", html: pinHtml(s), iconSize: [30, 30], iconAnchor: [4, 30] });
  }

  // ---------------------------------------------------------------- Routen (Kilometer ab Start, Abstand)
  function locateOnRoute(lat, lng, coords) {
    let best = [Infinity, 0], along = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const [alat, alng] = coords[i], [blat, blng] = coords[i + 1];
      const kx = 111.32 * Math.cos(((alat + blat) / 2) * Math.PI / 180);
      const ax = alng * kx, ay = alat * 110.57, bx = blng * kx, by = blat * 110.57, px = lng * kx, py = lat * 110.57;
      const dx = bx - ax, dy = by - ay, seg = Math.hypot(dx, dy);
      const t = seg ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / seg ** 2)) : 0;
      const off = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (off < best[0]) best = [off, along + t * seg];
      along += seg;
    }
    return [Math.round(best[1]), Math.round(best[0] * 10) / 10];
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
    await PRIV.load();
    const [hz, hs] = decodeURIComponent(location.hash.slice(1)).split("/");
    let ids = (() => { try { return JSON.parse(localStorage.getItem("ziele-aktiv") || "null"); } catch { return null; } })()
      || [loadStr("ziel")].filter(Boolean);
    ids = ids.filter((id) => zielById(id));
    if (hz && zielById(hz) && !ids.includes(hz)) ids = [hz];
    if (!ids.length && index.ziele.length) ids = [index.ziele[0].id];
    renderZielList();
    if (ids.length) await setActive(ids, hs ? `${hz}/${hs}` : null);
    else $("#count").textContent = "noch kein Ziel";
  }

  function routesFor(p) {
    const out = {};
    for (const r of routes) { const [km, off] = locateOnRoute(p.lat, p.lng, r.coords); if (off <= 50) out[routeKey(r)] = [km, off]; }
    return out;
  }

  // Ebene «Meine Plätze»: eigene Plätze aller Ziele
  function ownPlaces() {
    if (!layers.eigene) return [];
    return PRIV.data.eigene.map((e) => {
      const p = {
        id: e.id, zid: e.ziel, key: `eigene/${e.id}`, name: e.name, place: e.place || "", region: "", lat: e.lat, lng: e.lng,
        precision: "exakt", type: e.type || "stellplatz", sources: ["eigene"], mentions: [], rating: e.rating || null,
        infrastructure: { water: null, dump_station: null, electricity: null, toilets: null, showers: null, ...(e.infrastructure || {}) },
        price: e.price || "", description: e.note || "", website: e.link || "", own: e, score: 100, confidence: "hoch", layer: true,
      };
      p.ownRoutes = routesFor(p);
      return p;
    });
  }

  // Ebene «Meine Plätze»: Favoriten und besuchte Plätze aus Zielen, die gerade nicht gewählt sind
  function merkPlaces() {
    const shown = new Set(places.map((p) => `${merkZiel(p)}/${p.id}`));
    const out = [];
    for (const [k, m] of Object.entries(PRIV.data.merk)) {
      const [zid, id] = [k.slice(0, k.indexOf("/")), k.slice(k.indexOf("/") + 1)];
      if (shown.has(k) || m.lat == null || id.startsWith("e-")) continue;
      if (!((layers.fav && m.fav) || (layers.visited && m.visited))) continue;
      const p = {
        id, zid, key: `merk/${k}`, name: m.name || "Platz", place: "", region: "", lat: m.lat, lng: m.lng, precision: "exakt",
        type: m.type || "andere", sources: ["merkliste"], mentions: [], rating: m.rating || null,
        infrastructure: { water: null, dump_station: null, electricity: null, toilets: null, showers: null },
        merkOnly: true, layer: true, confidence: "", score: null,
      };
      p.ownRoutes = routesFor(p);
      out.push(p);
    }
    return out;
  }

  // Ältere Datenstände ohne places.json: Quellen selbst zusammensetzen
  function legacyPlaces(spots, osm) {
    spots.forEach((s) => (s.sources = s.sources || ["youtube"]));
    osm.forEach((s) => { s.sources = [s.source === "osm" || !s.source ? "osm_stellplatz" : s.source]; s.mentions = []; });
    return spots.concat(osm);
  }

  async function loadZiel(id) {
    if (loaded[id]) return loaded[id];
    const [data, rts] = await Promise.all([
      getJson(`data/${id}/places.json`).catch(async () => legacyPlaces(
        await getJson(`data/${id}/spots.json`).catch(() => []), await getJson(`data/${id}/osm.json`).catch(() => []))),
      getJson(`data/${id}/routes.json`).then((r) => r.routes || []).catch(() => []),
    ]);
    data.forEach((p) => { p.zid = id; p.key = `${id}/${p.id}`; });
    rts.forEach((r) => (r.zid = id));
    loaded[id] = { places: data, routes: rts };
    backfillMerk(id, data);
    return loaded[id];
  }

  // Ältere Merklisten-Einträge ohne Koordinaten ergänzen (für die Ebene «Meine Plätze»)
  let backfillTimer = null;
  function backfillMerk(zid, data) {
    let changed = false;
    for (const [k, m] of Object.entries(PRIV.data.merk)) {
      if (!k.startsWith(zid + "/") || m.lat != null) continue;
      const p = data.find((x) => x.id === k.slice(zid.length + 1));
      if (p && p.lat != null) { m.lat = p.lat; m.lng = p.lng; m.type = p.type; changed = true; }
    }
    if (changed && GH.token()) { clearTimeout(backfillTimer); backfillTimer = setTimeout(() => PRIV.saveMerk("Merkliste: Koordinaten ergänzt").catch(() => {}), 3000); }
  }

  // Gewählte Ziele laden und anzeigen
  async function setActive(ids, openKey) {
    active = ids.map(zielById).filter(Boolean);
    ziel = active[0] || null;
    try { localStorage.setItem("ziele-aktiv", JSON.stringify(ids)); } catch { /* privater Modus */ }
    if (ziel) save("ziel", ziel.id);
    $("#ziel-name").textContent = active.length > 1 ? `${active[0].name} + ${active.length - 1}` : (ziel ? ziel.name : "Camper-Plätze");
    $("#count").textContent = "lädt …";
    const sets = await Promise.all(active.map((z) => loadZiel(z.id)));
    routes = sets.flatMap((x) => x.routes);
    places = sets.flatMap((x) => x.places);
    places = places.concat(ownPlaces());
    places = places.concat(merkPlaces());
    const regionKeys = new Set(active.flatMap((z) => z.regions.map((r) => `${z.id}|${r}`)));
    filter.regions = filter.regions.filter((r) => regionKeys.has(r));
    if (filter.route && !routes.some((r) => routeKey(r) === filter.route)) filter.route = "";
    rebuildMarkers();
    renderRegionChips();
    $("#f-route").innerHTML = `<option value="">Keine Route</option>` + routes.map((r) => `<option value="${esc(routeKey(r))}">${active.length > 1 ? esc(zielById(r.zid).name) + ": " : ""}${esc(r.name)} (${r.length_km} km)</option>`).join("");
    $("#route-filter").hidden = !routes.length;
    renderSourceChips();
    drawRoutes();
    syncFilterUI();
    renderZielList();
    $(".empty")?.remove();
    if (!places.length) {
      document.body.insertAdjacentHTML("beforeend",
        `<div class="empty"><strong>Noch keine Plätze</strong><p class="muted">Prüfen Sie die gewählten Ziele und deren Quellen (Zielname antippen).</p></div>`);
    }
    showMeta();
    render();
    const linked = openKey && places.find((s) => s.key === openKey);
    if (linked) { if (linked.lat != null) map.setView([linked.lat, linked.lng], 13); openDetail(linked); }
    else fitView();
  }
  const selectZiel = (id, spotId) => setActive([id], spotId ? `${id}/${spotId}` : null);

  // Nur die Ebene «Meine Plätze» neu aufbauen (nach Schalter oder Änderung)
  function rebuildLayer() {
    places = places.filter((p) => !p.layer);
    places = places.concat(ownPlaces());
    places = places.concat(merkPlaces());
    rebuildMarkers();
    renderSourceChips();
    syncFilterUI();
    render();
  }

  function rebuildMarkers() {
    markers = new Map();
    for (const s of places) {
      if (s.lat == null) continue;
      const m = L.marker([s.lat, s.lng], { icon: icon(s), title: s.name });
      m.on("click", () => openDetail(s));
      markers.set(s.key, m);
    }
  }
  function refreshMarker(s) {
    const m = markers.get(s.key);
    if (m) m.setIcon(icon(s));
  }

  function fitView() {
    const located = places.filter((s) => !s.layer && matches(s) && s.lat != null);
    const r = routes.find((x) => routeKey(x) === filter.route);
    if (r) map.fitBounds(L.latLngBounds(r.coords), { padding: [40, 40] });
    else if (located.length) map.fitBounds(L.latLngBounds(located.map((s) => [s.lat, s.lng])), { padding: [40, 40], maxZoom: 12 });
    else if (active.length) map.fitBounds(L.latLngBounds(active.flatMap((z) => [[z.bbox[0], z.bbox[1]], [z.bbox[2], z.bbox[3]]])));
  }

  function drawRoutes() {
    routeGroup.clearLayers();
    for (const r of routes) {
      const on = filter.route === routeKey(r);
      const line = L.polyline(r.coords, {
        color: r.color, weight: on ? 5 : 3, opacity: on ? 0.9 : 0.45, dashArray: on ? null : "6 8",
      }).bindTooltip(r.name, { sticky: true });
      line.on("click", () => { filter.route = routeKey(r); syncFilterUI(); drawRoutes(); render(); fitView(); });
      routeGroup.addLayer(line);
    }
  }

  function showMeta() {
    $("#meta").innerHTML = active.map((z) => {
      if (!z.last_run) return `${esc(z.name)}: noch kein Abruf.`;
      const d = new Date(z.last_run), c = z.counts || {};
      const parts = Object.keys(SOURCES).filter((k) => c[k]).map((k) => `${SOURCES[k][0]} ${c[k]}`);
      return `${esc(z.name)}: Stand ${d.toLocaleDateString("de-CH")} · ${c.total || z.spots} Plätze` + (parts.length ? ` (${esc(parts.join(", "))})` : "") +
        (c.confirmed ? ` · ${c.confirmed} bestätigt` : "");
    }).join("<br>");
  }

  // ---------------------------------------------------------------- Filter
  const ageDays = (s) => (s.last_seen ? (Date.now() - new Date(s.last_seen).getTime()) / 864e5 : null);
  function routeVal(s, r) {
    if (s.ownRoutes) return s.ownRoutes[routeKey(r)] || null;
    return s.zid === r.zid ? (s.routes || {})[r.id] || null : null;
  }
  function onRoute(s) {
    if (!filter.route) return null;
    const r = routes.find((x) => routeKey(x) === filter.route);
    return r ? routeVal(s, r) : null;
  }
  // Ebene «Meine Plätze»: eigene sowie (je nach Schalter) Favoriten und besuchte Plätze immer zeigen
  function inLayer(s) {
    if (isOwn(s)) return layers.eigene;
    const m = merk(s);
    return (layers.fav && m.fav) || (layers.visited && m.visited);
  }

  function matches(s) {
    const f = filter;
    if (isOwn(s) && !layers.eigene) return false;
    if (inLayer(s) && !f.route && !f.q) return true;
    if (s.merkOnly) return false;
    if (f.route) { const r = onRoute(s); if (!r || r[1] > f.corridor) return false; }
    if (f.regions.length && !isOwn(s) && !f.regions.includes(`${s.zid}|${s.region}`)) return false;
    if (f.hideTypes.includes(s.type)) return false;
    if (s.sources.every((x) => f.hideSources.includes(x))) return false;
    if (f.rating && (s.rating == null || s.rating < f.rating)) return false;
    const age = ageDays(s);
    if (f.age && age != null && !isOwn(s) && age > f.age && !s.sources.some((x) => DIRECTORY.includes(x))) return false;
    if (f.infra.some((k) => s.infrastructure[k] !== true)) return false;
    if (f.no4wd && s.four_wd === true) return false;
    if (f.exact && s.precision !== "exakt" && s.precision !== "genau") return false;
    if (f.safe && s.safety_rating != null && s.safety_rating < 3) return false;
    if (f.conf === "mittel" && s.confidence === "tief") return false;
    if (f.conf === "hoch" && s.confidence !== "hoch") return false;
    if (f.onlyFav && !merk(s).fav) return false;
    if (f.q) {
      const hay = [s.name, s.place, s.region, s.operator, ...s.mentions.map((m) => `${m.channel || m.site || ""} ${m.title}`)].join(" ").toLowerCase();
      if (!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
  }

  function isDefault() {
    const { q, corridor, ...a } = filter; const { q: _q, corridor: _c, ...b } = DEFAULT_FILTER;
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function render() {
    const visible = places.filter(matches);
    cluster.clearLayers();
    cluster.addLayers(visible.filter((s) => markers.has(s.key)).map((s) => markers.get(s.key)));
    $("#count").textContent = places.length ? `${visible.length} von ${places.length} Plätzen` : "keine Plätze";
    save("layers", layers);
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

  // ---------------------------------------------------------------- Liste, Favoriten, Logbuch
  function listItem(s, right) {
    const zname = !isOwn(s) && (active.length > 1 || s.layer) ? (zielById(s.zid) || {}).name : "";
    return `<li data-id="${esc(s.key)}">${pinHtml(s)}
        <div><div class="t">${esc(s.name)}</div><div class="s">${esc(TYPE_LABEL[s.type] || s.type)}${s.place || s.region ? " · " + esc(s.place || s.region) : ""}${zname ? " · " + esc(zname) : ""}</div></div>
        <div class="r">${right}</div></li>`;
  }

  function renderList(visible) {
    $("#etappen").hidden = !filter.route || listMode !== "alle";
    if (listMode === "logbuch") {
      const visited = allMerkPlaces().filter((s) => merk(s).visited).sort((a, b) => merk(b).visited.localeCompare(merk(a).visited));
      $("#list-sort").textContent = "besucht, neueste zuerst";
      $("#list").innerHTML = visited.map((s) => listItem(s, `${new Date(merk(s).visited).toLocaleDateString("de-CH")}${merk(s).note ? `<br><span class="note">${esc(merk(s).note.slice(0, 40))}</span>` : ""}`)).join("")
        || `<li class="muted">Noch keine besuchten Plätze. Im Platz auf «✓ Besucht» tippen.</li>`;
      return;
    }
    const base = listMode === "favoriten" ? allMerkPlaces().filter((s) => merk(s).fav) : visible;
    const items = base.filter((s) => s.lat != null).map((s) => ({ s, d: distKm(s), r: onRoute(s) }));
    const regionOnly = base.filter((s) => s.lat == null);
    let label;
    if (filter.route) { items.sort((a, b) => (a.r ? a.r[0] : 1e9) - (b.r ? b.r[0] : 1e9)); label = "nach Streckenkilometer"; }
    else if (me) { items.sort((a, b) => a.d - b.d); label = "nach Entfernung"; }
    else { items.sort((a, b) => (b.s.score ?? 0) - (a.s.score ?? 0) || (b.s.rating ?? 0) - (a.s.rating ?? 0)); label = "nach Verlässlichkeit"; }
    $("#list-sort").textContent = label;
    const right = ({ s, d, r }) => r ? `km ${r[0]}<br>${r[1]} km abseits`
      : (d != null ? Math.round(d) + " km<br>" : "") + (isOwn(s) ? "eigener Platz" : s.last_seen ? fmtDate(s.last_seen) : (SOURCES[s.sources[0]] || [""])[0]);
    $("#list").innerHTML = items.slice(0, 500).map((it) => listItem(it.s, right(it))).join("")
      + (regionOnly.length ? `<li class="group muted">Nur Region bekannt (${regionOnly.length})</li>` + regionOnly.map((s) => listItem(s, s.last_seen ? fmtDate(s.last_seen) : "")).join("") : "")
      || `<li class="muted">${listMode === "favoriten" ? "Noch keine Favoriten. Im Platz auf «★ Favorit» tippen." : "Keine Plätze für diese Filter."}</li>`;
  }
  // Für Favoriten und Logbuch: alle gemerkten Plätze, auch aus nicht gewählten Zielen
  function allMerkPlaces() {
    const out = places.slice();
    const have = new Set(out.map((p) => `${merkZiel(p)}/${p.id}`));
    for (const [k, m] of Object.entries(PRIV.data.merk)) {
      if (have.has(k) || k.includes("/e-")) continue;
      const i = k.indexOf("/");
      out.push({ id: k.slice(i + 1), zid: k.slice(0, i), key: `merk/${k}`, name: m.name || "Platz", place: "", region: "", lat: m.lat ?? null, lng: m.lng ?? null,
        precision: "exakt", type: m.type || "andere", sources: ["merkliste"], mentions: [], rating: m.rating || null,
        infrastructure: {}, merkOnly: true, layer: true, confidence: "", score: null });
    }
    return out;
  }
  $("#list-mode").onclick = (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b) return;
    listMode = b.dataset.mode;
    document.querySelectorAll("#list-mode button").forEach((x) => x.classList.toggle("on", x === b));
    render();
  };

  // ---------------------------------------------------------------- Etappenplaner
  $("#et-plan").onclick = () => {
    const r = routes.find((x) => routeKey(x) === filter.route);
    if (!r) return;
    const min = +$("#et-min").value || 150, max = Math.max(min + 10, +$("#et-max").value || 250);
    let pos = 0;
    if ($("#et-start").value === "standort" && me) pos = locateOnRoute(me[0], me[1], r.coords)[0];
    const cands = places.filter((s) => matches(s) && s.type !== "entsorgung" && onRoute(s) && onRoute(s)[1] <= filter.corridor).map((s) => ({ s, km: onRoute(s)[0] }));
    const stages = [];
    while (stages.length < 20) {
      // Zuerst im gewünschten Bereich, dann etwas längere, erst zuletzt kürzere Etappen
      const windows = [[min, max], [min, max * 1.4], [min * 0.5, min]];
      let pool = [];
      for (const [lo, hi] of windows) {
        pool = cands.filter((c) => c.km >= pos + lo && c.km <= pos + hi);
        if (pool.length) break;
      }
      if (!pool.length) break;
      const fav = pool.filter((c) => merk(c.s).fav);
      const best = (fav.length ? fav : pool).sort((a, b) => (b.s.score ?? 0) - (a.s.score ?? 0) || (b.s.rating ?? 0) - (a.s.rating ?? 0))[0];
      stages.push({ ...best, from: pos });
      pos = best.km;
      if (r.length_km - pos < min * 0.5) break;
    }
    $("#et-result").innerHTML = stages.length
      ? `<ol class="stages">${stages.map((st, i) => `<li data-id="${esc(st.s.key)}"><b>Etappe ${i + 1}</b> · ${st.km - st.from} km → km ${st.km}<br>${esc(st.s.name)} <span class="muted">(${esc(TYPE_LABEL[st.s.type])}, Verlässlichkeit ${esc(st.s.confidence || "–")})</span><div class="wx-et" data-i="${i}"></div></li>`).join("")}</ol>
         <p class="muted">Restliche Strecke bis Ziel: ${Math.max(0, r.length_km - pos)} km. Favoriten werden bevorzugt, sonst die verlässlichsten Plätze.</p>`
      : `<p class="muted">Keine passenden Plätze in diesem Abstand. Filter lockern oder Etappenlänge ändern.</p>`;
    if (stages.length && window.WETTER) etappenWetter(stages);
  };

  { const d = new Date(); $("#et-date").value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

  // Wetter am Ankunftstag jeder Etappe (Etappe 1 = Abfahrtstag); Prognose reicht 8 Tage
  async function etappenWetter(stages) {
    const start = $("#et-date").value ? new Date($("#et-date").value + "T12:00:00") : new Date();
    const datum = (i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d.toISOString().slice(0, 10); };
    const boxes = document.querySelectorAll("#et-result .wx-et");
    boxes.forEach((b) => (b.innerHTML = `<span class="muted">Wetter lädt …</span>`));
    try {
      const res = await WETTER.viele(stages.map((st) => [st.s.lat, st.s.lng]));
      let schlecht = 0;
      boxes.forEach((b, i) => {
        const d = datum(i), t = res[i].find((x) => x.datum === d);
        if (!t) { b.innerHTML = `<span class="muted">${WETTER.tagLabel(d)}: noch keine Prognose</span>`; return; }
        if (t.note < 4) schlecht++;
        b.innerHTML = `${WETTER.chip(t.note)} <span class="muted">${WETTER.tagLabel(d)} · ${WETTER.fmt(t.sonne)} h Sonne · ${WETTER.fmt(t.regen, 1)} mm</span>` +
          (t.note < 4 ? ` <span class="warntext">Schlechtwetter – Ruhetag, Therme oder Stadt einplanen</span>` : "");
      });
      if (schlecht) $("#et-result").insertAdjacentHTML("beforeend", `<p class="muted">Tipp: Etappenlänge anpassen oder Abfahrt verschieben, damit Wander- und Velotage auf gute Tage fallen.</p>`);
    } catch (e) {
      boxes.forEach((b) => (b.innerHTML = `<span class="muted">Wetter nicht verfügbar</span>`));
    }
  }
  $("#et-result").onclick = (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) openPlace(li.dataset.id);
  };

  // ---------------------------------------------------------------- Wetter: Karte und Regionen-Rangliste
  const wxGroup = L.layerGroup().addTo(map);
  let wxGrid = null, wxTag = 0, wxDaten = [];
  function wxTage() {
    const quelle = wxGrid ? wxGrid.zellen[0]?.tage : wxDaten;
    const tage = (quelle || []).map((t) => t.datum);
    if (!tage.length) { const d = new Date(); for (let i = 0; i < 8; i++) { const x = new Date(d); x.setDate(d.getDate() + i); tage.push(x.toISOString().slice(0, 10)); } }
    $("#wx-days").innerHTML = tage.map((d, i) => `<button data-i="${i}" class="${i === wxTag ? "on" : ""}">${WETTER.tagLabel(d)}</button>`).join("");
    return tage;
  }
  function wxZeichnen() {
    wxGroup.clearLayers();
    if (!wxGrid) return;
    const tage = wxTage(), datum = tage[wxTag];
    for (const z of wxGrid.zellen) {
      const t = z.tage.find((x) => x.datum === datum);
      if (!t) continue;
      L.rectangle([[z.lat - z.dlat / 2, z.lng - z.dlng / 2], [z.lat + z.dlat / 2, z.lng + z.dlng / 2]], {
        stroke: false, fillColor: WETTER.farbe(t.note), fillOpacity: 0.38, interactive: true,
      }).bindTooltip(`${WETTER.tagLabel(datum)}: Note ${t.note.toFixed(1)} · ${WETTER.fmt(t.sonne)} h Sonne · ${WETTER.fmt(t.regen, 1)} mm`).addTo(wxGroup);
    }
    $("#wx-karte").textContent = "Wetterkarte ausblenden";
  }
  async function wxKarteLaden() {
    const b = map.getBounds(), n = 7;
    const dlat = (b.getNorth() - b.getSouth()) / n, dlng = (b.getEast() - b.getWest()) / n;
    const zellen = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) zellen.push({ lat: b.getSouth() + (i + 0.5) * dlat, lng: b.getWest() + (j + 0.5) * dlng, dlat, dlng });
    $("#wx-karte").disabled = true; $("#wx-karte").textContent = "lädt …";
    try {
      const res = await WETTER.viele(zellen.map((z) => [z.lat, z.lng]));
      zellen.forEach((z, i) => (z.tage = res[i]));
      wxGrid = { zellen };
      wxZeichnen();
      close();
    } catch (e) { toast("Wetterkarte nicht verfügbar: " + e.message); $("#wx-karte").textContent = "Wetterkarte für Kartenausschnitt"; }
    $("#wx-karte").disabled = false;
  }
  // Referenzpunkte je Region: bis zu 3 verlässliche Plätze mit mindestens 15 km Abstand
  function wxReferenzen() {
    const out = [];
    for (const z of active) for (const r of z.regions) {
      const kand = places.filter((p) => p.zid === z.id && p.region === r && p.lat != null && !p.layer)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const gew = [];
      for (const p of kand) {
        if (gew.every((q) => Math.hypot((p.lat - q.lat) * 111, (p.lng - q.lng) * 111 * Math.cos(p.lat * Math.PI / 180)) > 15)) gew.push(p);
        if (gew.length === 3) break;
      }
      if (gew.length) out.push({ key: `${z.id}|${r}`, name: r, ziel: z.name, punkte: gew });
    }
    return out;
  }
  async function wxRangliste() {
    const refs = wxReferenzen();
    if (!refs.length) { $("#wx-rank").innerHTML = `<p class="muted">Keine Regionen mit verorteten Plätzen in den gewählten Zielen.</p>`; return; }
    $("#wx-rank").innerHTML = `<p class="muted">lädt Prognosen für ${refs.length} Regionen …</p>`;
    try {
      const alle = refs.flatMap((r) => r.punkte.map((p) => [p.lat, p.lng]));
      const res = await WETTER.viele(alle);
      let k = 0;
      const tage = [...new Set(res.flat().map((t) => t.datum))].sort().slice(0, 7);
      wxDaten = tage.map((d) => ({ datum: d }));
      const zeilen = refs.map((r) => {
        const pr = res.slice(k, k + r.punkte.length); k += r.punkte.length;
        const proTag = tage.map((d) => {
          const n = pr.map((x) => x.find((t) => t.datum === d)?.note).filter((x) => x != null);
          return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
        });
        const gut = proTag.filter((x) => x != null);
        return { ...r, proTag, schnitt: gut.length ? gut.reduce((a, b) => a + b, 0) / gut.length : null };
      }).sort((a, b) => (b.schnitt ?? 0) - (a.schnitt ?? 0));
      $("#wx-rank").innerHTML = `<div class="wx-scroll"><table class="wx rank">
          <tr><th>Region</th><th>Ø</th>${tage.map((d) => `<th>${WETTER.tagLabel(d)}</th>`).join("")}</tr>
          ${zeilen.map((z) => `<tr data-region="${esc(z.key)}"><td><b>${esc(z.name)}</b>${active.length > 1 ? `<br><span class="muted">${esc(z.ziel)}</span>` : ""}</td>
            <td>${WETTER.chip(z.schnitt)}</td>${z.proTag.map((n) => `<td><span class="wx-dot ${WETTER.klasse(n)}" title="${n == null ? "–" : n.toFixed(1)}"></span></td>`).join("")}</tr>`).join("")}
        </table></div>
        <p class="muted">Ø = mittlere Wetternote der nächsten 7 Tage (ECMWF, je bis zu 3 Plätze pro Region). Region antippen, um sie auf der Karte zu filtern.</p>`;
    } catch (e) { $("#wx-rank").innerHTML = `<p class="muted">Rangliste nicht verfügbar: ${esc(e.message)}</p>`; }
  }
  $("#btn-wetter").onclick = () => { wxTage(); open("#sheet-wetter"); };
  $("#wx-days").onclick = (e) => { const b = e.target.closest("button[data-i]"); if (!b) return; wxTag = +b.dataset.i; wxTage(); wxZeichnen(); };
  $("#wx-karte").onclick = () => {
    if (wxGrid) { wxGrid = null; wxGroup.clearLayers(); $("#wx-karte").textContent = "Wetterkarte für Kartenausschnitt"; return; }
    wxKarteLaden();
  };
  $("#wx-rank-btn").onclick = wxRangliste;
  $("#wx-rank").onclick = (e) => {
    const tr = e.target.closest("tr[data-region]");
    if (!tr) return;
    filter.regions = [tr.dataset.region];
    syncFilterUI(); render(); close(); fitView();
  };

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
  function fillLink(tpl, s) {
    return tpl.replace(/\{(lat|lng|name|ort)\}/g, (_, k) => {
      if (k === "lat") return s.lat;
      if (k === "lng") return s.lng;
      return encodeURIComponent(k === "name" ? s.name : (s.place || s.name).split(",")[0]);
    });
  }

  function mentionHtml(m) {
    if (m.video_id) {
      const url = `https://www.youtube.com/watch?v=${encodeURIComponent(m.video_id)}${m.t ? `&t=${m.t}s` : ""}`;
      return `<a class="mention" href="${url}" target="_blank" rel="noopener">
        <img loading="lazy" src="https://i.ytimg.com/vi/${encodeURIComponent(m.video_id)}/mqdefault.jpg" alt="">
        <div><div class="mt">${esc(m.title)}</div>
          <div class="ms">${esc(m.channel)} · ${fmtDate(m.published)} · <span class="stars" style="font-size:12px">${stars(m.rating)}</span></div>
          ${m.quote ? `<q>${esc(m.quote)}</q>` : ""}
          <span class="play">▶ ${m.t ? "Ab " + fmtT(m.t) + " ansehen" : "Video ansehen"}</span></div></a>`;
    }
    return `<a class="mention web" href="${esc(m.url)}" target="_blank" rel="noopener">
        <div class="webicon">📝</div>
        <div><div class="mt">${esc(m.title)}</div>
          <div class="ms">${esc(m.site)}${m.published ? " · " + fmtDate(m.published) : ""} · <span class="stars" style="font-size:12px">${stars(m.rating)}</span></div>
          ${m.quote ? `<q>${esc(m.quote)}</q>` : ""}
          <span class="play">Bericht lesen →</span></div></a>`;
  }

  function myHtml(s) {
    if (!GH.token()) return `<p class="muted mine-hint">Favoriten, Notizen und Logbuch: GitHub-Schlüssel und privates Repository hinterlegen (Zielname antippen → ganz unten).</p>`;
    const m = merk(s);
    return `<div class="mine">
      <div class="row">
        <button class="btn ${m.fav ? "" : "ghost"}" data-my="fav">${m.fav ? "★ Favorit" : "☆ Favorit"}</button>
        <button class="btn ${m.visited ? "" : "ghost"}" data-my="visited">${m.visited ? "✓ Besucht " + new Date(m.visited).toLocaleDateString("de-CH") : "Besucht?"}</button>
      </div>
      <label class="field">Meine Notiz
        <textarea data-my="note" rows="2" placeholder="z. B. ruhig, Wasser beim Wärter, 80 MAD">${esc(m.note || "")}</textarea></label>
      <div class="row"><select data-my="rating" aria-label="Meine Bewertung">
        <option value="">Meine Bewertung …</option>${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${m.rating === n ? "selected" : ""}>${"★".repeat(n)}</option>`).join("")}
      </select><button class="btn ghost" data-my="save-note">Notiz speichern</button></div>
      ${isOwn(s) ? `<div class="row"><button class="btn ghost" data-my="edit">Bearbeiten</button><button class="btn ghost danger" data-my="delete">Löschen</button></div>` : ""}
    </div>`;
  }

  function openPlace(key) {
    const s = places.find((x) => x.key === key) || (key.startsWith("merk/") && allMerkPlaces().find((x) => x.key === key));
    if (!s) return;
    if (s.lat != null) map.setView([s.lat, s.lng], Math.max(map.getZoom(), 13));
    openDetail(s);
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
      ["Preis", s.price], ["Plätze", s.capacity], ["Geöffnet", s.opening_hours], ["Betreiber", s.operator],
      [isOwn(s) ? "Notiz" : "Beschreibung", s.description], ["Datensatz", s.dataset ? `${s.dataset}${s.license ? " (" + s.license + ")" : ""}` : ""],
    ].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");

    const routeInfo = routes.filter((r) => routeVal(s, r)).map((r) => {
      const [km, off] = routeVal(s, r);
      return `<div class="route-info"><span class="route-swatch" style="background:${esc(r.color)}"></span>${esc(r.name)}: km ${km} von ${r.length_km}${off >= 1 ? `, ${off} km abseits` : ""}</div>`;
    }).join("");

    const ll = `${s.lat},${s.lng}`;
    const links = [...(index.standard_links || []), ...((zielById(s.zid) || {}).links || [])];
    const videos = s.mentions.filter((m) => m.video_id).length, reports = s.mentions.length - videos;
    const counted = [videos && `${videos} ${videos === 1 ? "Video" : "Videos"}`, reports && `${reports} ${reports === 1 ? "Bericht" : "Berichte"}`].filter(Boolean).join(", ");

    $("#detail").innerHTML = `
      <div class="d-head">
        <h3>${esc(s.name)}</h3>
        <div class="muted">${[s.place, s.region, (zielById(s.zid) || {}).name].filter(Boolean).map(esc).join(" · ")}</div>
      </div>
      ${s.lat != null && window.FOTOS ? FOTOS.schnell(s.lat, s.lng) + `<div id="ft-hero" class="ft-strip"></div>` : ""}
      ${s.merkOnly ? `<p class="muted">Aus Ihrer Merkliste. Das Ziel ist gerade nicht gewählt.${s.lat != null ? ` <button class="linkbtn" data-load-ziel="${esc(s.zid)}">Ziel dazunehmen</button>` : ""}</p>` : ""}
      <div class="badges">
        <span class="badge type ${s.type}">${esc(TYPE_LABEL[s.type] || s.type)}</span>
        ${isOwn(s) ? `<span class="badge own">eigener Platz</span>` : s.merkOnly ? "" : `<span class="badge ${PRECISION[s.precision][1]}">${PRECISION[s.precision][0]}${s.coord_source ? " (" + esc(s.coord_source) + ")" : ""}</span>`}
        ${s.confirmed ? `<span class="badge ok">bestätigt durch ${s.sources.length} Quellen</span>` : ""}
        ${s.confidence && !isOwn(s) ? `<span class="badge conf ${s.confidence}">Verlässlichkeit ${s.confidence} (${s.score})</span>` : ""}
        ${ageDays(s) > 365 ? `<span class="badge warn">Info älter als 1 Jahr</span>` : ""}
      </div>
      <div class="srcs">${s.sources.map((x) => `<span>${esc((SOURCES[x] || [x])[0])}</span>`).join("")}</div>
      ${s.rating != null && s.mentions.length ? `<div class="stars">${stars(s.rating)}<small>${s.rating.toFixed(1)} · ${counted} · zuletzt ${fmtDate(s.last_seen)}</small></div>` : ""}
      ${s.recommendation ? `<div class="reco">${esc(s.recommendation)}</div>` : ""}
      ${routeInfo}
      ${myHtml(s)}
      ${s.lat == null ? "" : `<div id="wx-detail" class="wx-box"></div><div id="ft-detail" class="ft-box"></div>`}
      <div class="infra">${infra}</div>
      ${facts ? `<dl class="facts">${facts}</dl>` : ""}
      ${s.lat == null ? "" : `<div class="links">
        <a class="btn" href="https://maps.apple.com/?daddr=${ll}&q=${encodeURIComponent(s.name)}" target="_blank" rel="noopener">Apple Karten</a>
        <a class="btn" href="https://www.google.com/maps/search/?api=1&query=${ll}" target="_blank" rel="noopener">Google Maps</a>
        ${links.map((l) => `<a class="btn ghost" href="${esc(fillLink(l.url, s))}" target="_blank" rel="noopener">${esc(l.name)}</a>`).join("")}
        ${s.website ? `<a class="btn ghost" href="${esc(s.website)}" target="_blank" rel="noopener">Website</a>` : ""}
        ${s.osm ? `<a class="btn ghost" href="https://www.openstreetmap.org/${esc(s.osm)}" target="_blank" rel="noopener">OpenStreetMap</a>` : ""}
        <button class="btn ghost" data-share>Teilen</button>
      </div>`}
      ${s.mentions.length ? `<h4>Aus Videos und Berichten</h4>${s.mentions.map(mentionHtml).join("")}` : ""}
      ${s.osm ? `<p class="muted">Daten aus OpenStreetMap, ohne Gewähr. © OpenStreetMap-Mitwirkende (ODbL).</p>` : ""}`;
    const share = $("#detail [data-share]");
    if (share) share.onclick = () => {
      const url = location.href.split("#")[0] + "#" + s.zid + "/" + s.id;
      if (navigator.share) navigator.share({ title: s.name, url }).catch(() => {});
      else navigator.clipboard?.writeText(url);
    };
    bindMine(s);
    if (s.lat != null && window.WETTER) WETTER.detail($("#wx-detail"), s.lat, s.lng);
    if (s.lat != null && window.FOTOS) { FOTOS.leiste($("#ft-hero"), s.lat, s.lng); FOTOS.detail($("#ft-detail"), s.lat, s.lng); bindSchnell(s.lat, s.lng); }
    const lz = $("#detail [data-load-ziel]");
    if (lz) lz.onclick = async () => {
      const id = lz.dataset.loadZiel;
      if (!active.some((z) => z.id === id)) await setActive([...active.map((z) => z.id), id], `${id}/${s.id}`);
    };
    if (!s.merkOnly && !isOwn(s)) history.replaceState(null, "", "#" + s.zid + "/" + s.id);
    open("#sheet-detail");
  }

  // Schnellknöpfe oben im Platz bzw. am gewählten Kartenpunkt
  function bindSchnell(lat, lng) {
    const f = $("#detail [data-q='fotos']"), w = $("#detail [data-q='wetter']");
    if (f) f.onclick = () => FOTOS.fotosZeigen(lat, lng);
    if (w) w.onclick = () => $("#wx-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Langer Druck (oder Rechtsklick) auf die Karte: Street View, Fotos und Wetter für genau diese Stelle
  function openPunkt(lat, lng) {
    $("#detail").innerHTML = `
      <div class="d-head"><h3>Gewählte Stelle</h3><div class="muted">${lat.toFixed(5)}, ${lng.toFixed(5)}</div></div>
      ${FOTOS.schnell(lat, lng)}<div id="ft-hero" class="ft-strip"></div>
      <div class="links">
        <a class="btn" href="https://maps.apple.com/?daddr=${lat},${lng}" target="_blank" rel="noopener">Apple Karten</a>
        <a class="btn" href="https://www.google.com/maps/search/?api=1&query=${lat},${lng}" target="_blank" rel="noopener">Google Maps</a>
        <a class="btn ghost" href="https://park4night.com/en/search?lat=${lat}&lng=${lng}&z=14" target="_blank" rel="noopener">park4night</a>
      </div>
      <div id="wx-detail" class="wx-box"></div><div id="ft-detail" class="ft-box"></div>`;
    FOTOS.leiste($("#ft-hero"), lat, lng);
    FOTOS.detail($("#ft-detail"), lat, lng);
    if (window.WETTER) WETTER.detail($("#wx-detail"), lat, lng);
    bindSchnell(lat, lng);
    open("#sheet-detail");
  }
  map.on("contextmenu", (e) => { if (window.FOTOS) openPunkt(e.latlng.lat, e.latlng.lng); });

  function bindMine(s) {
    const box = $("#detail .mine");
    if (!box) return;
    const store = async (changes, msg) => {
      try {
        await PRIV.setMerk(merkZiel(s), s.id, s.name, { ...changes, lat: s.lat, lng: s.lng, type: s.type });
        toast(msg); refreshMarker(s); openDetail(s); rebuildLayer();
      }
      catch (err) { toast("Speichern fehlgeschlagen: " + err.message + " – privates Repository prüfen (Zielname antippen → ganz unten)."); }
    };
    box.onclick = async (e) => {
      const b = e.target.closest("button[data-my]");
      if (!b) return;
      const m = merk(s);
      if (b.dataset.my === "fav") store({ fav: !m.fav }, m.fav ? "Aus Favoriten entfernt" : "Als Favorit gespeichert");
      if (b.dataset.my === "visited") store({ visited: m.visited ? null : new Date().toISOString().slice(0, 10) }, m.visited ? "Besuch entfernt" : "Im Logbuch eingetragen");
      if (b.dataset.my === "save-note") store({ note: box.querySelector("textarea").value.trim(), rating: +box.querySelector("select").value || null }, "Notiz gespeichert");
      if (b.dataset.my === "edit") openOwnForm(s.own);
      if (b.dataset.my === "delete" && confirm(`«${s.name}» löschen?`)) {
        try { await PRIV.deleteEigen(s.id); toast("Gelöscht"); close(); await reloadOwn(); }
        catch (err) { toast("Löschen fehlgeschlagen: " + err.message); }
      }
    };
  }

  // ---------------------------------------------------------------- Eigene Plätze erfassen
  let ownDraft = null;
  function openOwnForm(entry) {
    if (!GH.token()) { toast("Für eigene Plätze zuerst GitHub-Schlüssel und privates Repository hinterlegen."); return; }
    const c = map.getCenter();
    ownDraft = entry ? { ...entry } : {
      id: "e-" + Date.now().toString(36), ziel: ziel ? ziel.id : "", name: "", type: "stellplatz", rating: null, note: "", link: "",
      lat: me ? me[0] : +c.lat.toFixed(5), lng: me ? me[1] : +c.lng.toFixed(5), created: new Date().toISOString().slice(0, 10),
      visited: new Date().toISOString().slice(0, 10),
    };
    $("#own-title").textContent = entry ? "Eigenen Platz bearbeiten" : "Eigenen Platz erfassen";
    $("#own-name").value = ownDraft.name;
    $("#own-type").value = ownDraft.type;
    $("#own-rating").value = ownDraft.rating || "";
    $("#own-note").value = ownDraft.note || "";
    $("#own-link").value = ownDraft.link || "";
    $("#own-visited").checked = !!ownDraft.visited;
    showOwnPos(entry ? "gespeicherte Position" : me ? "Ihr Standort" : "Kartenmitte");
    open("#sheet-own");
  }
  function showOwnPos(src) { $("#own-pos").textContent = `${ownDraft.lat.toFixed(5)}, ${ownDraft.lng.toFixed(5)} (${src})`; }
  $("#btn-add").onclick = () => openOwnForm(null);
  $("#own-here").onclick = () => getPosition((p) => { ownDraft.lat = +p[0].toFixed(5); ownDraft.lng = +p[1].toFixed(5); showOwnPos("Ihr Standort"); });
  $("#own-center").onclick = () => { const c = map.getCenter(); ownDraft.lat = +c.lat.toFixed(5); ownDraft.lng = +c.lng.toFixed(5); showOwnPos("Kartenmitte"); };
  $("#own-save").onclick = async () => {
    const name = $("#own-name").value.trim();
    if (!name) { $("#own-name").focus(); return; }
    Object.assign(ownDraft, {
      name, type: $("#own-type").value, rating: +$("#own-rating").value || null, note: $("#own-note").value.trim(),
      link: $("#own-link").value.trim(), visited: $("#own-visited").checked ? (ownDraft.visited || new Date().toISOString().slice(0, 10)) : null,
    });
    $("#own-save").disabled = true;
    try {
      await PRIV.saveEigen(ownDraft);
      if (ownDraft.visited) await PRIV.setMerk(ownDraft.ziel, ownDraft.id, name, { visited: ownDraft.visited, lat: ownDraft.lat, lng: ownDraft.lng, type: ownDraft.type });
      toast("Eigener Platz gespeichert");
      close();
      layers.eigene = true;
      await reloadOwn();
      openPlace(`eigene/${ownDraft.id}`);
    } catch (err) { toast("Speichern fehlgeschlagen: " + err.message); }
    $("#own-save").disabled = false;
  };
  async function reloadOwn() { rebuildLayer(); }

  // ---------------------------------------------------------------- Ziele, Quellen & Anfragen
  function sourceSummary(z) {
    const c = z.counts || {};
    return Object.keys(SOURCES).filter((k) => (z.sources || {})[k]).map((k) => `${SOURCES[k][0]}${c[k] ? " " + c[k] : ""}`).join(" · ") || "keine Quelle aktiv";
  }
  function renderZielList() {
    const can = !!GH.token();
    $("#ziel-list").innerHTML = index.ziele.map((z) => `
      <li data-id="${esc(z.id)}" class="${active.some((a) => a.id === z.id) ? "on" : ""}">
        <div class="zrow">
          <input type="checkbox" class="zcheck" data-toggle aria-label="${esc(z.name)} auf der Karte zeigen" ${active.some((a) => a.id === z.id) ? "checked" : ""}>
          <span data-select class="zname">${esc(z.name)}</span>
          <span class="r">${z.spots} Plätze${z.routes.length ? ` · ${z.routes.length} Routen` : ""}<br>${z.last_run ? "Stand " + new Date(z.last_run).toLocaleDateString("de-CH") : "noch kein Abruf"}</span>
        </div>
        <div class="srcline muted">${esc(sourceSummary(z))}</div>
        <div class="zctl">
          ${can ? `<select data-schedule aria-label="Zeitplan">
              ${Object.entries(SCHEDULE).map(([k, v]) => `<option value="${k}" ${z.schedule === k ? "selected" : ""}>${v}${k === "woechentlich" ? " (" + WEEKDAY[z.weekday || 1] + ")" : ""}</option>`).join("")}
            </select>
            <button class="btn small" data-run>Jetzt aktualisieren</button>`
          : `<span class="muted">Zeitplan: ${SCHEDULE[z.schedule] || "täglich"}${z.schedule === "woechentlich" ? " (" + WEEKDAY[z.weekday || 1] + ")" : ""}</span>`}
          <button class="btn ghost small" data-sources>Quellen</button>
        </div>
      </li>`).join("") || `<li class="muted">Noch keine Ziele.</li>`;
  }
  $("#ziel-list").onclick = async (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const z = index.ziele.find((x) => x.id === li.dataset.id);
    if (e.target.closest("[data-select]")) { close(); selectZiel(z.id); return; }
    if (e.target.closest("[data-toggle]")) {
      const ids = active.map((a) => a.id);
      const next = ids.includes(z.id) ? ids.filter((x) => x !== z.id) : [...ids, z.id];
      if (!next.length) { e.target.checked = true; toast("Mindestens ein Ziel muss gewählt sein."); return; }
      await setActive(next);
      return;
    }
    if (e.target.closest("[data-sources]")) { openSources(z); return; }
    const run = e.target.closest("[data-run]");
    if (run) {
      run.disabled = true; run.textContent = "wird gestartet …";
      try { await GH.dispatch({ ziel: z.id }); toast(`Abruf für ${z.name} gestartet. Den Fortschritt sehen Sie unter i → Läufe.`); run.textContent = "gestartet ✓"; }
      catch (err) { toast("Start fehlgeschlagen: " + err.message); run.disabled = false; run.textContent = "Jetzt aktualisieren"; }
    }
  };
  $("#ziel-list").onchange = async (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li || !e.target.matches("[data-schedule]")) return;
    const z = index.ziele.find((x) => x.id === li.dataset.id);
    const schedule = e.target.value;
    e.target.disabled = true;
    try {
      await GH.updateZiel(z.id, { schedule }, `Zeitplan ${z.id}: ${schedule} (aus der Webapp)`);
      z.schedule = schedule;
      toast(`Zeitplan für ${z.name}: ${SCHEDULE[schedule]}. Gilt ab dem nächsten Lauf.`);
    } catch (err) { toast("Ändern fehlgeschlagen: " + err.message); e.target.value = z.schedule; }
    e.target.disabled = false;
  };

  // Quellen eines Ziels ein-/ausschalten und Link-Knöpfe pflegen
  let srcZiel = null, srcLinks = [];
  function openSources(z) {
    srcZiel = z;
    srcLinks = (z.links || []).map((l) => ({ ...l }));
    const can = !!GH.token();
    const c = z.counts || {}, err = z.errors || {};
    $("#src-title").textContent = `Quellen: ${z.name}`;
    $("#src-list").innerHTML = Object.entries(SOURCES).filter(([k]) => k !== "eigene").map(([k, [label, desc, cost]]) => `
      <label class="srcrow"><input type="checkbox" data-src="${k}" ${(z.sources || {})[k] ? "checked" : ""} ${can ? "" : "disabled"}>
        <span><b>${label}</b>${c[k] ? ` <span class="muted">· ${c[k]} Plätze</span>` : ""}<br>
        <span class="muted">${desc} · ${cost}</span>
        ${k === "youtube" && !z.youtube_ready ? `<br><span class="warntext">Noch keine Suchbegriffe – per Anfrage ergänzen, z. B. «${esc(z.name)}: YouTube-Suche einrichten».</span>` : ""}
        ${k === "opendata" ? `<br><span class="muted">${z.opendata && z.opendata.length ? "Datensätze: " + z.opendata.map(esc).join(", ") : "Noch keine Datensätze – per Anfrage mit Download-Adresse ergänzen."}</span>` : ""}
        ${err[k.startsWith("osm") ? "osm" : k] ? `<br><span class="warntext">Letzter Fehler: ${esc(err[k.startsWith("osm") ? "osm" : k])}</span>` : ""}
        </span></label>`).join("") + `
      <label class="srcrow"><input type="checkbox" checked disabled><span><b>Eigene Plätze</b><br><span class="muted">immer aktiv, nur für Sie sichtbar</span></span></label>`;
    renderSrcLinks();
    $("#src-save").hidden = $("#src-add").hidden = !can;
    $("#src-hint").hidden = can;
    open("#sheet-sources");
  }
  function renderSrcLinks() {
    const can = !!GH.token();
    $("#src-links").innerHTML = (index.standard_links || []).map((l) => `<li><b>${esc(l.name)}</b> <span class="muted">· bei allen Zielen</span></li>`).join("")
      + srcLinks.map((l, i) => `<li><b>${esc(l.name)}</b> <span class="muted">${esc(l.url)}</span>${can ? ` <button class="linkbtn" data-del="${i}">entfernen</button>` : ""}</li>`).join("");
  }
  $("#src-links").onclick = (e) => {
    const b = e.target.closest("[data-del]");
    if (b) { srcLinks.splice(+b.dataset.del, 1); renderSrcLinks(); }
  };
  $("#src-add").onclick = () => {
    const name = $("#src-link-name").value.trim(), url = $("#src-link-url").value.trim();
    if (!name || !/^https:\/\//.test(url)) { toast("Name und eine Adresse mit https:// angeben."); return; }
    srcLinks.push({ name, url });
    $("#src-link-name").value = $("#src-link-url").value = "";
    renderSrcLinks();
  };
  $("#src-save").onclick = async () => {
    const sources = {};
    document.querySelectorAll("#src-list input[data-src]").forEach((i) => (sources[i.dataset.src] = i.checked));
    if (!Object.values(sources).some(Boolean)) { toast("Mindestens eine Quelle muss aktiv sein."); return; }
    $("#src-save").disabled = true;
    try {
      await GH.updateZiel(srcZiel.id, { sources, links: srcLinks }, `Quellen ${srcZiel.id} (aus der Webapp)`);
      Object.assign(srcZiel, { sources, links: srcLinks });
      if ($("#src-run").checked) await GH.dispatch({ ziel: srcZiel.id });
      toast($("#src-run").checked ? "Gespeichert, Abruf gestartet. Ergebnis nach einigen Minuten." : "Gespeichert. Gilt ab dem nächsten Lauf.");
      close();
    } catch (err) { toast("Speichern fehlgeschlagen: " + err.message); }
    $("#src-save").disabled = false;
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
    const body = `${text}\n\n---\nGesendet aus der Webapp · gewählte Ziele: ${active.map((z) => `${z.name} (${z.id})`).join(", ") || "–"}`;
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
      // Bei erledigten Anfragen das betroffene Ziel aus der Antwort lesen
      const zielOf = {};
      await Promise.all(issues.filter((i) => i.state === "closed" && i.comments).map(async (i) => {
        try {
          const body = (await GH.api(`/issues/${i.number}/comments?per_page=5`)).map((c) => c.body).join("\n");
          const m = body.match(/<!-- ziel:([a-z0-9-]+) -->/) || body.match(/"id":\s*"([a-z0-9-]+)"/) || body.match(/\(([a-z0-9-]+)\)/);
          if (m && index.ziele.some((z) => z.id === m[1])) zielOf[i.number] = m[1];
        } catch { /* ohne Kommentar kein Knopf */ }
      }));
      $("#req-list").innerHTML = issues.map((i) => {
        const done = i.state === "closed";
        const zid = zielOf[i.number];
        return `<li><a href="${esc(i.html_url)}" target="_blank" rel="noopener">
          <span class="st ${done ? "erledigt" : "offen"}">${done ? "erledigt" : i.comments ? "Rückfrage" : "in Arbeit"}</span>${esc(i.title.replace("[Ziel] ", ""))}</a>
          <div class="muted">${new Date(i.created_at).toLocaleString("de-CH", { dateStyle: "short", timeStyle: "short" })}${i.comments ? ` · ${i.comments} Antwort${i.comments > 1 ? "en" : ""}` : ""} · <a href="${esc(i.html_url)}" target="_blank" rel="noopener">Antwort lesen</a></div>
          ${zid ? `<button class="btn small" data-open-ziel="${esc(zid)}">Ziel öffnen: ${esc(index.ziele.find((z) => z.id === zid).name)}</button>` : ""}</li>`;
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
    if (current === "#sheet-filter") fitView();
    current = null;
    $("#backdrop").hidden = true;
  }
  $("#backdrop").onclick = close;
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = close));
  $("#btn-filter").onclick = () => open("#sheet-filter");
  $("#btn-list").onclick = () => open("#sheet-list");
  $("#btn-info").onclick = () => open("#sheet-info");
  $("#btn-ziel").onclick = async () => {
    $("#req-text").value = loadStr("req-draft") || "";
    renderZielList();
    showTokenState();
    open("#sheet-ziel");
    // Zielliste frisch laden, damit neu angelegte Ziele ohne Neustart der App erscheinen
    try {
      const fresh = await getJson("data/ziele.json");
      index = fresh;
      active = active.map((a) => zielById(a.id) || a);
      ziel = active[0] || null;
      renderZielList();
    } catch { /* offline: bisherige Liste */ }
    loadRequests();
  };
  $("#req-list").onclick = (e) => {
    const b = e.target.closest("[data-open-ziel]");
    if (b) { close(); selectZiel(b.dataset.openZiel); }
  };

  // ---------------------------------------------------------------- GitHub-Schlüssel und privates Repository
  async function showTokenState(verify = false) {
    const has = !!GH.token();
    $("#req-hint-direct").hidden = !has;
    $("#req-hint-link").hidden = has;
    $("#gh-token").value = "";
    $("#gh-token").placeholder = has ? "•••••••• (hinterlegt)" : "github_pat_…";
    $("#gh-private").value = PRIV.repo();
    $("#gh-private-new").href = `https://github.com/new?name=${encodeURIComponent(PRIV.repo().split("/")[1] || "camper-plaetze-privat")}&visibility=private`;
    if (!has) { $("#gh-status").textContent = "Kein Schlüssel hinterlegt. Mit Schlüssel: Ziele starten, Quellen und Zeitpläne ändern, eigene Plätze, Favoriten und Logbuch."; return; }
    $("#gh-status").textContent = verify ? "Prüfe …" : "Schlüssel hinterlegt.";
    if (!verify) return;
    let msg;
    try { msg = `Verbunden als ${await GH.check()}.`; }
    catch (err) { $("#gh-status").textContent = "Schlüssel ungültig: " + err.message; return; }
    try { msg += ` Privates Repository ${await PRIV.check()} bereit.`; await PRIV.load(); reloadOwn(); }
    catch (err) { msg += ` Privates Repository: ${err.message.startsWith("404") ? "nicht gefunden – bitte anlegen (Link unten) und dem Schlüssel freigeben" : err.message}.`; }
    $("#gh-status").textContent = msg;
  }
  $("#gh-save").onclick = async () => {
    const t = $("#gh-token").value.trim();
    if (t) GH.setToken(t);
    PRIV.setRepo($("#gh-private").value.trim());
    await showTokenState(true);
    renderZielList();
  };
  $("#gh-remove").onclick = () => { GH.setToken(""); showTokenState(); renderZielList(); };
  $("#list").onclick = (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) openPlace(li.dataset.id);
  };

  // Nach unten wischen schliesst ein Sheet
  document.querySelectorAll(".sheet").forEach((sh) => {
    let y0 = null;
    sh.addEventListener("touchstart", (e) => { y0 = sh.scrollTop <= 0 && !["TEXTAREA", "INPUT", "SELECT"].includes(e.target.tagName) ? e.touches[0].clientY : null; }, { passive: true });
    sh.addEventListener("touchend", (e) => { if (y0 != null && e.changedTouches[0].clientY - y0 > 90) close(); y0 = null; }, { passive: true });
  });

  // ---------------------------------------------------------------- Filter-UI
  function renderSourceChips() {
    const present = new Set(places.flatMap((s) => s.sources));
    $("#f-source").innerHTML = Object.keys(SOURCES).filter((k) => present.has(k) && k !== "eigene")
      .map((k) => `<button data-v="${k}" class="chip">${SOURCES[k][0]}</button>`).join("") || `<span class="muted">–</span>`;
  }
  function renderRegionChips() {
    $("#f-region").innerHTML = active.map((z) => `${active.length > 1 ? `<div class="chipgroup">${esc(z.name)}</div>` : ""}` +
      z.regions.map((r) => `<button data-v="${esc(z.id + "|" + r)}" class="chip">${esc(r)}</button>`).join("")).join("");
  }
  function syncFilterUI() {
    document.querySelectorAll("#f-region .chip").forEach((b) => b.classList.toggle("on", filter.regions.includes(b.dataset.v)));
    $("#f-region-all").classList.toggle("on", !filter.regions.length);
    document.querySelectorAll("#f-layers input").forEach((i) => (i.checked = !!layers[i.dataset.layer]));
    $("#f-route").value = filter.route;
    $("#corridor-field").hidden = !filter.route;
    document.querySelectorAll("#f-corridor button").forEach((b) => b.classList.toggle("on", +b.dataset.v === filter.corridor));
    document.querySelectorAll("#f-type .chip").forEach((b) => b.classList.toggle("on", !filter.hideTypes.includes(b.dataset.v)));
    document.querySelectorAll("#f-source .chip").forEach((b) => b.classList.toggle("on", !filter.hideSources.includes(b.dataset.v)));
    document.querySelectorAll("#f-infra .chip").forEach((b) => b.classList.toggle("on", filter.infra.includes(b.dataset.v)));
    document.querySelectorAll("#f-rating button").forEach((b) => b.classList.toggle("on", +b.dataset.v === filter.rating));
    document.querySelectorAll("#f-age button").forEach((b) => b.classList.toggle("on", +b.dataset.v === filter.age));
    document.querySelectorAll("#f-conf button").forEach((b) => b.classList.toggle("on", b.dataset.v === filter.conf));
    $("#f-no4wd").checked = filter.no4wd;
    $("#f-exact").checked = filter.exact;
    $("#f-safe").checked = filter.safe;
    $("#f-fav").checked = filter.onlyFav;
    $("#search").value = filter.q;
  }
  function toggleIn(arr, v) { return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]; }

  $("#f-route").onchange = (e) => { filter.route = e.target.value; syncFilterUI(); drawRoutes(); render(); };
  $("#f-corridor").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; filter.corridor = +b.dataset.v; syncFilterUI(); render(); };
  $("#f-region").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; filter.regions = toggleIn(filter.regions, b.dataset.v); syncFilterUI(); render(); };
  $("#f-region-all").onclick = () => { filter.regions = []; syncFilterUI(); render(); };
  $("#f-layers").onchange = (e) => { const i = e.target.closest("input[data-layer]"); if (!i) return; layers[i.dataset.layer] = i.checked; rebuildLayer(); };
  $("#f-source").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; filter.hideSources = toggleIn(filter.hideSources, b.dataset.v); syncFilterUI(); render(); };
  $("#f-type").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; filter.hideTypes = toggleIn(filter.hideTypes, b.dataset.v); syncFilterUI(); render(); };
  $("#f-infra").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; filter.infra = toggleIn(filter.infra, b.dataset.v); syncFilterUI(); render(); };
  $("#f-rating").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; filter.rating = +b.dataset.v; syncFilterUI(); render(); };
  $("#f-age").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; filter.age = +b.dataset.v; syncFilterUI(); render(); };
  $("#f-conf").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; filter.conf = b.dataset.v; syncFilterUI(); render(); };
  [["no4wd", "no4wd"], ["exact", "exact"], ["safe", "safe"], ["fav", "onlyFav"]].forEach(([id, k]) => ($(`#f-${id}`).onchange = (e) => { filter[k] = e.target.checked; render(); }));
  $("#search").oninput = (e) => { filter.q = e.target.value.trim(); render(); };
  $("#f-reset").onclick = () => { filter = structuredClone(DEFAULT_FILTER); syncFilterUI(); drawRoutes(); render(); };

  // ---------------------------------------------------------------- Standort
  function getPosition(done) {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((p) => {
      me = [p.coords.latitude, p.coords.longitude];
      if (meMarker) meMarker.setLatLng(me);
      else meMarker = L.marker(me, { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [16, 16] }), interactive: false }).addTo(map);
      done(me);
    }, () => alert("Standort nicht verfügbar. Bitte in den iPhone-Einstellungen Safari den Standortzugriff erlauben."), { enableHighAccuracy: true, timeout: 10000 });
  }
  $("#btn-locate").onclick = () => getPosition((p) => { map.setView(p, Math.max(map.getZoom(), 10)); render(); });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  init();
})();
