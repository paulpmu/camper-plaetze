// Fotos & Umgebung eines Platzes: Strassenbilder, Fotos aus der Nähe und bekannte Orte.
// Offene Quellen ohne Schlüssel: Wikimedia Commons, Wikipedia, Panoramax.
// Optional: Mapillary-Vorschaubilder mit eigenem (gratis) Client-Token; sonst Link.
// Google Street View lässt sich ohne kostenpflichtigen Schlüssel nicht einbetten -> Link öffnet Google Maps.
window.FOTOS = (() => {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TTL = 24 * 3600 * 1000;
  const KEY_MAPILLARY = "mapillary-token";

  function cacheGet(k) {
    try { const e = JSON.parse(sessionStorage.getItem("ft:" + k) || "null"); if (e && Date.now() - e.t < TTL) return e.v; } catch { /* privat */ }
    return null;
  }
  function cacheSet(k, v) { try { sessionStorage.setItem("ft:" + k, JSON.stringify({ t: Date.now(), v })); } catch { /* voll */ } }
  async function getJson(url) {
    const hit = cacheGet(url);
    if (hit) return hit;
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    cacheSet(url, d);
    return d;
  }
  function distM(lat1, lng1, lat2, lng2) {
    const R = 6371000, r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
  const jahr = (d) => (d ? String(d).slice(0, 4) : "");
  const token = () => { try { return localStorage.getItem(KEY_MAPILLARY) || ""; } catch { return ""; } };

  // ---------------------------------------------------------------- Quellen
  // Strassenbilder Panoramax (offen, föderiert; Abdeckung vor allem Frankreich, wächst)
  async function panoramax(lat, lng) {
    const dLat = 0.0018, dLng = 0.0018 / Math.cos(lat * Math.PI / 180); // ~200 m
    const d = await getJson(`https://api.panoramax.xyz/api/search?bbox=${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat}&limit=12`);
    return (d.features || []).map((f) => {
      const [x, y] = f.geometry?.coordinates || [lng, lat];
      return {
        quelle: "Panoramax", art: "Strasse", thumb: f.assets?.thumb?.href, gross: f.assets?.sd?.href || f.assets?.hd?.href || f.assets?.thumb?.href,
        link: `https://api.panoramax.xyz/#focus=pic&pic=${f.id}`, linkText: "In Panoramax ansehen (360°, weitergehen)",
        titel: `Strassenbild ${jahr(f.properties?.datetime)}`, dist: distM(lat, lng, y, x), lizenz: f.properties?.license || "CC BY-SA",
      };
    }).filter((x) => x.thumb && x.dist <= 400).sort((a, b) => a.dist - b.dist).slice(0, 6);
  }

  // Strassenbilder Mapillary (nur mit eigenem Client-Token)
  async function mapillary(lat, lng) {
    const t = token();
    if (!t) return [];
    const dLat = 0.0015, dLng = 0.0015 / Math.cos(lat * Math.PI / 180);
    const d = await getJson(`https://graph.mapillary.com/images?access_token=${encodeURIComponent(t)}&fields=id,thumb_256_url,thumb_1024_url,captured_at,geometry&bbox=${lng - dLng},${lat - dLat},${lng + dLng},${lat + dLat}&limit=20`);
    return (d.data || []).map((x) => ({
      quelle: "Mapillary", art: "Strasse", thumb: x.thumb_256_url, gross: x.thumb_1024_url || x.thumb_256_url,
      link: `https://www.mapillary.com/app/?pKey=${x.id}`, linkText: "In Mapillary ansehen (weitergehen)",
      titel: `Strassenbild ${x.captured_at ? new Date(x.captured_at).getFullYear() : ""}`,
      dist: x.geometry ? distM(lat, lng, x.geometry.coordinates[1], x.geometry.coordinates[0]) : 0, lizenz: "CC BY-SA",
    })).sort((a, b) => a.dist - b.dist).slice(0, 6);
  }

  // Fotos mit Standort von Wikimedia Commons (frei lizenziert)
  async function commons(lat, lng) {
    const d = await getJson("https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=geosearch" +
      `&ggscoord=${lat}%7C${lng}&ggsradius=1500&ggslimit=24&ggsnamespace=6&prop=imageinfo%7Ccoordinates&iiprop=url%7Cextmetadata&iiurlwidth=320`);
    return Object.values(d.query?.pages || {}).map((p) => {
      const ii = (p.imageinfo || [])[0] || {}, c = (p.coordinates || [])[0];
      const meta = ii.extmetadata || {};
      return {
        quelle: "Wikimedia Commons", art: "Foto", thumb: ii.thumburl, gross: (ii.thumburl || "").replace(/\/\d+px-/, "/1280px-"),
        link: ii.descriptionurl, linkText: "Original, Urheber und Lizenz",
        titel: (meta.ObjectName?.value || p.title.replace(/^File:|^Datei:/, "").replace(/\.\w+$/, "")).replace(/<[^>]+>/g, "").slice(0, 80),
        dist: c ? distM(lat, lng, c.lat, c.lon) : 0, lizenz: (meta.LicenseShortName?.value || "").replace(/<[^>]+>/g, ""),
      };
    }).filter((x) => x.thumb && !/\.(svg|pdf|tif)/i.test(x.thumb)).sort((a, b) => a.dist - b.dist).slice(0, 10);
  }

  // Bekannte Orte in der Nähe (Wikipedia, Deutsch mit Englisch als Ergänzung)
  async function wikipedia(lat, lng) {
    const hole = async (lang) => {
      const d = await getJson(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&list=geosearch&gscoord=${lat}%7C${lng}&gsradius=5000&gslimit=10`);
      return (d.query?.geosearch || []).map((x) => ({ titel: x.title, dist: x.dist, link: `https://${lang}.wikipedia.org/?curid=${x.pageid}`, lang }));
    };
    let liste = await hole("de").catch(() => []);
    if (liste.length < 5) {
      const en = await hole("en").catch(() => []);
      const da = new Set(liste.map((x) => x.titel));
      liste = liste.concat(en.filter((x) => !da.has(x.titel)));
    }
    return liste.sort((a, b) => a.dist - b.dist).slice(0, 10);
  }

  // ---------------------------------------------------------------- Laden (einmal pro Ort)
  const laufend = new Map();
  function laden(lat, lng) {
    const k = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (!laufend.has(k)) {
      laufend.set(k, Promise.allSettled([mapillary(lat, lng), panoramax(lat, lng), commons(lat, lng), wikipedia(lat, lng)]).then(([m, p, c, w]) => ({
        bilder: [...(m.value || []), ...(p.value || []), ...(c.value || [])],
        wiki: w.value || [],
        fehler: [p, c].every((x) => x.status === "rejected"),
      })));
    }
    return laufend.get(k);
  }

  // ---------------------------------------------------------------- Bildbetrachter in der App
  function zeigen(bilder, start = 0) {
    if (!bilder.length) return;
    let i = start;
    let box = document.getElementById("ft-lightbox");
    if (!box) {
      box = document.createElement("div");
      box.id = "ft-lightbox";
      box.innerHTML = `<button class="ft-x" aria-label="Schliessen">✕</button>
        <button class="ft-nav ft-prev" aria-label="Vorheriges Bild">‹</button><button class="ft-nav ft-next" aria-label="Nächstes Bild">›</button>
        <img alt=""><div class="ft-cap"></div>`;
      document.body.appendChild(box);
    }
    const img = box.querySelector("img"), cap = box.querySelector(".ft-cap");
    const zeichne = () => {
      const f = bilder[i];
      img.src = f.gross || f.thumb;
      img.onerror = () => { if (img.src !== f.thumb) img.src = f.thumb; };
      cap.innerHTML = `<b>${esc(f.titel)}</b> · ${esc(f.quelle)}${f.lizenz ? " · " + esc(f.lizenz) : ""}${f.dist != null ? ` · ${fmtDist(f.dist)} vom Platz` : ""} · ${i + 1}/${bilder.length}<br>
        ${f.aktion ? `<button class="linkbtn ft-aktion">${esc(f.aktion.text)}</button>` : `<a href="${esc(f.link)}" target="_blank" rel="noopener">${esc(f.linkText || "Original öffnen")}</a>`}`;
      if (f.aktion) cap.querySelector(".ft-aktion").onclick = () => f.aktion.fn(f, () => { box.hidden = true; img.src = ""; });
      box.querySelector(".ft-prev").hidden = i === 0;
      box.querySelector(".ft-next").hidden = i === bilder.length - 1;
    };
    const weiter = (d) => { i = Math.max(0, Math.min(bilder.length - 1, i + d)); zeichne(); };
    box.querySelector(".ft-x").onclick = () => { box.hidden = true; img.src = ""; };
    box.querySelector(".ft-prev").onclick = () => weiter(-1);
    box.querySelector(".ft-next").onclick = () => weiter(1);
    let x0 = null;
    box.ontouchstart = (e) => { x0 = e.touches[0].clientX; };
    box.ontouchend = (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50) weiter(dx < 0 ? 1 : -1); x0 = null; };
    box.hidden = false;
    zeichne();
  }

  // Bilderleiste direkt unter dem Platznamen
  async function leiste(el, lat, lng) {
    el.innerHTML = `<span class="muted">Fotos werden gesucht …</span>`;
    const r = await laden(lat, lng);
    if (!r.bilder.length) {
      el.innerHTML = `<span class="muted">${r.fehler ? "Fotos zurzeit nicht abrufbar." : "Keine offenen Fotos in der Nähe."} Tipp: «Street View» oben antippen.</span>`;
      return 0;
    }
    el.innerHTML = r.bilder.map((f, i) => kachel(f, i)).join("");
    el.onclick = (e) => { const a = e.target.closest("[data-i]"); if (!a) return; e.preventDefault(); zeigen(r.bilder, +a.dataset.i); };
    return r.bilder.length;
  }

  // Schnellzugriff: Street View, Fotos, Satellit
  function schnell(lat, lng) {
    const [sv, sat] = links(lat, lng);
    return `<div class="quick">
      <a class="qbtn" href="${esc(sv[1])}" target="_blank" rel="noopener"><span>🛣️</span>Street View</a>
      <button class="qbtn" data-q="fotos"><span>📷</span>Fotos</button>
      <button class="qbtn" data-q="wetter"><span>☀️</span>Wetter</button>
      <a class="qbtn" href="${esc(sat[1])}" target="_blank" rel="noopener"><span>🛰️</span>Satellit</a>
    </div>`;
  }
  async function fotosZeigen(lat, lng) {
    const r = await laden(lat, lng);
    if (r.bilder.length) zeigen(r.bilder, 0);
    else window.toast?.("Keine offenen Fotos in der Nähe – Street View öffnet Google Maps.");
  }

  // ---------------------------------------------------------------- Links
  function links(lat, lng) {
    const ll = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    return [
      ["Google Street View", `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll}`],
      ["Google Satellit", `https://www.google.com/maps/@?api=1&map_action=map&center=${ll}&zoom=18&basemap=satellite`],
      ["Mapillary", `https://www.mapillary.com/app/?lat=${lat}&lng=${lng}&z=17`],
      ["Panoramax", `https://api.panoramax.xyz/#focus=map&map=17/${lat}/${lng}`],
    ];
  }

  function kachel(f, i) {
    return `<a class="ft-tile" href="${esc(f.link)}" data-i="${i}" title="${esc(f.titel)} · ${esc(f.quelle)} ${esc(f.lizenz)}">
      <img src="${esc(f.thumb)}" alt="${esc(f.titel)}" loading="lazy" referrerpolicy="no-referrer">
      <span>${esc(f.art === "Strasse" ? "Strasse" : "Foto")} · ${fmtDist(f.dist)}</span></a>`;
  }

  // ---------------------------------------------------------------- Abschnitt «Umgebung» weiter unten im Platz
  async function detail(el, lat, lng) {
    el.innerHTML = `<h4>Umgebung</h4>
      <div class="ft-links">${links(lat, lng).map(([n, u]) => `<a class="btn ghost small" href="${esc(u)}" target="_blank" rel="noopener">${esc(n)}</a>`).join("")}</div>
      <div data-wiki><span class="muted">Orte werden gesucht …</span></div>
      <p class="muted ft-quellen">Strassenbilder: Panoramax${token() ? ", Mapillary" : ""} · Fotos: Wikimedia Commons · Orte: Wikipedia.
        <button class="linkbtn" data-mly>${token() ? "Mapillary-Token ändern" : "Mehr Strassenbilder: Mapillary einschalten"}</button></p>`;
    el.querySelector("[data-mly]").onclick = () => {
      const t = prompt("Mapillary-Client-Token (gratis: mapillary.com → Dashboard → Developers → Register application → «Client Token» kopieren). Leer lassen zum Entfernen:", token());
      if (t === null) return;
      try { t.trim() ? localStorage.setItem(KEY_MAPILLARY, t.trim()) : localStorage.removeItem(KEY_MAPILLARY); } catch { /* privat */ }
      laufend.clear();
      window.toast?.("Gespeichert. Platz neu öffnen, um Mapillary-Bilder zu sehen.");
    };
    const w = (await laden(lat, lng)).wiki;
    el.querySelector("[data-wiki]").innerHTML = w.length
      ? `<details class="ft-wiki" open><summary>Bekannte Orte in der Nähe (${w.length})</summary><ul class="plain">${w.map((x) =>
          `<li><a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.titel)}</a> <span class="muted">· ${fmtDist(x.dist)}${x.lang !== "de" ? " · " + x.lang : ""}</span></li>`).join("")}</ul></details>`
      : `<span class="muted">Keine Wikipedia-Orte im Umkreis von 5 km.</span>`;
  }

  return { detail, leiste, schnell, fotosZeigen, zeigen, laden, links, panoramax, commons, wikipedia, mapillary, distM };
})();
