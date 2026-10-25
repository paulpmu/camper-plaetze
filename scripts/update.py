"""Täglicher Abruf: neue Marokko-Camper-Videos finden, auswerten und Plätze in docs/data/spots.json schreiben.

Umgebungsvariablen:
  ANTHROPIC_API_KEY      (Pflicht)
  YOUTUBE_API_KEY        (optional; ohne Schlüssel nur RSS-Feeds der Kanalliste)
  TRANSCRIPT_PROXY_URL   (optional; http://user:pass@host:port für Transkript-Abrufe)
  WEBSHARE_USER / WEBSHARE_PASS (optional; Webshare-Residential-Proxy für Transkripte)
  MAX_VIDEOS             (optional; überschreibt max_videos_per_run)
"""

from __future__ import annotations

import datetime as dt
import difflib
import hashlib
import json
import math
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Literal, Optional

import anthropic
import requests
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
STATE_FILE = ROOT / "data" / "state.json"
GEOCACHE_FILE = ROOT / "data" / "geocache.json"
SPOTS_FILE = ROOT / "docs" / "data" / "spots.json"
META_FILE = ROOT / "docs" / "data" / "meta.json"
IOVERLANDER_DIR = ROOT / "data" / "ioverlander"

YT_API = "https://www.googleapis.com/youtube/v3"
UA = "marokko-camper/1.0 (https://github.com/paulpmu/marokko-camper)"

REGIONS = [
    "Mittelmeer & Rif",
    "Nordatlantik",
    "Fès & Mittlerer Atlas",
    "Marrakesch & Hoher Atlas",
    "Südatlantik",
    "Antiatlas & Draa",
    "Sahara Ost",
    "Südwesten",
    "Dakhla & Süden",
]

# Preise pro Million Tokens (Input, Output) für die Kostenschätzung in meta.json
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
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":")) if compact else json.dumps(
        data, ensure_ascii=False, indent=1
    )
    path.write_text(text + "\n", encoding="utf-8")


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(d: dt.datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- YouTube


class YouTube:
    def __init__(self, key: str | None):
        self.key = key
        self.units = 0

    def get(self, endpoint: str, cost: int, **params):
        params["key"] = self.key
        r = requests.get(f"{YT_API}/{endpoint}", params=params, timeout=30)
        self.units += cost
        if r.status_code == 403 and "quotaExceeded" in r.text:
            raise RuntimeError("YouTube-Kontingent für heute aufgebraucht")
        r.raise_for_status()
        return r.json()

    def search(self, query: str, published_after: str, pages: int) -> list[str]:
        ids, token = [], None
        for _ in range(pages):
            params = dict(part="id", q=query, type="video", order="date", maxResults=50,
                          publishedAfter=published_after)
            if token:
                params["pageToken"] = token
            data = self.get("search", 100, **params)
            ids += [it["id"]["videoId"] for it in data.get("items", [])]
            token = data.get("nextPageToken")
            if not token:
                break
        return ids

    def videos(self, ids: list[str]) -> list[dict]:
        out = []
        for i in range(0, len(ids), 50):
            data = self.get("videos", 1, part="snippet,contentDetails", id=",".join(ids[i:i + 50]),
                            maxResults=50)
            out += data.get("items", [])
        return out

    def comments(self, video_id: str, limit: int) -> list[str]:
        try:
            data = self.get("commentThreads", 1, part="snippet", videoId=video_id, order="relevance",
                            maxResults=min(limit, 100), textFormat="plainText")
        except requests.HTTPError:
            return []  # Kommentare deaktiviert
        return [it["snippet"]["topLevelComment"]["snippet"]["textOriginal"] for it in data.get("items", [])]

    def channel_id(self, handle: str) -> str | None:
        data = self.get("channels", 1, part="id", forHandle=handle.lstrip("@"))
        items = data.get("items", [])
        return items[0]["id"] if items else None


def parse_duration(s: str) -> int:
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return 0
    d, h, mi, se = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + se


def rss_videos(channel_id: str) -> list[dict]:
    """Letzte 15 Videos eines Kanals über den kostenlosen RSS-Feed."""
    r = requests.get("https://www.youtube.com/feeds/videos.xml", params={"channel_id": channel_id},
                     headers={"User-Agent": UA}, timeout=30)
    r.raise_for_status()
    ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015",
          "media": "http://search.yahoo.com/mrss/"}
    root = ET.fromstring(r.content)
    channel = root.findtext("a:title", default="", namespaces=ns)
    out = []
    for e in root.findall("a:entry", ns):
        out.append({
            "id": e.findtext("yt:videoId", namespaces=ns),
            "title": e.findtext("a:title", default="", namespaces=ns),
            "channel": channel,
            "published": e.findtext("a:published", default="", namespaces=ns)[:10],
            "description": e.findtext("media:group/media:description", default="", namespaces=ns),
            "duration": None,
        })
    return out


def is_relevant(meta: dict) -> bool:
    text = " ".join([meta.get("title", ""), meta.get("description", ""), " ".join(meta.get("tags", []))]).lower()
    return any(k in text for k in CONFIG["relevance_keywords"])


# --------------------------------------------------------------------------- Transkripte


def transcript_client():
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api.proxies import GenericProxyConfig, WebshareProxyConfig

    if os.getenv("WEBSHARE_USER") and os.getenv("WEBSHARE_PASS"):
        proxy = WebshareProxyConfig(proxy_username=os.environ["WEBSHARE_USER"],
                                    proxy_password=os.environ["WEBSHARE_PASS"])
    elif os.getenv("TRANSCRIPT_PROXY_URL"):
        url = os.environ["TRANSCRIPT_PROXY_URL"]
        proxy = GenericProxyConfig(http_url=url, https_url=url)
    else:
        proxy = None
    return YouTubeTranscriptApi(proxy_config=proxy)


def fetch_transcript(api, video_id: str) -> tuple[str | None, str]:
    """Gibt (Text mit Zeitmarken, Status) zurück. Status: ok, keins, blockiert, fehler."""
    from youtube_transcript_api import _errors as E

    try:
        tl = api.list(video_id)
        prefs = CONFIG["transcript_languages"]
        transcripts = list(tl)
        transcripts.sort(key=lambda t: (t.is_generated,
                                        prefs.index(t.language_code[:2]) if t.language_code[:2] in prefs else 99))
        if not transcripts:
            return None, "keins"
        fetched = transcripts[0].fetch()
    except (E.RequestBlocked, E.IpBlocked, E.PoTokenRequired):
        return None, "blockiert"
    except (E.TranscriptsDisabled, E.NoTranscriptFound):
        return None, "keins"
    except Exception as ex:  # noqa: BLE001 – Transkripte sind ein Zusatz, nie ein Abbruchgrund
        log(f"    Transkript-Fehler {video_id}: {type(ex).__name__}")
        return None, "fehler"

    # Schnipsel zu ~30-Sekunden-Blöcken bündeln: spart Tokens, Zeitmarken bleiben brauchbar
    lines, block, start = [], [], None
    for s in fetched.snippets:
        if start is None:
            start = s.start
        block.append(s.text.replace("\n", " "))
        if s.start - start >= 30:
            lines.append(f"[{int(start)}s] {' '.join(block)}")
            block, start = [], None
    if block:
        lines.append(f"[{int(start)}s] {' '.join(block)}")
    text = "\n".join(lines)
    limit = CONFIG["max_transcript_chars"]
    if len(text) > limit:
        log(f"    Transkript gekürzt: {len(text)} → {limit} Zeichen")
        text = text[:limit] + "\n[… Transkript hier gekürzt]"
    return text, "ok"


# --------------------------------------------------------------------------- Claude


class Infrastructure(BaseModel):
    water: Optional[bool] = Field(description="Trinkwasser verfügbar")
    dump_station: Optional[bool] = Field(description="Ver- und Entsorgung (Grau-/Schwarzwasser)")
    electricity: Optional[bool] = Field(description="Stromanschluss")
    toilets: Optional[bool]
    showers: Optional[bool]


class ExtractedSpot(BaseModel):
    name: str = Field(description="Name des Platzes oder kurze Beschreibung, z. B. 'Strandplatz nördlich Mirleft'")
    place: str = Field(description="Nächster Ort und Gegend, geeignet für eine Geocodierung, z. B. 'Mirleft, Tiznit'")
    latitude: Optional[float] = Field(description="Nur wenn Koordinaten im Material stehen oder aus einem Kartenlink ablesbar sind, sonst null")
    longitude: Optional[float]
    coordinate_source: Literal["text", "kartenlink", "keine"]
    region: Literal[tuple(REGIONS)]  # type: ignore[valid-type]
    spot_type: Literal["wildplatz", "camping", "stellplatz", "andere"]
    infrastructure: Infrastructure
    four_wd_required: Optional[bool] = Field(description="Ist für die Zufahrt Allrad nötig?")
    access_note: str = Field(description="Zufahrt, Pistenzustand, Untergrund; leer wenn unbekannt")
    safety_rating: Optional[int] = Field(description="Sicherheitseindruck 1 (unsicher) bis 5 (sehr sicher)")
    safety_note: str = Field(description="Sicherheit, Polizei/Gendarmerie, Auxiliaires; leer wenn unbekannt")
    police_contact: Optional[bool] = Field(description="Gab es Kontakt mit Polizei/Gendarmerie (Pass-Kontrolle, Wegweisen, Bewachung)?")
    price: str = Field(description="Preis pro Nacht wie genannt, z. B. '70 MAD'; leer wenn unbekannt")
    rating: int = Field(description="Gesamtbewertung 1–5 aus Tonalität und Aussagen der YouTuber")
    sentiment: Literal["positiv", "gemischt", "neutral", "negativ"]
    recommendation: str = Field(description="Empfehlung auf Deutsch, 1–2 Sätze, für wen/wann der Platz passt")
    quote: str = Field(description="Kurze aussagekräftige Aussage aus dem Video (Originalsprache), max. 200 Zeichen")
    timestamp_seconds: Optional[int] = Field(description="Sekunde im Video, wo der Platz gezeigt wird, aus den [Ns]-Marken")


class Extraction(BaseModel):
    relevant: bool = Field(description="Handelt das Video von einer Reise mit Camper/Van/Wohnmobil/4x4 in Marokko oder Dakhla?")
    spots: list[ExtractedSpot]


SYSTEM = f"""Du wertest Reisevideos von Camper-Overlandern in Marokko (inkl. Dakhla und Süden) aus.
Aus Titel, Beschreibung, Kapitelmarken, Kommentaren und Transkript extrahierst du jeden Übernachtungsplatz,
an dem die YouTuber übernachtet haben oder den sie konkret empfehlen bzw. vor dem sie warnen.

Regeln:
- Nur echte Übernachtungsplätze, keine reinen Sehenswürdigkeiten, Restaurants oder Durchfahrten.
- Erfinde keine Fakten. Unbekanntes ist null bzw. ein leerer Text.
- Koordinaten nur, wenn sie im Material stehen (auch DMS umrechnen) oder aus einem Kartenlink
  (Google Maps @lat,lng / q=lat,lng, Apple Maps ll=) ablesbar sind. Schätze keine Koordinaten.
- Die Bewertung spiegelt die Aussagen und Tonalität der YouTuber wider, nicht dein Wissen.
- Regionen: {", ".join(REGIONS)}.
  Südatlantik = Essaouira bis Sidi Ifni; Südwesten = Guelmim, Tan-Tan, Tarfaya, Laâyoune, Boujdour;
  Dakhla & Süden = Dakhla und südlich davon; Antiatlas & Draa = Tafraoute, Ouarzazate, Zagora, Dadès, Todra.
- Ist das Video nicht über eine Camper-Reise in Marokko, setze relevant=false und gib keine Plätze zurück."""


def build_prompt(v: dict, comments: list[str], transcript: str | None) -> str:
    parts = [
        f"Titel: {v['title']}",
        f"Kanal: {v['channel']}",
        f"Veröffentlicht: {v['published']}",
        f"Beschreibung (mit Kapitelmarken):\n{v.get('description') or '(keine)'}",
    ]
    if comments:
        parts.append("Kommentare:\n" + "\n".join(f"- {c[:600]}" for c in comments))
    parts.append(f"Transkript:\n{transcript}" if transcript else "Transkript: nicht verfügbar")
    return "\n\n".join(parts)


class Claude:
    def __init__(self):
        self.client = anthropic.Anthropic()
        self.model = os.getenv("CLAUDE_MODEL") or CONFIG["claude_model"]
        self.tokens_in = 0
        self.tokens_out = 0

    def extract(self, prompt: str) -> Extraction | None:
        kwargs = {}
        if self.model in FALLBACK_MODELS:
            # Lehnt der Sicherheitsfilter ab, übernimmt serverseitig ein Ersatzmodell
            kwargs = dict(extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
                          extra_body={"fallbacks": "default"})
        resp = self.client.messages.parse(
            model=self.model,
            max_tokens=16000,
            system=SYSTEM,
            messages=[{"role": "user", "content": prompt}],
            output_format=Extraction,
            output_config={"effort": CONFIG["claude_effort"]},
            **kwargs,
        )
        self.tokens_in += resp.usage.input_tokens
        self.tokens_out += resp.usage.output_tokens
        if resp.stop_reason in ("refusal", "max_tokens"):
            log(f"    Claude: stop_reason={resp.stop_reason}")
            return None
        return resp.parsed_output

    def cost_usd(self) -> float:
        pin, pout = PRICES.get(self.model, (4.0, 20.0))
        return round((self.tokens_in * pin + self.tokens_out * pout) / 1e6, 3)


# --------------------------------------------------------------------------- Geodaten


def geocode(place: str, cache: dict) -> tuple[float, float] | None:
    """OpenStreetMap Nominatim, max. 1 Anfrage pro Sekunde, Ergebnisse werden gecacht."""
    key = place.strip().lower()
    if key in cache:
        return tuple(cache[key]) if cache[key] else None
    result = None
    candidates = [place] + ([place.split(",")[0]] if "," in place else [])
    for q in candidates:
        time.sleep(1.1)
        try:
            r = requests.get("https://nominatim.openstreetmap.org/search",
                             params={"q": q, "format": "json", "limit": 1, "countrycodes": "ma,eh"},
                             headers={"User-Agent": UA}, timeout=30)
            r.raise_for_status()
            hits = r.json()
        except requests.RequestException as ex:
            log(f"    Geocoding-Fehler: {ex}")
            return None  # nicht cachen, nächstes Mal neu versuchen
        if hits:
            result = (float(hits[0]["lat"]), float(hits[0]["lon"]))
            break
    cache[key] = result
    return result


def in_area(lat: float, lng: float) -> bool:
    """Grobe Box um Marokko inkl. Süden bis Lagouira."""
    return 20.5 <= lat <= 36.2 and -17.5 <= lng <= -0.9


def haversine_m(a, b) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def load_ioverlander() -> list[dict]:
    """Optionaler iOverlander-Export (CSV oder JSON) in data/ioverlander/."""
    import csv

    places = []
    if not IOVERLANDER_DIR.exists():
        return places
    for f in IOVERLANDER_DIR.iterdir():
        rows = []
        if f.suffix.lower() == ".csv":
            with f.open(encoding="utf-8-sig") as fh:
                rows = list(csv.DictReader(fh))
        elif f.suffix.lower() in (".json", ".geojson"):
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "features" in data:
                for ft in data["features"]:
                    p = dict(ft.get("properties") or {})
                    p["longitude"], p["latitude"] = ft["geometry"]["coordinates"][:2]
                    rows.append(p)
            elif isinstance(data, list):
                rows = data
        for r in rows:
            low = {k.lower().strip(): v for k, v in r.items()}
            try:
                lat = float(low.get("latitude") or low.get("lat"))
                lng = float(low.get("longitude") or low.get("lng") or low.get("lon"))
            except (TypeError, ValueError):
                continue
            places.append({"lat": lat, "lng": lng, "name": low.get("name") or low.get("title") or "",
                           "id": str(low.get("id") or low.get("place_id") or ""),
                           "category": low.get("category") or low.get("type") or ""})
    log(f"iOverlander: {len(places)} Plätze geladen")
    return places


# --------------------------------------------------------------------------- Plätze zusammenführen


def similar(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


def merge_spot(spots: list[dict], new: dict, mention: dict):
    limit = CONFIG["merge_distance_m"]
    for s in spots:
        d = haversine_m((s["lat"], s["lng"]), (new["lat"], new["lng"]))
        both_exact = s["precision"] == "exakt" and new["precision"] == "exakt"
        if d <= limit and (both_exact or similar(s["name"], new["name"]) >= 0.6):
            if any(m["video_id"] == mention["video_id"] for m in s["mentions"]):
                return
            newer = all(mention["published"] >= m["published"] for m in s["mentions"])
            s["mentions"].append(mention)
            if new["precision"] == "exakt" and s["precision"] != "exakt":
                s["lat"], s["lng"], s["precision"] = new["lat"], new["lng"], "exakt"
            # Fakten übernehmen: neuere Videos überschreiben, ältere füllen nur Lücken
            for k, v in new["infrastructure"].items():
                if v is not None and (newer or s["infrastructure"].get(k) is None):
                    s["infrastructure"][k] = v
            for k in ("four_wd", "police_contact", "access_note", "safety_note", "price"):
                if new[k] not in (None, "") and (newer or s.get(k) in (None, "")):
                    s[k] = new[k]
            if "ioverlander" in new and "ioverlander" not in s:
                s["ioverlander"] = new["ioverlander"]
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


# --------------------------------------------------------------------------- Ablauf


def collect_candidates(yt: YouTube | None, state: dict) -> None:
    """Neue Video-IDs samt Metadaten in die Warteschlange state['queue'] legen."""
    known = set(state["videos"]) | set(state["queue"])
    found: dict[str, dict] = {}

    if yt:
        backfill = not state.get("backfill_done")
        days = CONFIG["backfill_days"] if backfill else CONFIG["search_window_days"]
        pages = CONFIG["backfill_pages"] if backfill else 1
        after = iso(now_utc() - dt.timedelta(days=days))
        ids: list[str] = []
        for q in CONFIG["search_queries"]:
            try:
                ids += yt.search(q, after, pages)
            except Exception as ex:  # noqa: BLE001
                log(f"Suche «{q}» fehlgeschlagen: {ex}")
                if "Kontingent" in str(ex):
                    break
        new_ids = sorted(set(ids) - known)
        for item in yt.videos(new_ids):
            sn = item["snippet"]
            found[item["id"]] = {
                "id": item["id"], "title": sn.get("title", ""), "channel": sn.get("channelTitle", ""),
                "published": sn.get("publishedAt", "")[:10], "description": sn.get("description", ""),
                "tags": sn.get("tags", []), "duration": parse_duration(item["contentDetails"].get("duration")),
            }
        state["backfill_done"] = True
        log(f"YouTube-Suche: {len(ids)} Treffer, {len(new_ids)} neu")

    for ch in CONFIG["channels"]:
        cid = ch
        if ch.startswith("@"):
            cid = state["channels"].get(ch)
            if not cid and yt:
                cid = yt.channel_id(ch)
                state["channels"][ch] = cid
            if not cid:
                log(f"Kanal {ch}: ID unbekannt (YouTube-Schlüssel nötig zum Auflösen)")
                continue
        try:
            for v in rss_videos(cid):
                if v["id"] not in known and v["id"] not in found:
                    found[v["id"]] = v
        except Exception as ex:  # noqa: BLE001
            log(f"RSS {ch} fehlgeschlagen: {ex}")

    added = 0
    for vid, v in found.items():
        if v.get("duration") is not None and v["duration"] < CONFIG["min_duration_seconds"]:
            state["videos"][vid] = {"skipped": "kurz"}
            continue
        if not is_relevant(v):
            state["videos"][vid] = {"skipped": "irrelevant"}
            continue
        v.pop("tags", None)
        state["queue"][vid] = v
        added += 1
    log(f"Warteschlange: +{added}, total {len(state['queue'])}")


def main():
    if not os.getenv("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY fehlt (GitHub → Settings → Secrets and variables → Actions)")
    yt_key = os.getenv("YOUTUBE_API_KEY")
    yt = YouTube(yt_key) if yt_key else None
    if not yt:
        log("Kein YOUTUBE_API_KEY: nur RSS-Feeds der Kanalliste werden abgefragt")

    state = load_json(STATE_FILE, {"videos": {}, "queue": {}, "channels": {}, "backfill_done": False})
    geocache = load_json(GEOCACHE_FILE, {})
    spots = load_json(SPOTS_FILE, [])
    ioverlander = load_ioverlander()

    collect_candidates(yt, state)

    claude = Claude()
    tapi = transcript_client()
    limit = int(os.getenv("MAX_VIDEOS") or CONFIG["max_videos_per_run"])
    queue = sorted(state["queue"].values(), key=lambda v: v["published"], reverse=True)[:limit]
    stats = {"videos": 0, "spots_new": 0, "transcripts": {"ok": 0, "keins": 0, "blockiert": 0, "fehler": 0}}

    for v in queue:
        log(f"▶ {v['published']} {v['channel']} – {v['title'][:70]}")
        transcript, tstatus = fetch_transcript(tapi, v["id"])
        stats["transcripts"][tstatus] += 1
        comments = yt.comments(v["id"], CONFIG["max_comments"]) if yt else []
        try:
            result = claude.extract(build_prompt(v, comments, transcript))
        except anthropic.RateLimitError:
            log("    Claude-Ratenlimit erreicht, Rest folgt beim nächsten Lauf")
            break
        except anthropic.APIStatusError as ex:
            log(f"    Claude-Fehler {ex.status_code}: {ex.message}")
            if ex.status_code in (400, 401, 403):
                break  # Konfigurationsproblem (Schlüssel, Guthaben) – nicht weiter Geld verbrennen
            continue
        except anthropic.APIConnectionError:
            log("    Claude nicht erreichbar, Video bleibt in der Warteschlange")
            continue

        del state["queue"][v["id"]]
        stats["videos"] += 1
        record = {"title": v["title"], "channel": v["channel"], "published": v["published"],
                  "transcript": tstatus, "spots": 0}
        state["videos"][v["id"]] = record
        if not result or not result.relevant:
            record["skipped"] = "irrelevant" if result else "abgelehnt"
            continue

        for sp in result.spots:
            if sp.latitude is not None and sp.longitude is not None and in_area(sp.latitude, sp.longitude):
                lat, lng, precision = sp.latitude, sp.longitude, "exakt"
            else:
                pos = geocode(sp.place, geocache)
                if not pos or not in_area(*pos):
                    log(f"    ✗ ohne Standort: {sp.name} ({sp.place})")
                    continue
                lat, lng, precision = pos[0], pos[1], "ort"
            sid = hashlib.sha1(f"{v['id']}|{sp.name}".encode()).hexdigest()[:10]
            new = {
                "id": sid, "name": sp.name, "place": sp.place, "lat": round(lat, 5), "lng": round(lng, 5),
                "precision": precision, "region": sp.region, "type": sp.spot_type,
                "infrastructure": sp.infrastructure.model_dump(), "four_wd": sp.four_wd_required,
                "access_note": sp.access_note, "safety_note": sp.safety_note,
                "police_contact": sp.police_contact, "price": sp.price,
            }
            io = min(ioverlander, key=lambda p: haversine_m((lat, lng), (p["lat"], p["lng"])), default=None)
            if io and haversine_m((lat, lng), (io["lat"], io["lng"])) <= 250:
                new["ioverlander"] = {"name": io["name"], "id": io["id"], "category": io["category"]}
            mention = {
                "video_id": v["id"], "title": v["title"], "channel": v["channel"], "published": v["published"],
                "t": sp.timestamp_seconds, "quote": sp.quote, "rating": max(1, min(5, sp.rating)),
                "sentiment": sp.sentiment, "recommendation": sp.recommendation,
                "safety_rating": sp.safety_rating, "transcript": tstatus == "ok",
            }
            before = len(spots)
            merge_spot(spots, new, mention)
            stats["spots_new"] += len(spots) - before
            record["spots"] += 1
            log(f"    ✓ {sp.name} [{precision}] {sp.rating}/5")

    finalize(spots)
    save_json(SPOTS_FILE, spots, compact=True)
    save_json(STATE_FILE, state)
    save_json(GEOCACHE_FILE, geocache)

    meta = load_json(META_FILE, {})
    history = meta.get("history", [])[-59:]
    run = {
        "date": iso(now_utc()), "videos": stats["videos"], "spots_new": stats["spots_new"],
        "transcripts": stats["transcripts"], "youtube_units": yt.units if yt else 0,
        "claude_tokens": [claude.tokens_in, claude.tokens_out], "cost_usd": claude.cost_usd(),
    }
    save_json(META_FILE, {
        "last_run": run["date"], "spots": len(spots),
        "videos_total": sum(1 for x in state["videos"].values() if "transcript" in x),
        "queue": len(state["queue"]), "model": claude.model, "history": history + [run],
    })
    log(f"Fertig: {stats['videos']} Videos, {stats['spots_new']} neue Plätze, {len(spots)} total, "
        f"Transkripte {stats['transcripts']}, YouTube {run['youtube_units']} Einheiten, ca. {run['cost_usd']} USD")


if __name__ == "__main__":
    main()
