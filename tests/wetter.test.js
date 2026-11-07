// Tests der Wetterlogik ohne Netz: node --test tests/wetter.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const vm = require("node:vm");

const ctx = { window: {}, sessionStorage: { getItem: () => null, setItem: () => {} }, fetch: () => { throw new Error("kein Netz im Test"); }, setTimeout };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + "/../docs/wetter.js", "utf8"), ctx);
const W = ctx.window.WETTER;

function stunden(werte) {
  const time = [], h = { time };
  for (let i = 0; i < 24; i++) time.push(`2026-11-08T${String(i).padStart(2, "0")}:00`);
  for (const [k, v] of Object.entries(werte)) h[k] = time.map((t, i) => (typeof v === "function" ? v(i) : v));
  return h;
}

test("Traumtag ergibt Note 10", () => {
  const h = stunden({ precipitation: 0, cloud_cover: 0, cloud_cover_low: 0, sunshine_duration: (i) => (i >= 8 && i < 17 ? 3600 : 0), visibility: 20000 });
  const t = W.tageswerte(h)[0];
  assert.strictEqual(t.stunden, 9);
  assert.ok(Math.abs(t.note - 10) < 1e-9);
});

test("Regentag mit Nebel ergibt schlechte Note", () => {
  const h = stunden({ precipitation: 1, cloud_cover: 100, cloud_cover_low: 100, sunshine_duration: 0, visibility: 500 });
  const t = W.tageswerte(h)[0];
  assert.strictEqual(t.nebel, 9);
  assert.ok(t.note < 1.5);
});

test("trocken und grau schlägt sonnig mit Regen (Regen zählt am meisten)", () => {
  const grau = W.tageswerte(stunden({ precipitation: 0, cloud_cover: 100, cloud_cover_low: 0, sunshine_duration: 0 }))[0].note;
  const nass = W.tageswerte(stunden({ precipitation: 0.8, cloud_cover: 0, cloud_cover_low: 0, sunshine_duration: 3600 }))[0].note;
  assert.ok(grau > nass);
});

test("Nebelobergrenze = Untergrenze der Inversion", () => {
  const st = { hoehe: 450, bodenT: 2, bodenRh: 98,
    t: { 1000: null, 975: 1.5, 950: 1.0, 925: 6.0, 900: 5.0, 850: 2.0, 800: -1.0, 700: -8.0 },
    rh: { 975: 97, 950: 96, 925: 40 },
    z: { 1000: 100, 975: 350, 950: 600, 925: 820, 900: 1050, 850: 1500, 800: 1950, 700: 3000 } };
  const inv = W.inversion(st);
  assert.strictEqual(inv.grenze, 600);
  assert.strictEqual(inv.feucht, true);
});

test("Ensemble: Anteil trockener Läufe", () => {
  const w = { precipitation: 0, sunshine_duration: 3600, precipitation_member01: 0.5, sunshine_duration_member01: 0 };
  for (let i = 2; i < 6; i++) { w[`precipitation_member0${i}`] = 0; w[`sunshine_duration_member0${i}`] = 3600; }
  const e = W.ensembleTage(stunden(w))["2026-11-08"];
  assert.strictEqual(e.laeufe, 6);
  assert.ok(Math.abs(e.trocken - 500 / 6) < 1e-9);
});

test("Tagesbeschriftung: heute, morgen, Wochentag", () => {
  const heute = new Date(2026, 10, 7, 9, 30);
  assert.strictEqual(W.tagLabel("2026-11-07", heute), "Heute");
  assert.strictEqual(W.tagLabel("2026-11-08", heute), "Morgen");
  assert.strictEqual(W.tagLabel("2026-11-10", heute), "Di 10.11.");
});

test("Fotos: Links und Distanzrechnung", () => {
  const c2 = { window: {}, sessionStorage: ctx.sessionStorage, localStorage: { getItem: () => null }, fetch: ctx.fetch };
  vm.createContext(c2);
  vm.runInContext(fs.readFileSync(__dirname + "/../docs/fotos.js", "utf8"), c2);
  const F = c2.window.FOTOS;
  const l = F.links(46.97905, 6.89517);
  assert.ok(l[0][1].includes("map_action=pano&viewpoint=46.979050,6.895170"));
  const d = F.distM(46.97905, 6.89517, 46.98805, 6.89517); // 0.009° Nord ≈ 1 km
  assert.ok(Math.abs(d - 1000) < 5);
});
