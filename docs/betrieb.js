// Info-Sheet: Läufe (live von GitHub), Kosten (Kostenbuch) und Betriebshandbuch.
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const usd = (v) => (v < 0.01 && v > 0 ? "< 0.01" : v.toFixed(2)) + " USD";
  const dateTime = (d) => new Date(d).toLocaleString("de-CH", { dateStyle: "short", timeStyle: "short" });
  const loaded = {};
  let index = null;

  async function getJson(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }
  async function getIndex() {
    if (!index) index = await getJson("data/ziele.json").catch(() => ({ ziele: [], fixkosten: [] }));
    return index;
  }
  function repo() {
    if (index && index.repo) return index.repo;
    const owner = location.hostname.split(".")[0];
    const name = location.pathname.split("/").filter(Boolean)[0];
    return owner && name ? `${owner}/${name}` : "";
  }
  function table(head, rows, sumRow) {
    const th = head.map(([t, num]) => `<th class="${num ? "num" : ""}">${t}</th>`).join("");
    const tr = (r, cls = "") => `<tr class="${cls}">${r.map((c, i) => `<td class="${head[i][1] ? "num" : ""}">${c}</td>`).join("")}</tr>`;
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${th}</tr></thead><tbody>${rows.map((r) => tr(r)).join("")}${sumRow ? tr(sumRow, "sum") : ""}</tbody></table></div>`;
  }

  // ---------------------------------------------------------------- Tabs
  $("#info-tabs").onclick = (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) showTab(b.dataset.tab);
  };
  document.querySelectorAll("[data-reload]").forEach((b) => (b.onclick = () => { index = null; load(b.dataset.reload, true); }));

  function showTab(tab) {
    document.querySelectorAll("#info-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    document.querySelectorAll("#sheet-info .tab").forEach((t) => (t.hidden = t.dataset.tab !== tab));
    $("#sheet-info").scrollTop = 0;
    load(tab, false);
  }
  function load(tab, force) {
    if (loaded[tab] && !force) return;
    loaded[tab] = true;
    ({ laeufe: loadRuns, kosten: loadCosts, handbuch: loadHandbook }[tab] || (() => {}))();
  }

  // ---------------------------------------------------------------- Läufe
  const WORKFLOW = { "Plätze aktualisieren & Webapp veröffentlichen": "Abruf", "Anfrage aus der Webapp verarbeiten": "Anfrage" };
  const EVENT = { schedule: "nächtlich", workflow_dispatch: "manuell", push: "nach Änderung", issues: "aus der App", issue_comment: "Antwort in der App" };

  function runStatus(r) {
    if (r.status !== "completed") return `<span class="st laeuft pulse">${r.status === "queued" ? "wartet" : "läuft"}</span>`;
    if (r.conclusion === "success") return `<span class="st erledigt">erfolgreich</span>`;
    if (r.conclusion === "skipped" || r.conclusion === "cancelled") return `<span class="st neutral">${r.conclusion === "skipped" ? "übersprungen" : "abgebrochen"}</span>`;
    return `<span class="st fehler">Fehler</span>`;
  }
  function duration(r) {
    const end = r.status === "completed" ? new Date(r.updated_at) : new Date();
    const min = Math.round((end - new Date(r.run_started_at || r.created_at)) / 60000);
    return min < 1 ? "< 1 Min." : `${min} Min.`;
  }

  async function loadRuns() {
    await getIndex();
    $("#runs").innerHTML = `<p class="muted">lädt …</p>`;
    try {
      if (!repo()) throw new Error("kein Repository");
      const r = await fetch(`https://api.github.com/repos/${repo()}/actions/runs?per_page=12`);
      if (!r.ok) throw new Error(r.status);
      const runs = (await r.json()).workflow_runs || [];
      $("#runs").innerHTML = runs.map((x) => `
        <a class="run" href="${esc(x.html_url)}" target="_blank" rel="noopener">
          ${runStatus(x)}
          <div><div class="rt">${esc(WORKFLOW[x.name] || x.name)} · ${esc(EVENT[x.event] || x.event)}</div>
          <div class="rs">${dateTime(x.run_started_at || x.created_at)} · ${duration(x)}</div></div>
        </a>`).join("") || `<p class="muted">Noch keine Läufe.</p>`;
    } catch {
      $("#runs").innerHTML = `<p class="muted">Läufe nicht abrufbar (offline oder GitHub-Limit von 60 Abfragen pro Stunde).</p>`;
    }

    $("#ziel-status").innerHTML = index.ziele.map((z) => {
      const l = z.last;
      if (!l) return `<div class="zs"><strong>${esc(z.name)}</strong> <span class="muted">· noch kein Abruf</span></div>`;
      const t = l.transcripts || {};
      return `<div class="zs"><strong>${esc(z.name)}</strong> <span class="muted">· ${dateTime(l.date)}</span>
        <div class="kpis">
          <div class="kpi"><b>${l.videos}</b><span>Videos ausgewertet, ${z.queue} warten</span></div>
          <div class="kpi"><b>${l.spots_new}</b><span>neue Plätze, ${z.spots} total</span></div>
          <div class="kpi"><b>${t.ok || 0} / ${l.videos}</b><span>Transkripte ok, ${t.blockiert || 0} blockiert</span></div>
          <div class="kpi"><b>${usd(l.cost_usd || 0)}</b><span>Claude, ${(l.youtube_units || 0).toLocaleString("de-CH")} YouTube-Einheiten</span></div>
        </div></div>`;
    }).join("") + `<p class="muted">Modell für die Auswertung: ${esc(index.model || "–")}. Automatischer Abruf täglich um 03:17 UTC (04:17 Winterzeit, 05:17 Sommerzeit).</p>`;
  }

  // ---------------------------------------------------------------- Kosten
  function monthsBetween(from, to) {
    const out = [];
    let [y, m] = from.split("-").map(Number);
    const [ty, tm] = to.split("-").map(Number);
    while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } }
    return out;
  }

  async function loadCosts() {
    await getIndex();
    $("#kosten").innerHTML = `<p class="muted">lädt …</p>`;
    const ledger = await getJson("data/kosten.json").catch(() => []);
    const now = new Date().toISOString().slice(0, 7);
    const fix = index.fixkosten || [];
    const first = [...ledger.map((e) => e.date.slice(0, 7)), ...fix.map((f) => f.seit)].sort()[0] || now;
    const months = monthsBetween(first, now);

    const byMonth = Object.fromEntries(months.map((m) => [m, { claude: 0, fix: 0 }]));
    for (const e of ledger) { const m = e.date.slice(0, 7); if (byMonth[m]) byMonth[m].claude += e.usd; }
    for (const f of fix) for (const m of months) if (m >= f.seit) byMonth[m].fix += f.usd_pro_monat;

    const claudeTotal = ledger.reduce((s, e) => s + e.usd, 0);
    const fixTotal = Object.values(byMonth).reduce((s, v) => s + v.fix, 0);
    const thisMonth = byMonth[now] || { claude: 0, fix: 0 };
    const today = new Date().toISOString().slice(0, 10);
    const unitsToday = ledger.filter((e) => e.date.startsWith(today)).reduce((s, e) => s + (e.youtube_units || 0), 0);

    const kind = { abruf: "Abrufe (Haiku)", anfrage: "Anfragen aus der App", vergleich: "Modellvergleiche" };
    const byKind = {};
    for (const e of ledger) {
      const k = kind[e.kind] || e.kind;
      byKind[k] = byKind[k] || { n: 0, videos: 0, usd: 0 };
      byKind[k].n++; byKind[k].videos += e.videos || 0; byKind[k].usd += e.usd;
    }

    $("#kosten").innerHTML = `
      <div class="kpis">
        <div class="kpi"><b>${usd(thisMonth.claude + thisMonth.fix)}</b><span>dieser Monat</span></div>
        <div class="kpi"><b>${usd(claudeTotal + fixTotal)}</b><span>total seit ${esc(first)}</span></div>
      </div>
      <h4>Nach Plattform</h4>
      ${table([["Plattform"], ["Wofür"], ["Total", true]], [
        ["Anthropic", "Claude: Videos auswerten, Anfragen", usd(claudeTotal)],
        ...fix.map((f) => [esc(f.plattform), `${esc(f.name)}, ${f.usd_pro_monat.toFixed(2)} USD/Monat`, usd(months.filter((m) => m >= f.seit).length * f.usd_pro_monat)]),
        ["Google Cloud", `YouTube-Schnittstelle, heute ${unitsToday.toLocaleString("de-CH")} von ${(index.youtube_budget || 10000).toLocaleString("de-CH")} Einheiten`, usd(0)],
        ["GitHub", "Abläufe, Webapp, Speicher", usd(0)],
        ["OpenStreetMap / OSRM", "Koordinaten, Routen, Karte", usd(0)],
      ], ["<strong>Total</strong>", "", usd(claudeTotal + fixTotal)])}
      <h4>Nach Monat</h4>
      ${table([["Monat"], ["Claude", true], ["Fixkosten", true], ["Total", true]],
        months.slice().reverse().map((m) => [m, usd(byMonth[m].claude), usd(byMonth[m].fix), usd(byMonth[m].claude + byMonth[m].fix)]))}
      <h4>Claude nach Verwendung</h4>
      ${table([["Art"], ["Läufe", true], ["Videos", true], ["Kosten", true]],
        Object.entries(byKind).map(([k, v]) => [esc(k), v.n, v.videos || "–", usd(v.usd)]))}
      <p class="muted">Die Claude-Kosten sind aus den verbrauchten Tokens und dem Listenpreis berechnet. Massgebend ist die Abrechnung in der
        <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener">Anthropic Console</a>.
        Webshare ist als Abo erfasst, das Datenvolumen sehen Sie im
        <a href="https://dashboard.webshare.io" target="_blank" rel="noopener">Webshare-Dashboard</a>.</p>
      ${ledger.length ? "" : `<p class="muted">Das Kostenbuch füllt sich ab dem nächsten Lauf.</p>`}`;
  }

  // ---------------------------------------------------------------- Handbuch
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  async function loadHandbook() {
    try {
      await getIndex();
      let r = await fetch("handbuch.md", { cache: "no-cache" });
      if (!r.ok && repo()) r = await fetch(`https://raw.githubusercontent.com/${repo()}/main/BETRIEB.md`);
      if (!r.ok) throw new Error(r.status);
      const text = await r.text();
      if (!window.marked) await loadScript("https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js");
      $("#handbuch").innerHTML = window.marked.parse(text);
      $("#handbuch").querySelectorAll("a[href]").forEach((a) => {
        const href = a.getAttribute("href");
        if (/^https?:/.test(href)) { a.target = "_blank"; a.rel = "noopener"; }
        else if (repo()) { a.href = `https://github.com/${repo()}/blob/main/${href}`; a.target = "_blank"; a.rel = "noopener"; }
      });
    } catch {
      loaded.handbuch = false;
      $("#handbuch").innerHTML = `<p class="muted">Handbuch nicht abrufbar (offline?).</p>`;
    }
  }

  $("#btn-info").addEventListener("click", () => {
    const active = document.querySelector("#info-tabs button.on");
    if (active && active.dataset.tab !== "info") load(active.dataset.tab, true);
  });
})();
