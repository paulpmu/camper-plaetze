(() => {
  "use strict";

  const TYPE_LABEL = { wildplatz: "Wildplatz", camping: "Camping", stellplatz: "Stellplatz", andere: "Andere" };
  const INFRA_LABEL = { water: "💧 Wasser", dump_station: "🚽 Ver-/Entsorgung", electricity: "⚡ Strom", toilets: "🚻 WC", showers: "🚿 Dusche" };
  const DEFAULT_FILTER = { region: "", types: ["wildplatz", "camping", "stellplatz", "andere"], rating: 0, age: 365, infra: [], no4wd: false, exact: false, safe: false, q: "" };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let spots = [];
  let filter = load("filter", DEFAULT_FILTER);
  let me = null;
  let meMarker = null;
  const markers = new Map();

  function load(key, def) {
    try { return { ...def, ...JSON.parse(localStorage.getItem(key)) }; } catch { return { ...def }; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* privater Modus */ }
  }

  // ---------------------------------------------------------------- Karte
  const map = L.map("map", { zoomControl: false, tap: true }).setView([29.5, -8.5], 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a>',
  }).addTo(map);
  const cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45, spiderfyOnMaxZoom: true });
  map.addLayer(cluster);

  function icon(s) {
    return L.divIcon({
      className: "",
      html: `<div class="pin ${s.type} ${s.precision === "exakt" ? "" : "approx"}"><b>${s.rating.toFixed(1).replace(".0", "")}</b></div>`,
      iconSize: [30, 30],
      iconAnchor: [4, 30],
    });
  }

  // ---------------------------------------------------------------- Daten
  async function init() {
    try {
      const [sr, mr] = await Promise.all([fetch("data/spots.json", { cache: "no-cache" }), fetch("data/meta.json", { cache: "no-cache" })]);
      spots = await sr.json();
      const meta = await mr.json();
      showMeta(meta);
    } catch (e) {
      $("#count").textContent = "Daten nicht erreichbar (offline?)";
      return;
    }
    const regions = [...new Set(spots.map((s) => s.region))].sort();
    $("#f-region").insertAdjacentHTML("beforeend", regions.map((r) => `<option>${esc(r)}</option>`).join(""));
    for (const s of spots) {
      const m = L.marker([s.lat, s.lng], { icon: icon(s), title: s.name });
      m.on("click", () => openDetail(s));
      markers.set(s.id, m);
    }
    syncFilterUI();
    render(true);
    if (!spots.length) {
      document.body.insertAdjacentHTML("beforeend",
        `<div class="empty"><strong>Noch keine Plätze</strong><p class="muted">Der erste automatische Abruf hat noch keine Daten geliefert. Sobald die API-Schlüssel eingerichtet sind, füllt sich die Karte jede Nacht.</p></div>`);
    }
    const hash = decodeURIComponent(location.hash.slice(1));
    const linked = spots.find((s) => s.id === hash);
    if (linked) { map.setView([linked.lat, linked.lng], 13); openDetail(linked); }
  }

  function showMeta(meta) {
    if (!meta.last_run) { $("#meta").textContent = "Noch kein Abruf erfolgt."; return; }
    const d = new Date(meta.last_run);
    $("#meta").textContent = `Stand ${d.toLocaleDateString("de-CH")} ${d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })} · ${meta.spots} Plätze aus ${meta.videos_total} ausgewerteten Videos` + (meta.queue ? ` · ${meta.queue} Videos in Warteschlange` : "");
  }

  function ageDays(s) { return (Date.now() - new Date(s.last_seen).getTime()) / 864e5; }

  function matches(s) {
    const f = filter;
    if (f.region && s.region !== f.region) return false;
    if (!f.types.includes(s.type)) return false;
    if (s.rating < f.rating) return false;
    if (f.age && ageDays(s) > f.age) return false;
    if (f.infra.some((k) => s.infrastructure[k] !== true)) return false;
    if (f.no4wd && s.four_wd === true) return false;
    if (f.exact && s.precision !== "exakt") return false;
    if (f.safe && s.safety_rating != null && s.safety_rating < 3) return false;
    if (f.q) {
      const hay = [s.name, s.place, s.region, ...s.mentions.map((m) => m.channel + " " + m.title)].join(" ").toLowerCase();
      if (!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
  }

  function isDefault() {
    const { q, ...a } = filter; const { q: _q, ...b } = DEFAULT_FILTER;
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function render(fit = false) {
    const visible = spots.filter(matches);
    cluster.clearLayers();
    cluster.addLayers(visible.map((s) => markers.get(s.id)));
    $("#count").textContent = spots.length ? `${visible.length} von ${spots.length} Plätzen` : "keine Daten";
    $("#filter-dot").hidden = isDefault();
    renderList(visible);
    if (fit && visible.length) map.fitBounds(L.latLngBounds(visible.map((s) => [s.lat, s.lng])), { padding: [40, 40], maxZoom: 12 });
    save("filter", filter);
  }

  function distKm(s) {
    if (!me) return null;
    const R = 6371, r = Math.PI / 180;
    const dLat = (s.lat - me[0]) * r, dLng = (s.lng - me[1]) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(me[0] * r) * Math.cos(s.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function renderList(visible) {
    const items = visible.map((s) => ({ s, d: distKm(s) }));
    if (me) items.sort((a, b) => a.d - b.d);
    else items.sort((a, b) => b.s.rating - a.s.rating || b.s.last_seen.localeCompare(a.s.last_seen));
    $("#list-sort").textContent = me ? "nach Entfernung" : "nach Bewertung";
    $("#list").innerHTML = items.slice(0, 300).map(({ s, d }) => `
      <li data-id="${s.id}">
        <div class="pin ${s.type} ${s.precision === "exakt" ? "" : "approx"}"><b>${s.rating.toFixed(1).replace(".0", "")}</b></div>
        <div><div class="t">${esc(s.name)}</div><div class="s">${esc(TYPE_LABEL[s.type])} · ${esc(s.place)}</div></div>
        <div class="r">${d != null ? Math.round(d) + " km<br>" : ""}${fmtDate(s.last_seen)}</div>
      </li>`).join("") || `<li class="muted">Keine Plätze für diese Filter.</li>`;
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
  function yesNo(v) { return v === true ? "ja" : v === false ? "nein" : null; }

  function openDetail(s) {
    const infra = Object.entries(INFRA_LABEL).map(([k, label]) => {
      const v = s.infrastructure[k];
      return `<span class="${v === true ? "" : v === false ? "no" : "unk"}">${label}${v == null ? " ?" : ""}</span>`;
    }).join("");
    const facts = [
      ["Zufahrt", [s.four_wd === true ? "Allrad nötig" : s.four_wd === false ? "ohne Allrad" : "", s.access_note].filter(Boolean).join(" – ")],
      ["Sicherheit", [s.safety_rating ? `${s.safety_rating}/5` : "", s.safety_note].filter(Boolean).join(" – ")],
      ["Polizei", yesNo(s.police_contact) && (s.police_contact ? "Kontakt erwähnt" : "kein Kontakt")],
      ["Preis", s.price],
      ["iOverlander", s.ioverlander && esc(s.ioverlander.name) + (s.ioverlander.category ? ` (${esc(s.ioverlander.category)})` : "")],
    ].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${k === "iOverlander" ? v : esc(v)}</dd>`).join("");

    const ll = `${s.lat},${s.lng}`;
    const io = s.ioverlander && s.ioverlander.id ? `https://www.ioverlander.com/places/${encodeURIComponent(s.ioverlander.id)}` : null;
    const mentions = s.mentions.map((m) => {
      const url = `https://www.youtube.com/watch?v=${m.video_id}${m.t ? `&t=${m.t}s` : ""}`;
      return `<a class="mention" href="${url}" target="_blank" rel="noopener">
        <img loading="lazy" src="https://i.ytimg.com/vi/${m.video_id}/mqdefault.jpg" alt="">
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
        <div class="muted">${esc(s.place)} · ${esc(s.region)}</div>
      </div>
      <div class="badges">
        <span class="badge type ${s.type}">${TYPE_LABEL[s.type]}</span>
        ${s.precision === "exakt" ? `<span class="badge">genaue Koordinaten</span>` : `<span class="badge warn">ungefährer Standort (Ort)</span>`}
        ${ageDays(s) > 365 ? `<span class="badge warn">Info älter als 1 Jahr</span>` : ""}
      </div>
      <div class="stars">${stars(s.rating)}<small>${s.rating.toFixed(1)} · ${s.mentions.length} ${s.mentions.length === 1 ? "Video" : "Videos"} · zuletzt ${fmtDate(s.last_seen)}</small></div>
      ${s.recommendation ? `<div class="reco">${esc(s.recommendation)}</div>` : ""}
      <div class="infra">${infra}</div>
      ${facts ? `<dl class="facts">${facts}</dl>` : ""}
      <div class="links">
        <a class="btn" href="https://maps.apple.com/?daddr=${ll}&q=${encodeURIComponent(s.name)}" target="_blank" rel="noopener">Apple Karten</a>
        <a class="btn" href="https://www.google.com/maps/search/?api=1&query=${ll}" target="_blank" rel="noopener">Google Maps</a>
        <a class="btn ghost" href="https://park4night.com/en/search?lat=${s.lat}&lng=${s.lng}&z=14" target="_blank" rel="noopener">park4night</a>
        ${io ? `<a class="btn ghost" href="${io}" target="_blank" rel="noopener">iOverlander</a>` : `<button class="btn ghost" data-share>Teilen</button>`}
      </div>
      <h4>Aus den Videos</h4>
      ${mentions}`;
    const share = $("#detail [data-share]");
    if (share) share.onclick = () => {
      const url = location.href.split("#")[0] + "#" + s.id;
      if (navigator.share) navigator.share({ title: s.name, url }).catch(() => {});
      else navigator.clipboard?.writeText(url);
    };
    history.replaceState(null, "", "#" + s.id);
    open("#sheet-detail");
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
    if (current === "#sheet-detail") history.replaceState(null, "", location.pathname);
    current = null;
    $("#backdrop").hidden = true;
  }
  $("#backdrop").onclick = close;
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = close));
  $("#btn-filter").onclick = () => open("#sheet-filter");
  $("#btn-list").onclick = () => open("#sheet-list");
  $("#btn-info").onclick = () => open("#sheet-info");
  $("#list").onclick = (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const s = spots.find((x) => x.id === li.dataset.id);
    map.setView([s.lat, s.lng], Math.max(map.getZoom(), 13));
    openDetail(s);
  };

  // Nach unten wischen schliesst ein Sheet
  document.querySelectorAll(".sheet").forEach((sh) => {
    let y0 = null;
    sh.addEventListener("touchstart", (e) => { y0 = sh.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
    sh.addEventListener("touchend", (e) => { if (y0 != null && e.changedTouches[0].clientY - y0 > 90) close(); y0 = null; }, { passive: true });
  });

  // ---------------------------------------------------------------- Filter-UI
  function syncFilterUI() {
    $("#f-region").value = filter.region;
    document.querySelectorAll("#f-type .chip").forEach((b) => b.classList.toggle("on", filter.types.includes(b.dataset.v)));
    document.querySelectorAll("#f-infra .chip").forEach((b) => b.classList.toggle("on", filter.infra.includes(b.dataset.v)));
    document.querySelectorAll("#f-rating button").forEach((b) => b.classList.toggle("on", +b.dataset.v === filter.rating));
    document.querySelectorAll("#f-age button").forEach((b) => b.classList.toggle("on", +b.dataset.v === filter.age));
    $("#f-no4wd").checked = filter.no4wd;
    $("#f-exact").checked = filter.exact;
    $("#f-safe").checked = filter.safe;
    $("#search").value = filter.q;
  }
  function toggleIn(arr, v) { return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]; }

  $("#f-region").onchange = (e) => { filter.region = e.target.value; render(true); };
  $("#f-type").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; filter.types = toggleIn(filter.types, b.dataset.v); syncFilterUI(); render(); };
  $("#f-infra").onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; filter.infra = toggleIn(filter.infra, b.dataset.v); syncFilterUI(); render(); };
  $("#f-rating").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; filter.rating = +b.dataset.v; syncFilterUI(); render(); };
  $("#f-age").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; filter.age = +b.dataset.v; syncFilterUI(); render(); };
  ["no4wd", "exact", "safe"].forEach((k) => ($(`#f-${k}`).onchange = (e) => { filter[k] = e.target.checked; render(); }));
  $("#search").oninput = (e) => { filter.q = e.target.value.trim(); render(); };
  $("#f-reset").onclick = () => { filter = structuredClone(DEFAULT_FILTER); syncFilterUI(); render(true); };

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
