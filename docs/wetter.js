// Wetter für Plätze, Etappen und Regionen – direkt im Browser über Open-Meteo (gratis, ohne Schlüssel).
// Wetternote 1–10 für die Tageszeit 08–17 Uhr, gleiche Formeln wie im Werkzeug «wetter-check»:
// Regen 35 %, tiefe Wolken/Hochnebel 25 %, Gesamtbewölkung 15 %, Nebel 10 %, Sonne 15 %.
window.WETTER = (() => {
  "use strict";

  const API = "https://api.open-meteo.com/v1/forecast";
  const ENS = "https://ensemble-api.open-meteo.com/v1/ensemble";
  const MODELLE = ["ecmwf_ifs025", "icon_seamless", "gfs_seamless"];
  const MODELL_NAME = { ecmwf_ifs025: "ECMWF", icon_seamless: "ICON", gfs_seamless: "GFS" };
  const STUFEN = [1000, 975, 950, 925, 900, 850, 800, 700];
  const TAG_VON = 8, TAG_BIS = 17;
  const GEWICHTE = { regen: 0.35, tief: 0.25, gesamt: 0.15, nebel: 0.10, sonne: 0.15 };
  const TTL = 3 * 3600 * 1000; // Zwischenspeicher 3 Stunden
  const WT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

  // ------------------------------------------------------------ Zwischenspeicher
  const mem = new Map();
  function cacheGet(key) {
    const m = mem.get(key);
    if (m && Date.now() - m.t < TTL) return m.v;
    try {
      const s = JSON.parse(sessionStorage.getItem("wx:" + key) || "null");
      if (s && Date.now() - s.t < TTL) { mem.set(key, s); return s.v; }
    } catch { /* privater Modus */ }
    return null;
  }
  function cacheSet(key, v) {
    const e = { t: Date.now(), v };
    mem.set(key, e);
    try { sessionStorage.setItem("wx:" + key, JSON.stringify(e)); } catch { /* voll oder privat */ }
  }
  async function getJson(url) {
    const hit = cacheGet(url);
    if (hit) return hit;
    let letzter;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url);
        if (r.status === 429 || r.status >= 500) throw new Error("Wetterdienst " + r.status);
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.reason || "Wetterdienst " + r.status);
        cacheSet(url, d);
        return d;
      } catch (e) { letzter = e; await new Promise((res) => setTimeout(res, 800 * (i + 1))); }
    }
    throw letzter;
  }
  const rund = (x) => Math.round(x * 100) / 100; // ~1 km, damit benachbarte Plätze den Speicher teilen

  // ------------------------------------------------------------ Bewertung
  const clip = (x) => Math.max(1, Math.min(10, x));
  function teilnoten(t) {
    const n = {};
    if (t.regen != null) {
      n.regen = clip(10 - 1.2 * t.regen);
      if (t.wkeit != null) n.regen = Math.min(n.regen, clip(10 - Math.max(0, t.wkeit - 30) / 7));
    }
    if (t.tief != null) n.tief = clip(10 - (t.tief - 10) / 6);
    if (t.gesamt != null) n.gesamt = clip(10 - (t.gesamt - 30) / 7.5);
    if (t.nebel != null) n.nebel = clip(10 - 1.5 * t.nebel);
    if (t.sonne != null && t.stunden) n.sonne = clip(t.sonne * 10 / (0.85 * t.stunden));
    return n;
  }
  function note(t) {
    const n = teilnoten(t), k = Object.keys(n);
    if (!k.length) return null;
    const sum = k.reduce((a, x) => a + GEWICHTE[x], 0);
    return k.reduce((a, x) => a + GEWICHTE[x] * n[x], 0) / sum;
  }
  const mittel = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const klasse = (n) => (n == null ? "na" : n >= 8 ? "n5" : n >= 6.5 ? "n4" : n >= 5 ? "n3" : n >= 3.5 ? "n2" : "n1");
  const farbe = (n) => ({ n5: "#2e8b57", n4: "#8fbc3f", n3: "#e0b100", n2: "#e67e22", n1: "#c0392b", na: "#999" })[klasse(n)];

  // Stundenwerte einer Quelle -> Tageswerte (nur Tageszeit)
  function tageswerte(h, suffix = "") {
    const g = (f) => h[f + suffix];
    const tage = new Map();
    h.time.forEach((ts, i) => {
      const std = +ts.slice(11, 13);
      if (std < TAG_VON || std >= TAG_BIS) return;
      const regen = g("precipitation")?.[i];
      const gesamt = g("cloud_cover")?.[i];
      if (regen == null && gesamt == null) return;
      const d = ts.slice(0, 10);
      if (!tage.has(d)) tage.set(d, { datum: d, stunden: 0, regen: 0, wk: [], ges: [], tief: [], sonne: 0, sonneDa: false, sicht: [] });
      const t = tage.get(d);
      t.stunden++;
      t.regen += regen || 0;
      const w = g("precipitation_probability")?.[i]; if (w != null) t.wk.push(w);
      if (gesamt != null) t.ges.push(gesamt);
      const ti = g("cloud_cover_low")?.[i]; if (ti != null) t.tief.push(ti);
      const so = g("sunshine_duration")?.[i]; if (so != null) { t.sonne += so / 3600; t.sonneDa = true; }
      const si = g("visibility")?.[i]; if (si != null) t.sicht.push(si);
    });
    return [...tage.values()].filter((t) => t.stunden >= 6).map((t) => {
      const r = {
        datum: t.datum, stunden: t.stunden, regen: t.regen, wkeit: t.wk.length ? Math.max(...t.wk) : null,
        gesamt: mittel(t.ges), tief: mittel(t.tief), sonne: t.sonneDa ? t.sonne : null,
        nebel: t.sicht.length ? t.sicht.filter((v) => v < 1000).length : null,
      };
      r.note = note(r);
      return r;
    });
  }

  // ------------------------------------------------------------ Ensemble (Wahrscheinlichkeiten)
  function ensembleTage(h) {
    const laeufe = Object.keys(h).filter((k) => k.startsWith("precipitation")).map((k) => k.replace("precipitation", ""));
    const tage = new Map();
    for (const l of laeufe) {
      const regen = h["precipitation" + l], sonne = h["sunshine_duration" + l];
      const proTag = new Map();
      h.time.forEach((ts, i) => {
        const std = +ts.slice(11, 13);
        if (std < TAG_VON || std >= TAG_BIS || regen[i] == null) return;
        const d = ts.slice(0, 10);
        const z = proTag.get(d) || { r: 0, s: 0, n: 0 };
        z.r += regen[i]; z.s += (sonne?.[i] || 0) / 3600; z.n++;
        proTag.set(d, z);
      });
      for (const [d, z] of proTag) {
        if (z.n < 6) continue;
        if (!tage.has(d)) tage.set(d, []);
        tage.get(d).push(z);
      }
    }
    const out = {};
    for (const [d, l] of tage) {
      if (l.length < 5) continue;
      out[d] = {
        laeufe: l.length,
        trocken: 100 * l.filter((z) => z.r < 1).length / l.length,
        sonnig: 100 * l.filter((z) => z.s >= 0.5 * z.n).length / l.length,
      };
    }
    return out;
  }

  // ------------------------------------------------------------ Nebel / Hochnebel
  function inversion(st) {
    const profil = [];
    if (st.bodenT != null) profil.push([st.hoehe, st.bodenT, st.bodenRh]);
    for (const p of STUFEN) {
      const t = st.t[p], z = st.z[p];
      if (t != null && z != null && z > st.hoehe + 20) profil.push([z, t, st.rh[p]]);
    }
    profil.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < profil.length - 1; i++) {
      const [z1, t1, rh1] = profil[i], [z2, t2] = profil[i + 1];
      if (z1 > st.hoehe + 2500) break;
      if (t2 - t1 >= 0.5) return { grenze: z1 > st.hoehe + 50 ? z1 : (z1 + z2) / 2, feucht: rh1 != null && rh1 >= 90 };
    }
    return null;
  }
  function nebelTage(d) {
    const h = d.hourly, hoehe = d.elevation ?? 0, out = {};
    h.time.forEach((ts, i) => {
      const std = +ts.slice(11, 13);
      if (std < 6 || std >= 12) return;
      const st = { hoehe, bodenT: h.temperature_2m[i], bodenRh: h.relative_humidity_2m[i], t: {}, rh: {}, z: {} };
      for (const p of STUFEN) { st.t[p] = h[`temperature_${p}hPa`]?.[i]; st.rh[p] = h[`relative_humidity_${p}hPa`]?.[i]; st.z[p] = h[`geopotential_height_${p}hPa`]?.[i]; }
      const inv = inversion(st), tief = h.cloud_cover_low[i] ?? 0;
      const dd = ts.slice(0, 10);
      out[dd] = out[dd] || { stunden: 0, grenzen: [] };
      if (inv && inv.feucht && tief >= 60) { out[dd].stunden++; out[dd].grenzen.push(inv.grenze); }
    });
    for (const [dd, z] of Object.entries(out)) {
      const g = z.grenzen.sort((a, b) => a - b)[Math.floor(z.grenzen.length / 2)];
      let text = "";
      if (z.stunden >= 3 && g) {
        if (hoehe < g - 50) text = `Hochnebel am Morgen, Platz liegt darin; über ~${Math.round((g + 200) / 100) * 100} m meist sonnig`;
        else if (hoehe > g + 150) text = `Nebelmeer unterhalb (~${Math.round(g / 100) * 100} m), Platz darüber`;
        else text = `Platz nahe der Nebelobergrenze (~${Math.round(g / 100) * 100} m)`;
      } else if (z.stunden >= 1) text = "zeitweise Hochnebel möglich";
      out[dd] = { stunden: z.stunden, grenze: g ?? null, text };
    }
    return out;
  }

  // ------------------------------------------------------------ Abfragen
  const STUNDEN = "sunshine_duration,precipitation,precipitation_probability,cloud_cover,cloud_cover_low,visibility";

  // Ausführliche Prognose für einen Ort: drei Modelle, Ensemble, Nebel
  async function ort(lat, lng) {
    lat = rund(lat); lng = rund(lng);
    const nebelFelder = ["temperature_2m", "relative_humidity_2m", "cloud_cover_low",
      ...STUFEN.flatMap((p) => [`temperature_${p}hPa`, `relative_humidity_${p}hPa`, `geopotential_height_${p}hPa`])].join(",");
    const [haupt, ens, neb] = await Promise.allSettled([
      getJson(`${API}?latitude=${lat}&longitude=${lng}&hourly=${STUNDEN}&models=${MODELLE.join(",")}&daily=sunrise,sunset&timezone=auto&forecast_days=8`),
      getJson(`${ENS}?latitude=${lat}&longitude=${lng}&hourly=precipitation,sunshine_duration&models=ecmwf_ifs025&timezone=auto&forecast_days=8`),
      getJson(`${API}?latitude=${lat}&longitude=${lng}&hourly=${nebelFelder}&models=icon_seamless&timezone=auto&forecast_days=7`),
    ]);
    if (haupt.status !== "fulfilled") throw haupt.reason;
    const d = haupt.value;
    const proModell = {};
    for (const m of MODELLE) proModell[m] = tageswerte(d.hourly, "_" + m);
    const daten = [...new Set(Object.values(proModell).flat().map((t) => t.datum))].sort();
    const dly = d.daily || {};
    const sonnenuntergang = {};
    const ssKey = Object.keys(dly).find((k) => k.startsWith("sunset"));
    (dly.time || []).forEach((t, i) => { if (ssKey && dly[ssKey][i]) sonnenuntergang[t] = dly[ssKey][i].slice(11, 16); });
    const ensTage = ens.status === "fulfilled" ? ensembleTage(ens.value.hourly) : {};
    const nebTage = neb.status === "fulfilled" ? nebelTage(neb.value) : {};
    const tage = daten.map((datum) => {
      const werte = MODELLE.map((m) => proModell[m].find((t) => t.datum === datum)).filter(Boolean);
      const noten = werte.map((t) => t.note).filter((n) => n != null);
      return {
        datum, note: mittel(noten), streuung: noten.length > 1 ? Math.max(...noten) - Math.min(...noten) : null,
        sonne: mittel(werte.map((t) => t.sonne).filter((x) => x != null)),
        regen: mittel(werte.map((t) => t.regen)),
        modelle: Object.fromEntries(MODELLE.map((m) => [m, proModell[m].find((t) => t.datum === datum)?.note ?? null])),
        ens: ensTage[datum] || null, nebel: nebTage[datum] || null, sonnenuntergang: sonnenuntergang[datum] || null,
      };
    });
    return { hoehe: d.elevation, tage, ensemble: ens.status === "fulfilled" };
  }

  // Schnelle Tagesnoten für viele Punkte (ECMWF, eine Abfrage pro 50 Punkte)
  async function viele(punkte) {
    const out = [];
    for (let i = 0; i < punkte.length; i += 50) {
      const teil = punkte.slice(i, i + 50);
      const url = `${API}?latitude=${teil.map((p) => rund(p[0])).join(",")}&longitude=${teil.map((p) => rund(p[1])).join(",")}` +
        `&hourly=${STUNDEN}&models=ecmwf_ifs025&timezone=auto&forecast_days=8`;
      let d = await getJson(url);
      if (!Array.isArray(d)) d = [d];
      d.forEach((x) => out.push(tageswerte(x.hourly)));
    }
    return out;
  }

  // ------------------------------------------------------------ Darstellung
  const fmt = (x, n = 0) => (x == null ? "–" : x.toFixed(n));
  function tagLabel(datum, heute = new Date()) {
    const d = new Date(datum + "T12:00:00");
    const mittag = new Date(heute.getFullYear(), heute.getMonth(), heute.getDate(), 12);
    const diff = Math.round((d - mittag) / 864e5);
    if (diff === 0) return "Heute";
    if (diff === 1) return "Morgen";
    return `${WT[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
  }
  const chip = (n) => `<span class="wx-note ${klasse(n)}">${n == null ? "–" : n.toFixed(1)}</span>`;

  function webcamLink(lat, lng) {
    return `https://www.windy.com/-Webcams/webcams?${lat.toFixed(3)},${lng.toFixed(3)},11`;
  }

  // Wetterblock im Platz-Detail
  async function detail(el, lat, lng) {
    el.innerHTML = `<h4>Wetter</h4><p class="muted">lädt …</p>`;
    try {
      const w = await ort(lat, lng);
      const nebelHinweise = w.tage.filter((t) => t.nebel && t.nebel.text).slice(0, 3);
      el.innerHTML = `
        <h4>Wetter <small class="muted">tagsüber 08–17 Uhr</small></h4>
        <div class="wx-scroll"><table class="wx">
          <tr><th></th>${w.tage.map((t) => `<th>${tagLabel(t.datum)}</th>`).join("")}</tr>
          <tr><td>Note</td>${w.tage.map((t) => `<td>${chip(t.note)}${t.streuung != null && t.streuung > 3 ? `<i class="wx-unsicher" title="Modelle uneinig">?</i>` : ""}</td>`).join("")}</tr>
          <tr><td>Sonne</td>${w.tage.map((t) => `<td>${fmt(t.sonne)} h</td>`).join("")}</tr>
          <tr><td>Regen</td>${w.tage.map((t) => `<td>${fmt(t.regen, 1)} mm</td>`).join("")}</tr>
          ${w.ensemble ? `<tr><td>trocken</td>${w.tage.map((t) => `<td>${t.ens ? fmt(t.ens.trocken) + " %" : "–"}</td>`).join("")}</tr>` : ""}
          <tr><td>Sonnen&shy;untergang</td>${w.tage.map((t) => `<td>${t.sonnenuntergang || "–"}</td>`).join("")}</tr>
        </table></div>
        ${nebelHinweise.length ? `<ul class="wx-hinweise">${nebelHinweise.map((t) => `<li><b>${tagLabel(t.datum)}:</b> ${t.nebel.text}</li>`).join("")}</ul>` : ""}
        <p class="muted">Höhe ${fmt(w.hoehe)} m · Note 1–10 aus ECMWF, ICON und GFS · «trocken» = Anteil der 51 ECMWF-Ensembleläufe mit weniger als 1 mm · ? = Modelle uneinig ·
          <a href="${webcamLink(lat, lng)}" target="_blank" rel="noopener">Webcams in der Nähe</a> · Daten: Open-Meteo</p>`;
    } catch (e) {
      el.innerHTML = `<h4>Wetter</h4><p class="muted">Wetter nicht verfügbar (${e.message || "offline"}). <a href="${webcamLink(lat, lng)}" target="_blank" rel="noopener">Webcams in der Nähe</a></p>`;
    }
  }

  return { ort, viele, detail, tagLabel, chip, klasse, farbe, webcamLink, note, inversion, ensembleTage, tageswerte, fmt };
})();
