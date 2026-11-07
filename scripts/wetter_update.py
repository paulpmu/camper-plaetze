"""Wetterdaten für die Webapp aufbereiten (läuft alle 3 Stunden über .github/workflows/wetter.yml).

Erzeugt zwei kleine Dateien, die die Webapp direkt lädt:
- docs/data/wetter/warnungen.json: offizielle Unwetterwarnungen (MeteoAlarm, EUMETNET) für die Länder
  der Ziele, mit vereinfachten Umrissen der gewarnten Regionen. Die App ordnet einen Platz selbst zu.
- docs/data/wetter/ch.json: Tageswerte der MeteoSchweiz-Lokalprognose (08–17 Uhr) für alle Postleitzahlen
  und Bergpunkte der Schweiz, wenn ein Ziel die Schweiz berührt.

Übernommen und vereinfacht aus dem Werkzeug «wetter-check» (Module warnungen.py und meteoschweiz.py).
Nur Standardbibliothek und requests. Quellen: MeteoAlarm (CC BY 4.0), MeteoSchweiz Open Data.
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

ROOT = Path(__file__).resolve().parent.parent
ZIELE_DIR = ROOT / "ziele"
OUT_DIR = ROOT / "docs" / "data" / "wetter"
CACHE_DIR = ROOT / "data" / "wetter-cache"  # nicht im Repository (siehe .gitignore), in der Action zwischengespeichert
UA = {"User-Agent": "camper-plaetze/1.0 (https://github.com/paulpmu/camper-plaetze)"}
ZH = ZoneInfo("Europe/Zurich")


def log(*a):
    print(*a, flush=True)


def holen(url, stream=False, timeout=120):
    letzter = None
    for i in range(4):
        try:
            r = requests.get(url, headers=UA, timeout=timeout, stream=stream)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(str(r.status_code))
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            letzter = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"Abruf fehlgeschlagen: {url[:100]} ({letzter})")


def ziele():
    out = []
    for f in sorted(ZIELE_DIR.glob("*.json")):
        z = json.loads(f.read_text(encoding="utf-8"))
        if z.get("bbox"):
            out.append(z)
    return out


def ueberlappt(a, b):
    """a, b = [lat_min, lng_min, lat_max, lng_max]"""
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


def schreiben(name, daten):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / name).write_text(json.dumps(daten, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"  geschrieben: docs/data/wetter/{name} ({(OUT_DIR / name).stat().st_size // 1024} KB)")


# =============================================================== Warnungen (MeteoAlarm)
GITLAB_PROJEKT = 72863924  # gitlab.com/meteoalarm-pm-group/documents (offizielle Regionsumrisse, EMMA_ID)
FEEDS = {
    "AT": "austria", "BE": "belgium", "BA": "bosnia-herzegovina", "BG": "bulgaria", "HR": "croatia", "CY": "cyprus",
    "CZ": "czechia", "DK": "denmark", "EE": "estonia", "FI": "finland", "FR": "france", "DE": "germany", "GR": "greece",
    "HU": "hungary", "IS": "iceland", "IE": "ireland", "IT": "italy", "LV": "latvia", "LT": "lithuania",
    "LU": "luxembourg", "MT": "malta", "MD": "moldova", "ME": "montenegro", "NL": "netherlands",
    "MK": "republic-of-north-macedonia", "NO": "norway", "PL": "poland", "PT": "portugal", "RO": "romania",
    "RS": "serbia", "SK": "slovakia", "SI": "slovenia", "ES": "spain", "SE": "sweden", "CH": "switzerland",
    "UK": "united-kingdom",
}
# Länder ohne Umrisse in der MeteoAlarm-Datei: grobe Rechtecke [lat_min, lng_min, lat_max, lng_max]
LAND_BOX = {"CH": [45.8, 5.95, 47.85, 10.5], "NO": [57.9, 4.5, 71.2, 31.2], "UK": [49.8, -8.7, 60.9, 1.8],
            "SE": [55.3, 11.0, 69.1, 24.2]}
NS = {"a": "http://www.w3.org/2005/Atom", "cap": "urn:oasis:names:tc:emergency:cap:1.2"}
STUFE = {"Yellow": "gelb", "Orange": "orange", "Red": "rot"}


def umrisse():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    vorhanden = sorted(CACHE_DIR.glob("MeteoAlarm_Geocodes_*.json"))
    datei = vorhanden[-1] if vorhanden else None
    if not datei or time.time() - datei.stat().st_mtime > 30 * 86400:
        try:
            liste = holen(f"https://gitlab.com/api/v4/projects/{GITLAB_PROJEKT}/repository/tree?per_page=100").json()
            namen = sorted(f["path"] for f in liste if re.match(r"MeteoAlarm_Geocodes_\d{4}_\d{2}_\d{2}\.json$", f["path"]))
            if namen and not (CACHE_DIR / namen[-1]).exists():
                log(f"  lade Regionsumrisse {namen[-1]} …")
                r = holen(f"https://gitlab.com/api/v4/projects/{GITLAB_PROJEKT}/repository/files/{namen[-1]}/raw?ref=master", timeout=600)
                (CACHE_DIR / namen[-1]).write_bytes(r.content)
            if namen:
                datei = CACHE_DIR / namen[-1]
                datei.touch()
        except RuntimeError as e:
            log(f"  Umrisse nicht aktualisiert: {e}")
    if not datei:
        raise RuntimeError("keine Regionsumrisse verfügbar")
    out = {}
    for f in json.loads(datei.read_text(encoding="utf-8"))["features"]:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        xs = [p[0] for poly in polys for p in poly[0]]
        ys = [p[1] for poly in polys for p in poly[0]]
        out[f["properties"]["code"]] = {"name": f["properties"]["name"], "land": f["properties"]["country"],
                                        "polys": polys, "bbox": [min(ys), min(xs), max(ys), max(xs)]}
    return out


def vereinfachen(ring, tol=0.01):
    """Douglas-Peucker (Grad), Koordinaten auf 3 Stellen gerundet."""
    if len(ring) < 5:
        return [[round(x, 3), round(y, 3)] for x, y, *_ in ring]
    def dp(pts):
        (x1, y1), (x2, y2) = pts[0][:2], pts[-1][:2]
        dx, dy = x2 - x1, y2 - y1
        n = (dx * dx + dy * dy) ** 0.5 or 1e-12
        imax, dmax = 0, 0.0
        for i in range(1, len(pts) - 1):
            d = abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / n
            if d > dmax:
                imax, dmax = i, d
        if dmax > tol:
            return dp(pts[: imax + 1])[:-1] + dp(pts[imax:])
        return [pts[0], pts[-1]]
    teil = dp([p[:2] for p in ring])
    if len(teil) < 4:
        teil = [p[:2] for p in ring[:: max(1, len(ring) // 4)]] + [ring[0][:2]]
    return [[round(x, 3), round(y, 3)] for x, y in teil]


def feed(land):
    r = holen(f"https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-{FEEDS[land]}")
    wurzel = ET.fromstring(r.content)
    out = []
    for e in wurzel.findall("a:entry", NS):
        txt = lambda t: (e.findtext(f"cap:{t}", default="", namespaces=NS) or "").strip()
        codes = defaultdict(list)
        for gc in e.findall("cap:geocode", NS):
            codes[gc.findtext("a:valueName", default="", namespaces=NS)].append(gc.findtext("a:value", default="", namespaces=NS))
        out.append({"ereignis": txt("event"), "region": txt("areaDesc"), "schwere": txt("severity"),
                    "beginn": txt("onset") or txt("effective"), "ende": txt("expires"), "codes": dict(codes)})
    return out


def warnungen_erzeugen(zl):
    log("Warnungen (MeteoAlarm) …")
    flaechen = umrisse()
    boxen = [z["bbox"] for z in zl]
    laender = {f["land"] for f in flaechen.values() if any(ueberlappt(f["bbox"], b) for b in boxen)}
    laender |= {l for l, bx in LAND_BOX.items() if any(ueberlappt(bx, b) for b in boxen)}
    laender &= set(FEEDS)
    log(f"  Länder: {', '.join(sorted(laender)) or '–'}")
    jetzt = datetime.now(timezone.utc)
    namen = defaultdict(dict)  # Land -> Regionsname (klein) -> Code, für Frankreich (NUTS3 statt EMMA_ID)
    for code, f in flaechen.items():
        namen[f["land"]][f["name"].lower()] = code
    warnungen, benutzt = [], set()
    for land in sorted(laender):
        try:
            eintraege = feed(land)
        except RuntimeError as e:
            log(f"  {land}: {e}")
            continue
        for e in eintraege:
            m = re.match(r"(Yellow|Orange|Red)\s+(.*?)(\s+Warning)?$", e["ereignis"])
            stufe = STUFE.get(m.group(1)) if m else {"Moderate": "gelb", "Severe": "orange", "Extreme": "rot"}.get(e["schwere"])
            if not stufe:
                continue
            try:
                if datetime.fromisoformat(e["ende"]) < jetzt:
                    continue
            except ValueError:
                continue
            codes = [c for c in e["codes"].get("EMMA_ID", []) if c in flaechen]
            if not codes and e["region"].lower() in namen.get(land, {}):
                codes = [namen[land][e["region"].lower()]]
            benutzt.update(codes)
            warnungen.append({"land": land, "region": e["region"], "ereignis": (m.group(2) if m else e["ereignis"]).strip(),
                              "stufe": stufe, "beginn": e["beginn"], "ende": e["ende"], "codes": codes})
    # doppelte entfernen
    eindeutig = {(w["land"], w["region"], w["ereignis"], w["beginn"], w["ende"]): w for w in warnungen}
    warnungen = sorted(eindeutig.values(), key=lambda w: (w["beginn"], w["land"]))
    daten = {
        "stand": jetzt.isoformat(timespec="minutes"),
        "quelle": "MeteoAlarm (EUMETNET), CC BY 4.0",
        "laender": sorted(laender),
        "ohne_umrisse": sorted(l for l in laender if l in LAND_BOX),
        "warnungen": warnungen,
        "flaechen": {c: {"name": flaechen[c]["name"], "land": flaechen[c]["land"], "bbox": [round(v, 3) for v in flaechen[c]["bbox"]],
                         "poly": [[vereinfachen(r) for r in poly] for poly in flaechen[c]["polys"]]} for c in sorted(benutzt)},
    }
    log(f"  {len(warnungen)} aktive Warnungen, {len(benutzt)} Regionen mit Umriss")
    schreiben("warnungen.json", daten)


# =============================================================== MeteoSchweiz Lokalprognose
STAC = "https://data.geo.admin.ch/api/stac/v1/collections/ch.meteoschweiz.ogd-local-forecasting"
META_PUNKTE = "https://data.geo.admin.ch/ch.meteoschweiz.ogd-local-forecasting/ogd-local-forecasting_meta_point.csv"
PARAMETER = ["sre000h0", "rre150h0", "rp0003i0", "nprolohs", "npromths", "nprohihs"]
CH_BOX = [45.8, 5.95, 47.85, 10.5]


def neuester_lauf():
    items = holen(f"{STAC}/items?limit=100").json()["features"]
    for item in sorted(items, key=lambda f: f["id"], reverse=True):
        laeufe = defaultdict(dict)
        for name, a in item["assets"].items():
            t = name.split(".")
            if len(t) >= 4:
                laeufe[t[2]][t[3]] = a["href"]
        for lauf in sorted(laeufe, reverse=True):
            if all(p in laeufe[lauf] for p in PARAMETER):
                return lauf, laeufe[lauf]
    raise RuntimeError("kein vollständiger MeteoSchweiz-Lauf")


def meteoschweiz_erzeugen(zl):
    if not any(ueberlappt(z["bbox"], CH_BOX) for z in zl):
        log("MeteoSchweiz: kein Ziel in der Schweiz – übersprungen")
        return
    log("MeteoSchweiz Lokalprognose …")
    punkte = [p for p in csv.DictReader(io.StringIO(holen(META_PUNKTE).content.decode("latin-1")), delimiter=";")
              if p["point_type_id"] in ("2", "3")]  # Postleitzahlen und Bergpunkte
    schluessel = {(p["point_id"], p["point_type_id"]) for p in punkte}
    lauf, urls = neuester_lauf()
    # werte[(id,typ)][datum][param] = Liste der Stundenwerte 08–17 Uhr
    werte = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    for par in PARAMETER:
        log(f"  {par} …")
        r = holen(urls[par], stream=True, timeout=600)
        zeilen = r.iter_lines(decode_unicode=False)
        next(zeilen)
        for z in zeilen:
            t = z.decode("latin-1").split(";")
            if len(t) < 4 or t[3] == "" or (t[0], t[1]) not in schluessel:
                continue
            ende = datetime.strptime(t[2], "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
            beginne = [(ende - timedelta(hours=1)).astimezone(ZH)]
            if par == "rp0003i0":  # 3-h-Wert gilt für die drei vorangehenden Stunden
                beginne = [beginne[0] - timedelta(hours=i) for i in range(3)]
            for b in beginne:
                if 8 <= b.hour < 17:
                    werte[(t[0], t[1])][b.date().isoformat()][par].append(float(t[3]))
    heute = datetime.now(ZH).date().isoformat()
    tage = sorted({d for v in werte.values() for d in v if d >= heute})[:8]
    out = []
    for p in punkte:
        k = (p["point_id"], p["point_type_id"])
        if k not in werte:
            continue
        reihe = []
        for d in tage:
            w = werte[k].get(d, {})
            if len(w.get("sre000h0", [])) < 6:
                reihe.append(None)
                continue
            mittel = lambda par, f=100: round(f * sum(w[par]) / len(w[par])) if w.get(par) else None
            reihe.append([round(sum(w["sre000h0"]) / 6),            # Sonne in Zehntelstunden
                          round(10 * sum(w.get("rre150h0", [0]))),  # Regen in Zehntel-mm
                          round(max(w.get("rp0003i0", [0]))),       # Regenwahrscheinlichkeit max %
                          mittel("nprolohs"), mittel("npromths"), mittel("nprohihs"),  # Wolken tief/mittel/hoch %
                          len(w["sre000h0"])])                       # Anzahl Stunden
        out.append([p["point_name"], round(float(p["point_coordinates_wgs84_lat"]), 4),
                    round(float(p["point_coordinates_wgs84_lon"]), 4), round(float(p["point_height_masl"] or 0)), reihe])
    schreiben("ch.json", {
        "stand": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "lauf": f"{lauf[:4]}-{lauf[4:6]}-{lauf[6:8]}T{lauf[8:10]}:{lauf[10:12]}Z",
        "quelle": "MeteoSchweiz Open Data (Lokalprognose)",
        "felder": ["sonne_zehntel_h", "regen_zehntel_mm", "regen_wkeit_max", "wolken_tief", "wolken_mittel", "wolken_hoch", "stunden"],
        "tage": tage, "punkte": out,
    })


def main():
    zl = ziele()
    fehler = 0
    for schritt in (warnungen_erzeugen, meteoschweiz_erzeugen):
        try:
            schritt(zl)
        except Exception as e:  # ein Teil darf den anderen nicht verhindern
            fehler += 1
            log(f"FEHLER in {schritt.__name__}: {e}")
    sys.exit(1 if fehler == 2 else 0)


if __name__ == "__main__":
    main()
