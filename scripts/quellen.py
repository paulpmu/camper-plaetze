"""Zusätzliche Quellen pro Ziel und das Zusammenführen aller Quellen zu docs/data/<ziel>/places.json.

Quellen (Schalter in ziele/<id>.json unter "sources"):
  youtube          Overlander-Videos (update.py)        → spots.json
  osm_stellplatz   OpenStreetMap tourism=caravan_site   → osm.json
  osm_camping      OpenStreetMap tourism=camp_site      → osm.json
  osm_entsorgung   OpenStreetMap amenity=sanitary_dump_station → osm.json
  web              Reiseberichte aus Blogs und Foren    → web.json
  opendata         offene Datensätze (CSV/GeoJSON/JSON) → opendata.json
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import time
from html.parser import HTMLParser
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import anthropic
import requests

from common import (CONFIG, PRECISION_RANK, UA, WEB_DATA, annotate_routes, book, check_spots, cost_usd,
                    distance_to_region, extracted_spot, finalize, haversine_km, in_bbox, load_json,
                    locate_extracted, log, mention_key, merge_spot, remove_mentions, save_json, similar)

ERRORS: dict[str, dict[str, str]] = {}  # pro Ziel und Quelle die letzte Fehlermeldung, landet in meta.json


def _error(did: str, source: str, msg: str | None):
    ERRORS.setdefault(did, {})
    if msg:
        ERRORS[did][source] = msg[:300]
        log(f"  {source}: {msg[:300]}")
    else:
        ERRORS[did].pop(source, None)


def nearest_region(point, anchors: dict) -> str:
    named = [r for r, a in anchors.items() if a.get("points")]
    return min(named, key=lambda r: distance_to_region(point, anchors, r), default="")


# --------------------------------------------------------------------------- OpenStreetMap

OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
OSM_KINDS = {  # Quelle → (Overpass-Filter, Platztyp)
    "osm_stellplatz": ('["tourism"="caravan_site"]', "stellplatz"),
    "osm_camping": ('["tourism"="camp_site"]', "camping"),
    "osm_entsorgung": ('["amenity"="sanitary_dump_station"]', "entsorgung"),
}


def overpass(query: str) -> list[dict]:
    """Overpass-Abfrage mit Wiederholung bei Überlastung und Ersatzserver."""
    last = ""
    for url in OVERPASS:
        for attempt in range(3):
            try:
                r = requests.post(url, data={"data": query}, headers={"User-Agent": UA}, timeout=300)
                if r.status_code in (429, 502, 503, 504):
                    last = f"{url}: HTTP {r.status_code}"
                    time.sleep(20 * (attempt + 1))
                    continue
                r.raise_for_status()
                return r.json().get("elements", [])
            except (requests.RequestException, ValueError) as ex:
                last = f"{url}: {type(ex).__name__} {ex}"
                time.sleep(10)
    raise RuntimeError(last)


def _yes(v) -> bool | None:
    if v is None:
        return None
    return str(v).lower() not in ("no", "none", "0", "false")


def _osm_kind(tags: dict, active: list[str]) -> str | None:
    if "osm_stellplatz" in active and tags.get("tourism") == "caravan_site":
        return "osm_stellplatz"
    if "osm_camping" in active and tags.get("tourism") == "camp_site":
        # reine Zeltplätze ohne Wohnmobile weglassen
        if tags.get("motorhome") == "no" or (tags.get("caravans") == "no" and tags.get("motorhome") != "yes"):
            return None
        return "osm_camping"
    if "osm_entsorgung" in active and tags.get("amenity") == "sanitary_dump_station":
        return "osm_entsorgung"
    return None


def fetch_osm(dest: dict, active: list[str], anchors: dict) -> list[dict] | None:
    """Plätze aus OpenStreetMap für alle aktiven OSM-Quellen; eine Abfrage für alle Gebiete.

    Gebiete aus dest['osm_areas'] (ISO-Code + Region) oder, falls leer, die Länder des Ziels.
    Ohne feste Region wird die nächstgelegene Region des Ziels zugeordnet.
    Gibt None zurück, wenn die Abfrage scheitert – dann bleibt die bisherige Datei unverändert."""
    areas = dest.get("osm_areas") or [{"code": cc.upper(), "region": ""} for cc in dest["countrycodes"]]
    filters = "".join(f"nwr{OSM_KINDS[k][0]}(area.a);" for k in active)
    parts = ["[out:json][timeout:280];"]
    for area in areas:
        sel = (f'["ISO3166-2"="{area["code"]}"]' if "-" in area["code"]
               else f'["ISO3166-1"="{area["code"]}"]["admin_level"="2"]')
        parts.append(f'area{sel}->.a;({filters});out center tags;make marker code="{area["code"]}";out;')
    try:
        elements = overpass("".join(parts))
    except RuntimeError as ex:
        _error(dest["id"], "osm", f"OpenStreetMap fehlgeschlagen: {ex}")
        return None
    region_of = {a["code"]: a.get("region", "") for a in areas}
    spots, pending, seen = [], [], set()
    for e in elements:
        if e.get("type") == "marker":
            region = region_of.get(e.get("tags", {}).get("code"), "")
            for p in pending:
                p["region"] = region or nearest_region((p["lat"], p["lng"]), anchors)
            spots += pending
            pending = []
            continue
        t = e.get("tags", {})
        kind = _osm_kind(t, active)
        lat = e.get("lat", (e.get("center") or {}).get("lat"))
        lng = e.get("lon", (e.get("center") or {}).get("lon"))
        key = f"{e['type']}/{e['id']}"
        if not kind or lat is None or lng is None or key in seen or not in_bbox(lat, lng, dest["bbox"]):
            continue
        seen.add(key)
        typ = OSM_KINDS[kind][1]
        default_name = {"stellplatz": "Wohnmobil-Stellplatz", "camping": "Campingplatz", "entsorgung": "Entsorgungsstation"}[typ]
        pending.append({
            "id": f"osm-{e['type'][0]}{e['id']}", "source": kind, "osm": key,
            "name": t.get("name") or t.get("operator") or default_name,
            "place": t.get("addr:city") or t.get("addr:place") or "", "poi": "",
            "lat": round(lat, 5), "lng": round(lng, 5), "precision": "exakt",
            "region": "", "type": typ,
            "infrastructure": {
                "water": _yes(t.get("drinking_water") or t.get("water_point")),
                "dump_station": True if typ == "entsorgung" else _yes(t.get("sanitary_dump_station")),
                "electricity": _yes(t.get("power_supply")),
                "toilets": _yes(t.get("toilets")), "showers": _yes(t.get("shower")),
            },
            "four_wd": None, "police_contact": None, "access_note": "", "safety_note": "",
            "price": ("gratis" if t.get("fee") == "no" else t.get("charge", "")) or ("kostenpflichtig" if t.get("fee") == "yes" else ""),
            "capacity": t.get("capacity", ""), "opening_hours": t.get("opening_hours", ""),
            "operator": t.get("operator", ""), "website": t.get("website") or t.get("contact:website", ""),
            "description": t.get("description:de") or t.get("description", ""),
            "rating": None, "mentions": [],
        })
    for p in pending:  # falls der letzte Marker fehlt
        p["region"] = p["region"] or nearest_region((p["lat"], p["lng"]), anchors)
    spots += pending
    _error(dest["id"], "osm", None)
    log(f"  OpenStreetMap: {len(spots)} Einträge ({', '.join(active)})")
    return spots


# --------------------------------------------------------------------------- Offene Datensätze


def _rows_from(content: bytes, fmt: str) -> list[dict]:
    if fmt == "csv":
        text = content.decode("utf-8-sig", errors="replace")
        dialect = csv.Sniffer().sniff(text[:5000], delimiters=",;\t") if text else csv.excel
        return list(csv.DictReader(io.StringIO(text), dialect=dialect))
    data = json.loads(content)
    if isinstance(data, dict) and "features" in data:
        rows = []
        for ft in data["features"]:
            geom = ft.get("geometry") or {}
            if geom.get("type") != "Point":
                continue
            p = dict(ft.get("properties") or {})
            p["__lng"], p["__lat"] = geom["coordinates"][:2]
            rows.append(p)
        return rows
    if isinstance(data, dict):
        data = next((v for v in data.values() if isinstance(v, list)), [])
    return [r for r in data if isinstance(r, dict)]


def _pick(row: dict, wanted: str | None, *guesses: str):
    low = {str(k).lower().strip(): v for k, v in row.items()}
    for key in ([wanted.lower()] if wanted else []) + list(guesses):
        if key in low and low[key] not in (None, ""):
            return low[key]
    return None


def fetch_opendata(dest: dict, anchors: dict) -> list[dict] | None:
    """Offene Datensätze aus dest['opendata']: [{name, url, format, type, license, fields:{name,lat,lng,price,website}}]."""
    out, failed = [], []
    for ds in dest.get("opendata", []):
        fmt = (ds.get("format") or ds["url"].rsplit(".", 1)[-1]).lower()
        fmt = "csv" if fmt == "csv" else "json"
        fields = ds.get("fields") or {}
        try:
            r = requests.get(ds["url"], headers={"User-Agent": UA}, timeout=120)
            r.raise_for_status()
            rows = _rows_from(r.content, fmt)
        except (requests.RequestException, ValueError, csv.Error) as ex:
            failed.append(f"{ds['name']}: {type(ex).__name__} {ex}")
            continue
        n = 0
        for row in rows:
            try:
                lat = float(str(_pick(row, fields.get("lat"), "__lat", "lat", "latitude", "breite", "y")).replace(",", "."))
                lng = float(str(_pick(row, fields.get("lng"), "__lng", "lng", "lon", "longitude", "länge", "laenge", "x")).replace(",", "."))
            except (TypeError, ValueError):
                continue
            if not in_bbox(lat, lng, dest["bbox"]):
                continue
            name = str(_pick(row, fields.get("name"), "name", "bezeichnung", "titel", "title", "nom") or ds["name"])
            out.append({
                "id": "od-" + hashlib.sha1(f"{ds['url']}|{name}|{lat:.4f}|{lng:.4f}".encode()).hexdigest()[:10],
                "source": "opendata", "dataset": ds["name"], "license": ds.get("license", ""),
                "name": name, "place": str(_pick(row, fields.get("place"), "ort", "gemeinde", "city", "commune") or ""),
                "poi": "", "lat": round(lat, 5), "lng": round(lng, 5), "precision": "exakt",
                "region": nearest_region((lat, lng), anchors), "type": ds.get("type", "stellplatz"),
                "infrastructure": {"water": None, "dump_station": None, "electricity": None, "toilets": None, "showers": None},
                "four_wd": None, "police_contact": None, "access_note": "", "safety_note": "",
                "price": str(_pick(row, fields.get("price"), "preis", "gebühr", "tarif", "price") or ""),
                "website": str(_pick(row, fields.get("website"), "website", "url", "web", "link") or ""),
                "description": str(_pick(row, fields.get("description"), "beschreibung", "description") or "")[:500],
                "rating": None, "mentions": [],
            })
            n += 1
        log(f"  Datensatz «{ds['name']}»: {n} Einträge")
    _error(dest["id"], "opendata", "; ".join(failed) if failed else None)
    if failed and not out:
        return None
    return out


# --------------------------------------------------------------------------- Web-Reiseberichte

WEB_MODEL = "claude-sonnet-5-5"  # Websuche; das Auslesen der Seiten macht das günstige Standardmodell
WEB_SEARCH_USD = 0.01            # Preis pro Websuche (10 USD pro 1000 Suchen)
PLATFORMS = ("park4night", "camping.info", "campercontact", "ioverlander", "acsi", "pincamp", "stellplatz.info",
             "youtube.com", "youtu.be", "facebook.com", "instagram.com", "tiktok.com", "womoland", "promobil.de/stellplatz")


DISCOVER_USAGE: list[tuple[int, int, int]] = []


class _Text(HTMLParser):
    """Sichtbaren Text einer HTML-Seite sammeln, ohne Skripte, Navigation und Fusszeilen."""
    SKIP = {"script", "style", "noscript", "nav", "footer", "header", "aside", "form", "svg"}

    def __init__(self):
        super().__init__()
        self.depth, self.parts, self.title = 0, [], ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.depth += 1
        self._in_title = tag == "title"

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.depth:
            self.depth -= 1
        self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self.depth and data.strip():
            self.parts.append(data.strip())


def _allowed(url: str) -> bool:
    """robots.txt der Seite beachten."""
    p = urlparse(url)
    rp = RobotFileParser()
    try:
        r = requests.get(f"{p.scheme}://{p.netloc}/robots.txt", headers={"User-Agent": UA}, timeout=15)
        if r.status_code >= 400:
            return True
        rp.parse(r.text.splitlines())
        return rp.can_fetch(UA, url)
    except requests.RequestException:
        return True


def _page_text(url: str) -> tuple[str, str] | None:
    r = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "de,en;q=0.8,fr;q=0.6"}, timeout=30)
    r.raise_for_status()
    if "html" not in r.headers.get("content-type", "html"):
        return None
    parser = _Text()
    parser.feed(r.text[:3_000_000])
    text = re.sub(r"\s+\n", "\n", "\n".join(parser.parts))
    return parser.title.strip(), text[: CONFIG["max_transcript_chars"]]


def _date(s: str) -> str:
    """page_age der Websuche (z. B. 'March 3, 2026' oder ISO) in JJJJ-MM-TT umwandeln, sonst leer."""
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return m.group(0)
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%d %B %Y"):
        try:
            return dt.datetime.strptime(s.strip(), fmt).date().isoformat()
        except ValueError:
            pass
    return ""


def discover_web(dest: dict, known: set[str]) -> tuple[list[dict], int, int, int]:
    """Claude sucht im Web nach aktuellen Reiseberichten. Gibt (Treffer, Tokens ein, Tokens aus, Suchen) zurück."""
    client = anthropic.Anthropic()
    since = (dt.date.today() - dt.timedelta(days=CONFIG.get("web_max_age_days", 540))).isoformat()
    regions = ", ".join(r["name"] for r in dest["regions"])
    prompt = (
        f"Finde aktuelle Reiseberichte, Blogartikel und Forenbeiträge von Wohnmobil-, Camper- und "
        f"Overland-Reisenden über Übernachtungsplätze im Gebiet «{dest['name']}» (Regionen: {regions}). "
        f"Nur Beiträge seit {since}, in Deutsch, Englisch, Französisch, Niederländisch oder der Landessprache. "
        f"Gesucht sind persönliche Erfahrungsberichte mit konkreten Plätzen. Keine Plattform-Datenbanken "
        f"({', '.join(PLATFORMS[:7])}), keine Videos, keine Social-Media-Seiten, keine reinen Werbeseiten.\n"
        f"Bereits bekannt (nicht nochmals liefern): {', '.join(sorted(known)[-60:]) or 'keine'}.\n"
        f"Antworte zum Schluss ausschliesslich mit einem JSON-Array mit höchstens "
        f"{CONFIG.get('web_pages_per_run', 12)} Einträgen: "
        '[{"url": "...", "title": "...", "published": "JJJJ-MM-TT oder leer"}]'
    )
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": CONFIG.get("web_searches_per_run", 8)}]
    messages = [{"role": "user", "content": prompt}]
    tin = tout = searches = 0
    resp = None
    DISCOVER_USAGE.append((0, 0, 0))
    for _ in range(4):  # pause_turn: Server-Werkzeugschleife fortsetzen
        resp = client.messages.create(
            model=WEB_MODEL, max_tokens=16000, messages=messages, tools=tools,
            output_config={"effort": "medium"},
            extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"}, extra_body={"fallbacks": "default"},
        )
        tin += resp.usage.input_tokens
        tout += resp.usage.output_tokens
        stu = getattr(resp.usage, "server_tool_use", None)
        searches += getattr(stu, "web_search_requests", 0) or 0
        DISCOVER_USAGE[-1] = (tin, tout, searches)
        if resp.stop_reason != "pause_turn":
            break
        messages = messages + [{"role": "assistant", "content": resp.content}]
    # 1. Claudes Auswahl (JSON am Schluss der Antwort), 2. sonst alle Treffer der Websuche selbst
    blocks = [b for msg in messages[1:] for b in msg["content"]] + list(resp.content if resp else [])
    text = "".join(getattr(b, "text", "") for b in blocks if getattr(b, "type", "") == "text")
    picked = []
    m = re.search(r"\[\s*\{.*\}\s*\]", text, re.S)
    if m:
        try:
            picked = [h for h in json.loads(m.group(0)) if isinstance(h, dict) and str(h.get("url", "")).startswith("http")]
        except ValueError:
            pass
    found = []
    for b in blocks:
        if getattr(b, "type", "") == "web_search_tool_result" and isinstance(getattr(b, "content", None), list):
            for r in b.content:
                url = getattr(r, "url", "")
                if url.startswith("http"):
                    found.append({"url": url, "title": getattr(r, "title", "") or "", "published": _date(getattr(r, "page_age", "") or "")})
    seen, hits = set(), []
    for h in picked + found:
        u = h["url"].split("#")[0]
        if u in seen or u in known or any(p in u.lower() for p in PLATFORMS):
            continue
        seen.add(u)
        hits.append({**h, "url": u})
    hits = hits[: CONFIG.get("web_pages_per_run", 12) * 2]
    if not hits:
        raise RuntimeError(f"Websuche ohne verwertbare Treffer (stop_reason={getattr(resp, 'stop_reason', '?')}, "
                           f"{searches} Suchen, Text: {text[:150]!r})")
    return hits, tin, tout, searches


def run_web(dest: dict, state: dict, claude, schema, geocode, anchors: dict) -> dict:
    """Web-Reiseberichte suchen (höchstens wöchentlich) und neue Seiten auswerten → web.json."""
    did = dest["id"]
    path = WEB_DATA / did / "web.json"
    spots = load_json(path, [])
    web = state.setdefault("web", {"pages": {}, "last_search": ""})
    stats = {"pages": 0, "spots_new": 0, "searches": 0, "usd": 0.0}
    queue = [u for u, p in web["pages"].items() if p.get("status") == "neu"]
    due = not web["last_search"] or web["last_search"] < (dt.date.today() - dt.timedelta(days=6)).isoformat()
    if due or os.environ.get("WEB_SUCHE") == "ja":
        try:
            try:
                hits, tin, tout, searches = discover_web(dest, set(web["pages"]))
            except RuntimeError as ex:
                hits, (tin, tout, searches) = [], DISCOVER_USAGE[-1] if DISCOVER_USAGE else (0, 0, 0)
                _error(did, "web", str(ex))
            usd = cost_usd(WEB_MODEL, tin, tout) + searches * WEB_SEARCH_USD
            book("websuche", WEB_MODEL, tin, tout, ziel=did, note=f"{searches} Suchen", extra_usd=searches * WEB_SEARCH_USD)
            stats["searches"], stats["usd"] = searches, usd
            web["last_search"] = dt.date.today().isoformat()
            for h in hits:
                web["pages"][h["url"]] = {"title": h.get("title", ""), "published": h.get("published", ""), "status": "neu"}
                queue.append(h["url"])
            log(f"  Websuche: {searches} Suchen, {len(hits)} neue Seiten")
            if hits:
                _error(did, "web", None)
        except anthropic.APIError as ex:
            _error(did, "web", f"Websuche fehlgeschlagen: {ex}")

    tin0, tout0 = claude.tokens_in, claude.tokens_out
    for url in queue[: CONFIG.get("web_pages_per_run", 12)]:
        page = web["pages"][url]
        try:
            if not _allowed(url):
                page["status"] = "robots"
                continue
            got = _page_text(url)
        except requests.RequestException as ex:
            page["status"] = "fehler"
            log(f"    Seite nicht abrufbar: {url} ({type(ex).__name__})")
            continue
        if not got or len(got[1]) < 500:
            page["status"] = "leer"
            continue
        title, text = got
        site = urlparse(url).netloc.removeprefix("www.")
        prompt = (f"Quelle: Web-Reisebericht\nTitel: {page.get('title') or title}\nWebsite: {site}\nURL: {url}\n"
                  f"Veröffentlicht: {page.get('published') or 'unbekannt'}\n\nText:\n{text}")
        try:
            result = claude.extract(dest, schema, prompt, kind="web")
        except anthropic.APIError as ex:
            log(f"    Claude-Fehler: {ex}")
            break
        stats["pages"] += 1
        remove_mentions(spots, url)
        page["status"], page["spots"] = "ausgewertet", 0
        if not result or not result.relevant:
            continue
        published = page.get("published") or dt.date.today().isoformat()
        for sp in result.spots:
            pos = locate_extracted(dest, sp, geocode, anchors)
            if not pos:
                continue
            new = extracted_spot(sp, "w-" + hashlib.sha1(f"{url}|{sp.name}".encode()).hexdigest()[:10], pos)
            mention = {"url": url, "title": page.get("title") or title, "site": site, "published": published,
                       "quote": sp.quote, "rating": max(1, min(5, sp.rating)), "sentiment": sp.sentiment,
                       "recommendation": sp.recommendation, "safety_rating": sp.safety_rating}
            before = len(spots)
            merge_spot(spots, new, mention)
            stats["spots_new"] += len(spots) - before
            page["spots"] += 1
    if claude.tokens_in > tin0:
        tin, tout = claude.tokens_in - tin0, claude.tokens_out - tout0
        book("web", claude.model, tin, tout, ziel=did, videos=stats["pages"])
        stats["usd"] += cost_usd(claude.model, tin, tout)
        stats["tokens_in"], stats["tokens_out"] = tin, tout
    if anchors:
        check_spots(spots, dest, geocode, anchors)
    finalize(spots)
    save_json(path, spots, compact=True)
    log(f"  Web-Reiseberichte: {stats['pages']} Seiten ausgewertet, {stats['spots_new']} neue Plätze, {len(spots)} total")
    return stats


# --------------------------------------------------------------------------- Zusammenführen

REPORT_SOURCES = ("youtube", "web")
SOURCE_LABEL = {"youtube": "YouTube", "web": "Reiseberichte", "osm_stellplatz": "OSM Stellplätze",
                "osm_camping": "OSM Camping", "osm_entsorgung": "OSM Entsorgung", "opendata": "Datensätze"}
SNAP_KM = {"exakt": 0.3, "genau": 3.0, "ort": 15.0}


def _names(s: dict) -> list[str]:
    return [n for n in (s.get("poi"), s.get("name")) if n]


def _name_match(a: dict, b: dict) -> float:
    best = 0.0
    for x in _names(a):
        for y in _names(b):
            best = max(best, similar(x, y))
            if len(x) > 5 and len(y) > 5 and (x.lower() in y.lower() or y.lower() in x.lower()):
                best = max(best, 0.9)
    return best


def _score(p: dict) -> tuple[int, str]:
    """Verlässlichkeit 0–100 aus Standortgenauigkeit, Anzahl Quellen, Erwähnungen und Aktualität."""
    score = {"exakt": 40, "genau": 30, "ort": 15, "region": 5}[p["precision"]]
    score += min(40, 20 * (len(p["sources"]) - 1))
    score += min(15, 5 * max(0, len(p["mentions"]) - 1))
    if p["mentions"]:
        age = (dt.date.today() - dt.date.fromisoformat(p["last_seen"][:10])).days if p.get("last_seen") else 999
        score += 15 if age <= 183 else 8 if age <= 365 else 0
    else:
        score += 10  # gepflegte Verzeichnisse (OSM, Datensätze)
    score = max(0, min(100, score))
    return score, "hoch" if score >= 70 else "mittel" if score >= 45 else "tief"


def _same_place(a: dict, b: dict) -> bool:
    if a["lat"] is None or b["lat"] is None:
        return a["region"] == b["region"] and _name_match(a, b) >= 0.7
    d = haversine_km((a["lat"], a["lng"]), (b["lat"], b["lng"]))
    return d <= CONFIG["merge_distance_m"] / 1000 * 3 and _name_match(a, b) >= 0.6 or (
        d <= 0.15 and a["precision"] == "exakt" and b["precision"] == "exakt")


def merge_places(dest: dict, flags: dict[str, bool], routes: list[dict]) -> dict[str, int]:
    """Alle aktiven Quellen zu places.json zusammenführen. Berichte (YouTube, Web), die zu einem
    Verzeichniseintrag (OSM, Datensatz) passen, übernehmen dessen genaue Koordinaten."""
    did = dest["id"]
    load = lambda name: load_json(WEB_DATA / did / name, [])
    # Berichte aus Videos und Web untereinander zusammenführen (gleicher Platz in Video und Blog)
    merged: list[dict] = []
    for src, fname in (("youtube", "spots.json"), ("web", "web.json")):
        if not flags[src]:
            continue
        for r in load(fname):
            same = next((m for m in merged if _same_place(m, r)), None)
            if not same:
                merged.append({**r, "sources": [src]})
                continue
            keys = {mention_key(x) for x in same["mentions"]}
            same["mentions"] += [x for x in r["mentions"] if mention_key(x) not in keys]
            if src not in same["sources"]:
                same["sources"].append(src)
            if PRECISION_RANK[r["precision"]] > PRECISION_RANK[same["precision"]]:
                same["lat"], same["lng"], same["precision"] = r["lat"], r["lng"], r["precision"]
            for k, v in r["infrastructure"].items():
                if same["infrastructure"].get(k) is None:
                    same["infrastructure"][k] = v

    directory = []
    for e in load("osm.json"):
        e["source"] = "osm_stellplatz" if e.get("source") in (None, "osm") else e["source"]  # ältere Dateien
        if flags.get(e["source"]):
            directory.append(e)
    if flags["opendata"]:
        directory += load("opendata.json")
    for e in directory:
        e["sources"] = [e["source"]]

    # Berichte an Verzeichniseinträge andocken
    absorbed = set()
    for r in merged:
        if r["lat"] is None:
            cands = [e for e in directory if e["region"] == r["region"] and _name_match(r, e) >= 0.75]
        else:
            radius = SNAP_KM[r["precision"]]
            dl = radius / 111
            cands = [e for e in directory if abs(e["lat"] - r["lat"]) <= dl and abs(e["lng"] - r["lng"]) <= dl * 1.4
                     and haversine_km((r["lat"], r["lng"]), (e["lat"], e["lng"])) <= radius
                     and (_name_match(r, e) >= 0.6 or (r["precision"] == "exakt"
                          and haversine_km((r["lat"], r["lng"]), (e["lat"], e["lng"])) <= 0.15))]
        if not cands or r["type"] == "entsorgung":
            continue
        e = max(cands, key=lambda c: _name_match(r, c))
        e["mentions"] = e.get("mentions", []) + r["mentions"]
        for k, v in r["infrastructure"].items():
            if e["infrastructure"].get(k) is None:
                e["infrastructure"][k] = v
        for k in ("four_wd", "police_contact", "access_note", "safety_note"):
            if r.get(k) not in (None, ""):
                e[k] = r[k]
        e["price"] = e.get("price") or r.get("price", "")
        if e["name"] in ("Wohnmobil-Stellplatz", "Campingplatz"):
            e["name"] = r["name"]
        e["coord_source"] = SOURCE_LABEL[e["sources"][0]]
        e["sources"] = e["sources"] + [s for s in r["sources"] if s not in e["sources"]]
        absorbed.add(id(r))

    places = [r for r in merged if id(r) not in absorbed] + directory
    for p in places:
        if p["mentions"]:
            ratings = [m["rating"] for m in p["mentions"]]
            p["rating"] = round(sum(ratings) / len(ratings), 1)
            p["mentions"].sort(key=lambda m: m.get("published", ""), reverse=True)
            p["last_seen"] = p["mentions"][0].get("published", "")
            p["recommendation"] = p["mentions"][0].get("recommendation", "")
        p["confirmed"] = len(p["sources"]) > 1
        p["score"], p["confidence"] = _score(p)
        p.pop("source", None)
    annotate_routes(places, routes)
    save_json(WEB_DATA / did / "places.json", places, compact=True)
    counts = {k: sum(1 for p in places if k in p["sources"]) for k in SOURCE_LABEL}
    counts["total"] = len(places)
    counts["confirmed"] = sum(1 for p in places if p["confirmed"])
    log(f"  Zusammengeführt: {len(places)} Plätze, davon {counts['confirmed']} von mehreren Quellen bestätigt")
    return counts

