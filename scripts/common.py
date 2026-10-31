"""Gemeinsame Bausteine: Konfiguration, Ziele, Dateien, Geodaten und Routen."""

from __future__ import annotations

import difflib
import hashlib
import json
import math
import os
import re
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
ZIELE_DIR = ROOT / "ziele"
DATA_DIR = ROOT / "data"
WEB_DATA = ROOT / "docs" / "data"
GEOCACHE_FILE = DATA_DIR / "geocache.json"
REPO = os.getenv("GITHUB_REPOSITORY", "")
UA = f"camper-plaetze/1.0 (https://github.com/{REPO or 'camper-plaetze'})"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}$")
LEDGER_FILE = WEB_DATA / "kosten.json"

# Preise pro Million Tokens (Input, Output) für das Kostenbuch
PRICES = {
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50),
}
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}


def log(*a):
    print(*a, flush=True)


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path: Path, data, compact=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = (json.dumps(data, ensure_ascii=False, separators=(",", ":")) if compact
            else json.dumps(data, ensure_ascii=False, indent=1))
    path.write_text(text + "\n", encoding="utf-8")


def load_destinations(only_active=True) -> list[dict]:
    out = []
    for f in sorted(ZIELE_DIR.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        if d.get("id") != f.stem:
            raise ValueError(f"{f.name}: id muss dem Dateinamen entsprechen")
        if d.get("active", True) or not only_active:
            out.append(d)
    return out


SOURCE_KEYS = ("youtube", "osm_stellplatz", "osm_camping", "osm_entsorgung", "web", "opendata")


def sources_of(dest: dict) -> dict[str, bool]:
    """Aktive Quellen eines Ziels. Ohne Eintrag 'sources' gilt, was bisher konfiguriert war."""
    s = dest.get("sources") or {}
    default = {
        "youtube": bool(dest.get("search_queries") or dest.get("channels")),
        "osm_stellplatz": bool(dest.get("osm_areas")),
        "osm_camping": False, "osm_entsorgung": False,
        "web": False, "opendata": bool(dest.get("opendata")),
    }
    return {k: bool(s.get(k, default[k])) for k in SOURCE_KEYS}


def cost_usd(model: str, tokens_in: int, tokens_out: int) -> float:
    pin, pout = PRICES.get(model, (4.0, 20.0))
    return round((tokens_in * pin + tokens_out * pout) / 1e6, 4)


def book(kind: str, model: str, tokens_in: int, tokens_out: int, ziel: str = "", youtube_units: int = 0,
         videos: int = 0, note: str = "", extra_usd: float = 0.0):
    """Eintrag ins Kostenbuch docs/data/kosten.json (wird von der Webapp ausgewertet)."""
    import datetime as dt

    ledger = load_json(LEDGER_FILE, None)
    if ledger is None:
        ledger = _seed_ledger()
    ledger.append({
        "date": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "kind": kind, "ziel": ziel,
        "model": model, "tokens": [tokens_in, tokens_out], "usd": round(cost_usd(model, tokens_in, tokens_out) + extra_usd, 4),
        "youtube_units": youtube_units, "videos": videos, "note": note,
    })
    save_json(LEDGER_FILE, ledger, compact=True)


def _seed_ledger() -> list[dict]:
    """Einmalig: Läufe aus der Zeit vor dem Kostenbuch aus den meta.json-Verläufen übernehmen."""
    out = []
    for meta_file in WEB_DATA.glob("*/meta.json"):
        for run in load_json(meta_file, {}).get("history", []):
            tin, tout = run.get("claude_tokens", [0, 0])
            out.append({"date": run["date"], "kind": "abruf", "ziel": meta_file.parent.name,
                        "model": run.get("model", ""), "tokens": [tin, tout], "usd": run.get("cost_usd", 0),
                        "youtube_units": run.get("youtube_units", 0), "videos": run.get("videos", 0), "note": ""})
    return sorted(out, key=lambda e: e["date"])


# --------------------------------------------------------------------------- Geodaten


def in_bbox(lat: float, lng: float, bbox) -> bool:
    s, w, n, e = bbox
    return s <= lat <= n and w <= lng <= e


def haversine_km(a, b) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


class Geocoder:
    """OpenStreetMap Nominatim, max. 1 Anfrage pro Sekunde, Ergebnisse werden gecacht."""

    def __init__(self):
        self.cache = load_json(GEOCACHE_FILE, {})

    def candidates(self, place: str, countrycodes: list[str]) -> list[tuple[float, float, str]]:
        """Bis zu fünf Treffer (lat, lng, Land) in der Rangfolge von OpenStreetMap;
        zuerst die ganze Angabe, sonst nur der erste Teil vor dem Komma."""
        key = f"6|{','.join(countrycodes)}|{place.strip().lower()}"
        if key in self.cache:
            return [tuple(p) for p in self.cache[key]]
        result = []
        for q in [place] + ([place.split(",")[0]] if "," in place else []):
            time.sleep(1.1)
            try:
                r = requests.get("https://nominatim.openstreetmap.org/search",
                                 params={"q": q, "format": "jsonv2", "limit": 5, "addressdetails": 1,
                                         "countrycodes": ",".join(countrycodes)},
                                 headers={"User-Agent": UA}, timeout=30)
                r.raise_for_status()
                hits = r.json()
            except requests.RequestException as ex:
                log(f"    Geocoding-Fehler: {ex}")
                return []  # nicht cachen, nächstes Mal neu versuchen
            if hits:
                result = [(float(h["lat"]), float(h["lon"]), (h.get("address") or {}).get("country_code", ""))
                          for h in hits]
                break
        self.cache[key] = result
        return result

    def locate(self, place: str, countrycodes: list[str],
               near: list[tuple[float, float]] | None = None) -> tuple[float, float, str] | None:
        """Bester Treffer mit Land. Mit `near` (Ankerpunkte einer Region) gilt der erste Treffer in der
        Rangfolge von OpenStreetMap, der zur Region passt; sonst der nächstgelegene."""
        m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*", place)
        if m:
            return float(m.group(1)), float(m.group(2)), ""
        hits = self.candidates(place, countrycodes)
        if not hits:
            return None
        if near:
            dist = lambda h: min(haversine_km(h[:2], a) for a in near)
            return next((h for h in hits if dist(h) <= 250), min(hits, key=dist))
        return hits[0]

    def __call__(self, place: str, countrycodes: list[str],
                 near: list[tuple[float, float]] | None = None) -> tuple[float, float] | None:
        hit = self.locate(place, countrycodes, near)
        return hit[:2] if hit else None

    def save(self):
        # Alte Cache-Einträge ohne Landangabe verwerfen
        self.cache = {k: v for k, v in self.cache.items() if k.startswith("6|")}
        save_json(GEOCACHE_FILE, self.cache)


def region_anchors(dest: dict, geocode: "Geocoder") -> dict[str, dict]:
    """Pro Region: Ankerpunkte aus den Orten der Beschreibung (hint) und das häufigste Land."""
    import statistics
    from collections import Counter

    anchors = {}
    for r in dest["regions"]:
        towns = [t.strip() for t in r["hint"].split(",") if t.strip()][:6]
        hits = [[h for h in geocode.candidates(t, dest["countrycodes"]) if in_bbox(h[0], h[1], dest["bbox"])] for t in towns]
        hits = [h for h in hits if h]
        if not hits:
            anchors[r["name"]] = {"points": [], "country": ""}
            continue
        # Gleichnamige Orte: pro Ort den ersten Treffer (Rangfolge von OpenStreetMap), der nahe beim Zentrum liegt
        center = (statistics.median(h[0][0] for h in hits), statistics.median(h[0][1] for h in hits))
        pick = [next((p for p in h if haversine_km(p[:2], center) <= 400), min(h, key=lambda p: haversine_km(p[:2], center)))
                for h in hits]
        center = (statistics.median(p[0] for p in pick), statistics.median(p[1] for p in pick))
        pick = [p for p in pick if haversine_km(p[:2], center) <= 400] or pick
        country = Counter(p[2] for p in pick if p[2]).most_common(1)
        anchors[r["name"]] = {"points": [p[:2] for p in pick], "country": country[0][0] if country else ""}
    return anchors


def distance_to_region(point, anchors: dict, region: str) -> float:
    pts = (anchors.get(region) or {}).get("points") or []
    return min((haversine_km(point, a) for a in pts), default=0.0)


# --------------------------------------------------------------------------- Plätze zusammenführen und prüfen


def similar(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


PRECISION_RANK = {"region": 0, "ort": 1, "genau": 2, "exakt": 3}


def merge_spot(spots: list[dict], new: dict, mention: dict):
    limit_km = CONFIG["merge_distance_m"] / 1000
    for s in spots:
        if s["lat"] is None or new["lat"] is None:
            # Ohne Koordinaten nur zusammenführen, wenn Region und Name passen
            same = s["region"] == new["region"] and similar(s["name"], new["name"]) >= 0.6
        else:
            d = haversine_km((s["lat"], s["lng"]), (new["lat"], new["lng"]))
            both_exact = s["precision"] == "exakt" and new["precision"] == "exakt"
            same = d <= limit_km and (both_exact or similar(s["name"], new["name"]) >= 0.6)
        if same:
            if any(mention_key(m) == mention_key(mention) for m in s["mentions"]):
                return
            newer = all(mention["published"] >= m["published"] for m in s["mentions"])
            s["mentions"].append(mention)
            if PRECISION_RANK[new["precision"]] > PRECISION_RANK[s["precision"]]:
                s["lat"], s["lng"], s["precision"] = new["lat"], new["lng"], new["precision"]
            # Fakten übernehmen: neuere Videos überschreiben, ältere füllen nur Lücken
            for k, v in new["infrastructure"].items():
                if v is not None and (newer or s["infrastructure"].get(k) is None):
                    s["infrastructure"][k] = v
            for k in ("four_wd", "police_contact", "access_note", "safety_note", "price"):
                if new[k] not in (None, "") and (newer or s.get(k) in (None, "")):
                    s[k] = new[k]
            return
    new["mentions"] = [mention]
    spots.append(new)


def finalize(spots: list[dict]):
    for s in spots:
        s["mentions"].sort(key=lambda m: m["published"], reverse=True)
        ratings = [m["rating"] for m in s["mentions"]]
        s["rating"] = round(sum(ratings) / len(ratings), 1)
        safety = [m["safety_rating"] for m in s["mentions"] if m.get("safety_rating")]
        s["safety_rating"] = round(sum(safety) / len(safety), 1) if safety else None
        latest = s["mentions"][0]
        s["recommendation"] = latest["recommendation"]
        s["last_seen"] = latest["published"]
        s["first_seen"] = s["mentions"][-1]["published"]
    spots.sort(key=lambda s: s["last_seen"], reverse=True)


def locate_extracted(dest: dict, sp, geocode: "Geocoder", anchors: dict) -> tuple | None:
    """Standort eines von Claude erkannten Platzes: (lat, lng, Genauigkeit) oder None."""
    if sp.latitude is not None and sp.longitude is not None and in_bbox(sp.latitude, sp.longitude, dest["bbox"]):
        return sp.latitude, sp.longitude, "exakt"
    if sp.location_precision == "region":
        return None, None, "region"  # erscheint nur in der Liste, nicht auf der Karte
    near = (anchors.get(sp.region) or {}).get("points")
    town = geocode(sp.place, dest["countrycodes"], near=near)
    town = town if town and in_bbox(*town, dest["bbox"]) else None
    poi = geocode(f"{sp.poi_name}, {sp.place.split(',')[0]}", dest["countrycodes"], near=near) if sp.poi_name else None
    if poi and in_bbox(*poi, dest["bbox"]) and (not town or haversine_km(poi, town) <= 40):
        return poi[0], poi[1], "genau"
    if town:
        return town[0], town[1], "ort"
    return None


def extracted_spot(sp, spot_id: str, pos: tuple) -> dict:
    lat, lng, precision = pos
    return {
        "id": spot_id, "name": sp.name, "place": sp.place, "poi": sp.poi_name,
        "lat": round(lat, 5) if lat is not None else None, "lng": round(lng, 5) if lng is not None else None,
        "precision": precision, "region": sp.region, "type": sp.spot_type,
        "infrastructure": sp.infrastructure.model_dump(), "four_wd": sp.four_wd_required,
        "access_note": sp.access_note, "safety_note": sp.safety_note,
        "police_contact": sp.police_contact, "price": sp.price,
    }


def mention_key(m: dict) -> str:
    """Eindeutige Herkunft einer Erwähnung: YouTube-Video oder Web-Seite."""
    return m.get("video_id") or m.get("url") or ""


def remove_mentions(spots: list[dict], key: str):
    """Erwähnungen einer Herkunft (Video-ID oder URL) entfernen; Plätze ohne Erwähnung fallen weg."""
    for s in spots:
        s["mentions"] = [m for m in s["mentions"] if mention_key(m) != key]
    spots[:] = [s for s in spots if s["mentions"]]


REGION_RADIUS_KM = 250  # weiter weg von allen Ankerpunkten der Region gilt ein Standort als unplausibel


def check_spots(spots: list[dict], dest: dict, geocode: "Geocoder", anchors: dict) -> int:
    """Standorte und Regionen prüfen, bei jedem Lauf auch für bestehende Plätze.

    - Ungefähr oder über einen Namen verortete Plätze werden mit der aktuellen Logik neu verortet
      (gleichnamige Orte: der erste Treffer, der zur Region passt).
    - Liegt ein Platz weit weg von seiner Region oder in einem anderen Land als die Region,
      wird er der nächstgelegenen passenden Region zugeordnet.
    Gibt die Zahl der Korrekturen zurück."""
    fixed = 0
    for s in spots:
        if s["lat"] is None or s.get("source") == "osm" or not (anchors.get(s["region"]) or {}).get("points"):
            continue
        country = ""
        if s["precision"] in ("ort", "genau"):
            query = f"{s['poi']}, {s['place'].split(',')[0]}" if s["precision"] == "genau" and s.get("poi") else s["place"]
            hit = geocode.locate(query, dest["countrycodes"], near=anchors[s["region"]]["points"])
            if hit and in_bbox(hit[0], hit[1], dest["bbox"]):
                country = hit[2]
                if haversine_km((s["lat"], s["lng"]), hit[:2]) > 1:
                    log(f"    Standort korrigiert: {s['name']} ({s['lat']}, {s['lng']}) → ({hit[0]:.5f}, {hit[1]:.5f})")
                    s["lat"], s["lng"] = round(hit[0], 5), round(hit[1], 5)
                    fixed += 1
        point = (s["lat"], s["lng"])
        wrong_country = country and anchors[s["region"]]["country"] and country != anchors[s["region"]]["country"]
        if distance_to_region(point, anchors, s["region"]) > REGION_RADIUS_KM or wrong_country:
            options = [r for r, a in anchors.items() if a["points"] and (not country or a["country"] in ("", country))]
            best = min(options, key=lambda r: distance_to_region(point, anchors, r), default=s["region"])
            if best != s["region"]:
                log(f"    Region korrigiert: {s['name']}: {s['region']} → {best}")
                s["region"] = best
                fixed += 1
    return fixed


# --------------------------------------------------------------------------- Routen


def _thin(coords: list[list[float]], min_km=0.8) -> list[list[float]]:
    out = [coords[0]]
    for c in coords[1:-1]:
        if haversine_km(out[-1], c) >= min_km:
            out.append(c)
    out.append(coords[-1])
    return out


def route_geometry(points: list[tuple[float, float]]) -> tuple[list[list[float]], str]:
    """Strassenverlauf über den freien OSRM-Dienst; bei Fehler Luftlinie zwischen den Wegpunkten."""
    coords = ";".join(f"{lng},{lat}" for lat, lng in points)
    try:
        r = requests.get(f"https://router.project-osrm.org/route/v1/driving/{coords}",
                         params={"overview": "full", "geometries": "geojson"},
                         headers={"User-Agent": UA}, timeout=60)
        r.raise_for_status()
        line = r.json()["routes"][0]["geometry"]["coordinates"]
        return _thin([[round(lat, 5), round(lng, 5)] for lng, lat in line]), "strasse"
    except (requests.RequestException, KeyError, IndexError, ValueError) as ex:
        log(f"    Routing nicht verfügbar ({type(ex).__name__}), verwende Luftlinie")
        return [[lat, lng] for lat, lng in points], "luftlinie"


def build_routes(dest: dict, geocode: Geocoder) -> list[dict]:
    """Routen nur neu berechnen, wenn sich die Wegpunkte geändert haben."""
    path = WEB_DATA / dest["id"] / "routes.json"
    spec = [{k: r[k] for k in ("id", "name", "color", "waypoints")} for r in dest.get("routes", [])]
    digest = hashlib.sha1(json.dumps(spec, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]
    cached = load_json(path, {})
    if cached.get("hash") == digest and all(r["source"] == "strasse" for r in cached["routes"]):
        return cached["routes"]
    routes = []
    for r in spec:
        pts = [geocode(w, dest["countrycodes"]) for w in r["waypoints"]]
        missing = [w for w, p in zip(r["waypoints"], pts) if not p]
        if missing:
            log(f"    Route {r['id']}: Wegpunkte nicht gefunden: {missing}")
        pts = [p for p in pts if p]
        if len(pts) < 2:
            continue
        coords, source = route_geometry(pts)
        length = sum(haversine_km(coords[i], coords[i + 1]) for i in range(len(coords) - 1))
        routes.append({**r, "coords": coords, "source": source, "length_km": round(length)})
        log(f"    Route {r['name']}: {round(length)} km ({source})")
    save_json(path, {"hash": digest, "routes": routes}, compact=True)
    return routes


def locate_on_route(lat: float, lng: float, coords: list[list[float]]) -> tuple[float, float]:
    """(Kilometer ab Start, Abstand zur Route in km) über lokale Projektion je Segment."""
    best = (math.inf, 0.0)
    along = 0.0
    for (alat, alng), (blat, blng) in zip(coords, coords[1:]):
        kx = 111.32 * math.cos(math.radians((alat + blat) / 2))
        ax, ay, bx, by, px, py = alng * kx, alat * 110.57, blng * kx, blat * 110.57, lng * kx, lat * 110.57
        dx, dy = bx - ax, by - ay
        seg = math.hypot(dx, dy)
        t = 0.0 if seg == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg ** 2))
        off = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
        if off < best[0]:
            best = (off, along + t * seg)
        along += seg
    return round(best[1]), round(best[0], 1)


def annotate_routes(spots: list[dict], routes: list[dict]):
    corridor = CONFIG["route_corridor_km"]
    for s in spots:
        s["routes"] = {}
        if s["lat"] is None:
            continue
        for r in routes:
            km, off = locate_on_route(s["lat"], s["lng"], r["coords"])
            if off <= corridor:
                s["routes"][r["id"]] = [km, off]
