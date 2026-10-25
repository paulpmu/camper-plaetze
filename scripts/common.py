"""Gemeinsame Bausteine: Konfiguration, Ziele, Dateien, Geodaten und Routen."""

from __future__ import annotations

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


def cost_usd(model: str, tokens_in: int, tokens_out: int) -> float:
    pin, pout = PRICES.get(model, (4.0, 20.0))
    return round((tokens_in * pin + tokens_out * pout) / 1e6, 4)


def book(kind: str, model: str, tokens_in: int, tokens_out: int, ziel: str = "", youtube_units: int = 0,
         videos: int = 0, note: str = ""):
    """Eintrag ins Kostenbuch docs/data/kosten.json (wird von der Webapp ausgewertet)."""
    import datetime as dt

    ledger = load_json(LEDGER_FILE, None)
    if ledger is None:
        ledger = _seed_ledger()
    ledger.append({
        "date": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "kind": kind, "ziel": ziel,
        "model": model, "tokens": [tokens_in, tokens_out], "usd": cost_usd(model, tokens_in, tokens_out),
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

    def save(self):
        save_json(GEOCACHE_FILE, self.cache)

    def __call__(self, place: str, countrycodes: list[str]) -> tuple[float, float] | None:
        m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*", place)
        if m:
            return float(m.group(1)), float(m.group(2))
        key = f"{','.join(countrycodes)}|{place.strip().lower()}"
        if key in self.cache:
            return tuple(self.cache[key]) if self.cache[key] else None
        result = None
        candidates = [place] + ([place.split(",")[0]] if "," in place else [])
        for q in candidates:
            time.sleep(1.1)
            try:
                r = requests.get("https://nominatim.openstreetmap.org/search",
                                 params={"q": q, "format": "json", "limit": 1,
                                         "countrycodes": ",".join(countrycodes)},
                                 headers={"User-Agent": UA}, timeout=30)
                r.raise_for_status()
                hits = r.json()
            except requests.RequestException as ex:
                log(f"    Geocoding-Fehler: {ex}")
                return None  # nicht cachen, nächstes Mal neu versuchen
            if hits:
                result = (float(hits[0]["lat"]), float(hits[0]["lon"]))
                break
        self.cache[key] = result
        return result


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
        for r in routes:
            km, off = locate_on_route(s["lat"], s["lng"], r["coords"])
            if off <= corridor:
                s["routes"][r["id"]] = [km, off]
