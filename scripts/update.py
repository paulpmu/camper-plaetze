"""Täglicher Abruf: neue Camper-Videos pro Ziel finden, auswerten und Plätze nach docs/data/<ziel>/ schreiben.

Aufruf:
  python scripts/update.py                     alle aktiven Ziele
  python scripts/update.py --ziel marokko      nur ein Ziel
  python scripts/update.py --nur-index         nur die Zielübersicht für die Webapp schreiben
  python scripts/update.py --vergleich 10      10 Videos mit claude_model und compare_model gegenüberstellen

Umgebungsvariablen:
  ANTHROPIC_API_KEY      (Pflicht)
  YOUTUBE_API_KEY        (optional; ohne Schlüssel nur RSS-Feeds der Kanallisten)
  TRANSCRIPT_PROXY_URL   (optional; http://user:pass@host:port für Transkript-Abrufe)
  WEBSHARE_USER / WEBSHARE_PASS (optional; Webshare-Residential-Proxy für Transkripte)
  MAX_VIDEOS             (optional; überschreibt max_videos_per_run)
"""

from __future__ import annotations

import argparse
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
from typing import Literal, Optional

import anthropic
import requests

import quellen
from pydantic import BaseModel, Field, create_model

from common import (CONFIG, DATA_DIR, FALLBACK_MODELS, REPO, ROOT, UA, WEB_DATA, Geocoder, annotate_routes, book,
                    build_routes, check_spots, cost_usd, extracted_spot, finalize, in_bbox, load_destinations,
                    load_json, locate_extracted, log, merge_spot, region_anchors, remove_mentions, save_json,
                    sources_of)

YT_API = "https://www.googleapis.com/youtube/v3"


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(d: dt.datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- YouTube


class QuotaExceeded(RuntimeError):
    pass


class YouTube:
    def __init__(self, key: str | None):
        self.key = key
        self.units = 0

    def get(self, endpoint: str, cost: int, **params):
        params["key"] = self.key
        r = requests.get(f"{YT_API}/{endpoint}", params=params, timeout=30)
        self.units += cost
        if r.status_code == 403 and "quotaExceeded" in r.text:
            raise QuotaExceeded("YouTube-Kontingent für heute aufgebraucht")
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


def is_relevant(meta: dict, dest: dict) -> bool:
    text = " ".join([meta.get("title", ""), meta.get("description", ""), " ".join(meta.get("tags", []))]).lower()
    return any(k.lower() in text for k in dest["relevance_keywords"])


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


def proxy_configured() -> bool:
    return bool((os.getenv("WEBSHARE_USER") and os.getenv("WEBSHARE_PASS")) or os.getenv("TRANSCRIPT_PROXY_URL"))


def fetch_transcript(api, video_id: str, languages: list[str]) -> tuple[str | None, str]:
    """Gibt (Text mit Zeitmarken, Status) zurück. Status: ok, keins, blockiert, fehler."""
    from youtube_transcript_api import _errors as E

    try:
        transcripts = list(api.list(video_id))
        transcripts.sort(key=lambda t: (t.is_generated, languages.index(t.language_code[:2])
                                        if t.language_code[:2] in languages else 99))
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


def extraction_model(dest: dict):
    """Ausgabeschema pro Ziel – die Regionen werden als feste Auswahl vorgegeben."""
    regions = tuple(r["name"] for r in dest["regions"])
    spot = create_model(
        "ExtractedSpot",
        name=(str, Field(description="Name des Platzes oder kurze Beschreibung, z. B. 'Strandplatz nördlich Mirleft'")),
        place=(str, Field(description="Nächster Ort (Stadt/Dorf) und Provinz, geeignet für eine Geocodierung, z. B. 'Mirleft, Tiznit'")),
        poi_name=(str, Field(description="Offizieller Name des Platzes, Campings, Strands, Sees, Passes o. ä., wenn genannt, z. B. 'Camping Aftas' oder 'Plage Blanche'; sonst leer")),
        location_precision=(Literal["koordinaten", "genau", "ort", "region"], Field(description=(
            "koordinaten = Koordinaten/Kartenlink vorhanden; genau = benannter, auffindbarer Ort (Camping, Strand, See, Pass) "
            "oder eindeutige Lage ('Parkplatz am Leuchtturm von Tarfaya'); ort = nur Stadt/Dorf bekannt; "
            "region = nur Gegend bekannt ('Hoher Atlas', 'Küste südlich Agadir')"))),
        latitude=(Optional[float], Field(description="Nur wenn Koordinaten im Material stehen oder aus einem Kartenlink ablesbar sind, sonst null")),
        longitude=(Optional[float], ...),
        coordinate_source=(Literal["text", "kartenlink", "keine"], ...),
        region=(Literal[regions], ...),  # type: ignore[valid-type]
        spot_type=(Literal["wildplatz", "camping", "stellplatz", "andere"], ...),
        infrastructure=(Infrastructure, ...),
        four_wd_required=(Optional[bool], Field(description="Ist für die Zufahrt Allrad nötig?")),
        access_note=(str, Field(description="Zufahrt, Pistenzustand, Untergrund, Tankmöglichkeit; leer wenn unbekannt")),
        safety_rating=(Optional[int], Field(description="Sicherheitseindruck 1 (unsicher) bis 5 (sehr sicher)")),
        safety_note=(str, Field(description="Sicherheit, Kontrollen, Verbote, Bussen; leer wenn unbekannt")),
        police_contact=(Optional[bool], Field(description="Gab es Kontakt mit Polizei/Behörden (Kontrolle, Wegweisen, Bewachung)?")),
        price=(str, Field(description="Preis pro Nacht wie genannt, z. B. '70 MAD'; leer wenn unbekannt")),
        rating=(int, Field(description="Gesamtbewertung 1–5 aus Tonalität und Aussagen der YouTuber")),
        sentiment=(Literal["positiv", "gemischt", "neutral", "negativ"], ...),
        recommendation=(str, Field(description="Empfehlung auf Deutsch, 1–2 Sätze, für wen/wann der Platz passt")),
        quote=(str, Field(description="Kurze aussagekräftige Aussage aus dem Video (Originalsprache), max. 200 Zeichen")),
        timestamp_seconds=(Optional[int], Field(description="Sekunde im Video, wo der Platz gezeigt wird, aus den [Ns]-Marken")),
    )
    return create_model(
        "Extraction",
        relevant=(bool, Field(description=f"Handelt das Video von einer Reise mit Camper/Van/Wohnmobil/4x4 im Gebiet «{dest['name']}»?")),
        spots=(list[spot], ...),
    )


def system_prompt(dest: dict, kind: str = "video") -> str:
    regions = "\n".join(f"  - {r['name']}: {r['hint']}" for r in dest["regions"])
    if kind == "web":
        intro = (f"Du wertest Reiseberichte (Blogs, Foren) von Camper-Reisenden im Gebiet «{dest['name']}» aus.\n"
                 "Aus dem Text extrahierst du jeden Übernachtungsplatz, an dem die Autoren übernachtet haben\n"
                 "oder den sie konkret empfehlen bzw. vor dem sie warnen. timestamp_seconds ist immer null.")
    else:
        intro = (f"Du wertest Reisevideos von Camper-Overlandern im Gebiet «{dest['name']}» aus.\n"
                 "Aus Titel, Beschreibung, Kapitelmarken, Kommentaren und Transkript extrahierst du jeden\n"
                 "Übernachtungsplatz, an dem die YouTuber übernachtet haben oder den sie konkret empfehlen bzw. vor dem sie warnen.")
    return f"""{intro}

Regeln:
- Nur Orte, an denen die YouTuber mit dem Fahrzeug übernachtet haben oder die sie ausdrücklich als
  Übernachtungsplatz empfehlen oder davor warnen. Nicht dazu gehören: Werkstätten, Restaurants, Cafés,
  Tankstellen, Märkte, Sehenswürdigkeiten, Fährhäfen, Grenzübergänge, Hotels/Riads ohne Camper-Stellplatz
  sowie Orte, die nur durchfahren oder besucht werden.
- Lieber weniger, dafür sichere Plätze. Im Zweifel weglassen.
- Gib die Ortsangabe so genau wie möglich an und stufe ihre Genauigkeit ehrlich ein.
- Nur Plätze innerhalb des Gebiets «{dest['name']}».
- Erfinde keine Fakten. Unbekanntes ist null bzw. ein leerer Text.
- Koordinaten nur, wenn sie im Material stehen (auch DMS umrechnen) oder aus einem Kartenlink
  (Google Maps @lat,lng / q=lat,lng, Apple Maps ll=) ablesbar sind. Schätze keine Koordinaten.
- Die Bewertung spiegelt die Aussagen und Tonalität der Reisenden wider, nicht dein Wissen.
- Regionen:
{regions}
- Handelt das Material nicht von einer Camper-Reise in diesem Gebiet, setze relevant=false und gib keine Plätze zurück.
{dest.get('notes', '')}"""


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
    def __init__(self, model: str | None = None):
        self.client = anthropic.Anthropic()
        self.model = model or os.getenv("CLAUDE_MODEL") or CONFIG["claude_model"]
        self.tokens_in = 0
        self.tokens_out = 0

    def extract(self, dest: dict, schema, prompt: str, kind: str = "video"):
        kwargs = {}
        if self.model in FALLBACK_MODELS:
            # Lehnt der Sicherheitsfilter ab, übernimmt serverseitig ein Ersatzmodell
            kwargs = dict(extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
                          extra_body={"fallbacks": "default"})
        resp = self.client.messages.parse(
            model=self.model,
            max_tokens=16000,
            system=system_prompt(dest, kind),
            messages=[{"role": "user", "content": prompt}],
            output_format=schema,
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
        return cost_usd(self.model, self.tokens_in, self.tokens_out)


# --------------------------------------------------------------------------- Plätze zusammenführen


# --------------------------------------------------------------------------- Ablauf


WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]


def is_due(dest: dict) -> bool:
    """Nächtlicher Lauf: täglich immer, wöchentlich am gewählten Wochentag (1 = Montag), manuell nie."""
    schedule = dest.get("schedule", "taeglich")
    if schedule == "woechentlich":
        return dt.date.today().isoweekday() == int(dest.get("weekday", 1))
    return schedule == "taeglich"


def search_cost(dest: dict, backfill: bool) -> int:
    pages = CONFIG["backfill_pages"] if backfill else 1
    return len(dest["search_queries"]) * pages * 100


def search_today(dest: dict, index: int, dests: list[dict], state: dict) -> bool:
    """Verteilt die Suchen über mehrere Tage, wenn das YouTube-Kontingent für alle Ziele nicht reicht."""
    if not state.get("backfill_done"):
        return True
    total = sum(search_cost(d, False) for d in dests)
    every = max(1, math.ceil(total / CONFIG["youtube_daily_budget"]))
    return (dt.date.today().toordinal() + index) % every == 0


def collect_candidates(dest: dict, yt: YouTube | None, state: dict, search: bool) -> None:
    """Neue Video-IDs samt Metadaten in die Warteschlange state['queue'] legen."""
    known = set(state["videos"]) | set(state["queue"])
    found: dict[str, dict] = {}

    if yt and search:
        backfill = not state.get("backfill_done")
        if yt.units + search_cost(dest, backfill) > CONFIG["youtube_daily_budget"]:
            log("  YouTube-Suche verschoben: Tageskontingent reicht heute nicht mehr")
        else:
            days = CONFIG["backfill_days"] if backfill else CONFIG["search_window_days"]
            pages = CONFIG["backfill_pages"] if backfill else 1
            after = iso(now_utc() - dt.timedelta(days=days))
            ids: list[str] = []
            for q in dest["search_queries"]:
                try:
                    ids += yt.search(q, after, pages)
                except QuotaExceeded:
                    log("  YouTube-Kontingent aufgebraucht")
                    break
                except requests.RequestException as ex:
                    log(f"  Suche «{q}» fehlgeschlagen: {ex}")
            new_ids = sorted(set(ids) - known)
            for item in yt.videos(new_ids):
                sn = item["snippet"]
                found[item["id"]] = {
                    "id": item["id"], "title": sn.get("title", ""), "channel": sn.get("channelTitle", ""),
                    "published": sn.get("publishedAt", "")[:10], "description": sn.get("description", ""),
                    "tags": sn.get("tags", []), "duration": parse_duration(item["contentDetails"].get("duration")),
                }
            state["backfill_done"] = True
            log(f"  YouTube-Suche: {len(ids)} Treffer, {len(new_ids)} neu")
    elif yt:
        log("  YouTube-Suche heute ausgelassen (Kontingent wird über mehrere Tage verteilt)")

    for ch in dest.get("channels", []):
        cid = ch
        if ch.startswith("@"):
            cid = state["channels"].get(ch)
            if not cid and yt:
                cid = yt.channel_id(ch)
                state["channels"][ch] = cid
            if not cid:
                log(f"  Kanal {ch}: ID unbekannt (YouTube-Schlüssel nötig zum Auflösen)")
                continue
        try:
            for v in rss_videos(cid):
                if v["id"] not in known and v["id"] not in found:
                    found[v["id"]] = v
        except (requests.RequestException, ET.ParseError) as ex:
            log(f"  RSS {ch} fehlgeschlagen: {ex}")

    added = 0
    for vid, v in found.items():
        if v.get("duration") is not None and v["duration"] < CONFIG["min_duration_seconds"]:
            state["videos"][vid] = {"skipped": "kurz"}
            continue
        if not is_relevant(v, dest):
            state["videos"][vid] = {"skipped": "irrelevant"}
            continue
        v.pop("tags", None)
        state["queue"][vid] = v
        added += 1
    log(f"  Warteschlange: +{added}, total {len(state['queue'])}")


def requeue(state: dict, yt: YouTube, everything: bool, limit: int = 300) -> int:
    """Bereits ausgewertete Videos erneut in die Warteschlange legen.

    everything=False: nur Videos, deren Transkript blockiert war (sobald ein Proxy eingerichtet ist).
    everything=True:  alle ausgewerteten Videos, z. B. nach geänderten Auswertungsregeln."""
    ids = [vid for vid, r in state["videos"].items()
           if "transcript" in r and vid not in state["queue"]
           and (everything or (r["transcript"] == "blockiert" and not r.get("retried")))][:limit]
    if not ids:
        return 0
    for item in yt.videos(ids):
        sn = item["snippet"]
        state["queue"][item["id"]] = {
            "id": item["id"], "title": sn.get("title", ""), "channel": sn.get("channelTitle", ""),
            "published": sn.get("publishedAt", "")[:10], "description": sn.get("description", ""),
            "duration": parse_duration(item["contentDetails"].get("duration")), "retry": True,
        }
    log(f"  {'Neu auswerten' if everything else 'Nachholen mit Transkript'}: {len(ids)} Videos erneut in der Warteschlange")
    return len(ids)


def to_spot(dest: dict, v: dict, sp, tstatus: str, geocode: Geocoder, anchors: dict):
    pos = locate_extracted(dest, sp, geocode, anchors)
    if not pos:
        return None, None
    new = extracted_spot(sp, hashlib.sha1(f"{v['id']}|{sp.name}".encode()).hexdigest()[:10], pos)
    mention = {
        "video_id": v["id"], "title": v["title"], "channel": v["channel"], "published": v["published"],
        "t": sp.timestamp_seconds, "quote": sp.quote, "rating": max(1, min(5, sp.rating)),
        "sentiment": sp.sentiment, "recommendation": sp.recommendation,
        "safety_rating": sp.safety_rating, "transcript": tstatus == "ok",
    }
    return new, mention


def process_destination(dest: dict, index: int, dests: list[dict], yt: YouTube | None, claude: Claude,
                        tapi, geocode: Geocoder) -> dict:
    did = dest["id"]
    log(f"\n=== {dest['name']} ({did}) ===")
    state_file = DATA_DIR / did / "state.json"
    spots_file = WEB_DATA / did / "spots.json"
    state = load_json(state_file, {"videos": {}, "queue": {}, "channels": {}, "backfill_done": False})
    spots = load_json(spots_file, [])
    units_before, tin, tout = (yt.units if yt else 0), claude.tokens_in, claude.tokens_out

    flags = sources_of(dest)
    if flags["youtube"]:
        collect_candidates(dest, yt, state, search_today(dest, index, dests, state))
    else:
        log("  YouTube-Quelle ausgeschaltet")
    limit = int(os.getenv("MAX_VIDEOS") or CONFIG["max_videos_per_run"]) if flags["youtube"] else 0
    if flags["youtube"] and yt and os.getenv("NEU_AUSWERTEN", "").strip().lower() in ("ja", "1", "true"):
        requeue(state, yt, everything=True)
    elif flags["youtube"] and yt and proxy_configured():
        requeue(state, yt, everything=False)
    # Erneut auszuwertende Videos immer vollständig in diesem Lauf, nicht über Nächte verteilt
    if flags["youtube"]:
        limit = max(limit, sum(1 for v in state["queue"].values() if v.get("retry")))

    schema = extraction_model(dest)
    anchors = region_anchors(dest, geocode)
    # Erneut auszuwertende Videos zuerst, danach die neuesten
    queue = sorted(state["queue"].values(), key=lambda v: v["published"], reverse=True)
    queue = sorted(queue, key=lambda v: not v.get("retry"))[:limit]
    stats = {"videos": 0, "spots_new": 0, "transcripts": {"ok": 0, "keins": 0, "blockiert": 0, "fehler": 0}}
    stop = False

    for v in queue:
        log(f"▶ {v['published']} {v['channel']} – {v['title'][:70]}")
        transcript, tstatus = fetch_transcript(tapi, v["id"], dest["languages"])
        stats["transcripts"][tstatus] += 1
        comments = yt.comments(v["id"], CONFIG["max_comments"]) if yt else []
        try:
            result = claude.extract(dest, schema, build_prompt(v, comments, transcript))
        except anthropic.RateLimitError:
            log("    Claude-Ratenlimit erreicht, Rest folgt beim nächsten Lauf")
            break
        except anthropic.APIStatusError as ex:
            log(f"    Claude-Fehler {ex.status_code}: {ex.message}")
            if ex.status_code in (400, 401, 403):
                stop = True  # Konfigurationsproblem (Schlüssel, Guthaben) – nicht weiter Geld verbrennen
                break
            continue
        except anthropic.APIConnectionError:
            log("    Claude nicht erreichbar, Video bleibt in der Warteschlange")
            continue

        del state["queue"][v["id"]]
        stats["videos"] += 1
        if v.get("retry"):
            remove_mentions(spots, v["id"])
        record = {"title": v["title"], "channel": v["channel"], "published": v["published"],
                  "transcript": tstatus, "spots": 0}
        if v.get("retry"):
            record["retried"] = True
        state["videos"][v["id"]] = record
        if not result or not result.relevant:
            record["skipped"] = "irrelevant" if result else "abgelehnt"
            continue

        for sp in result.spots:
            new, mention = to_spot(dest, v, sp, tstatus, geocode, anchors)
            if not new:
                log(f"    ✗ ohne Standort: {sp.name} ({sp.place})")
                continue
            before = len(spots)
            merge_spot(spots, new, mention)
            stats["spots_new"] += len(spots) - before
            record["spots"] += 1
            log(f"    ✓ {sp.name} [{new['precision']}] {sp.rating}/5")

    if anchors:
        fixed = check_spots(spots, dest, geocode, anchors)
        if fixed:
            log(f"  Standortprüfung: {fixed} Korrekturen")
    finalize(spots)
    routes = build_routes(dest, geocode)
    annotate_routes(spots, routes)
    save_json(spots_file, spots, compact=True)
    save_json(state_file, state)

    # Weitere Quellen
    osm_kinds = [k for k in quellen.OSM_KINDS if flags[k]]
    if osm_kinds:
        osm = quellen.fetch_osm(dest, osm_kinds, anchors)
        if osm is not None:
            save_json(WEB_DATA / did / "osm.json", osm, compact=True)
    if flags["opendata"] and dest.get("opendata"):
        od = quellen.fetch_opendata(dest, anchors)
        if od is not None:
            save_json(WEB_DATA / did / "opendata.json", od, compact=True)
    web_stats = quellen.run_web(dest, state, claude, schema, geocode, anchors) if flags["web"] and not stop else {}
    save_json(state_file, state)
    counts = quellen.merge_places(dest, flags, routes)

    meta_file = WEB_DATA / did / "meta.json"
    meta = load_json(meta_file, {})
    run = {
        "date": iso(now_utc()), "videos": stats["videos"], "spots_new": stats["spots_new"], "web": web_stats,
        "transcripts": stats["transcripts"], "youtube_units": (yt.units if yt else 0) - units_before,
        "claude_tokens": [claude.tokens_in - tin, claude.tokens_out - tout], "model": claude.model,
    }
    # Web-Kosten bucht quellen.run_web selbst; hier nur die Videoauswertung
    video_tokens = [run["claude_tokens"][0] - web_stats.get("tokens_in", 0), run["claude_tokens"][1] - web_stats.get("tokens_out", 0)]
    run["cost_usd"] = round(cost_usd(claude.model, *video_tokens) + web_stats.get("usd", 0), 4)
    # Vor dem Speichern von meta.json buchen, damit das einmalige Übernehmen alter Läufe nichts doppelt zählt
    book("abruf", claude.model, *video_tokens, ziel=did, youtube_units=run["youtube_units"], videos=stats["videos"])
    save_json(meta_file, {
        "last_run": run["date"], "spots": len(spots),
        "videos_total": sum(1 for x in state["videos"].values() if "transcript" in x),
        "queue": len(state["queue"]), "history": meta.get("history", [])[-59:] + [run],
        "counts": counts, "errors": quellen.ERRORS.get(did, {}),
    })
    log(f"  Fertig: {stats['videos']} Videos, {stats['spots_new']} neue Plätze, {len(spots)} total, "
        f"Transkripte {stats['transcripts']}, ca. {run['cost_usd']} USD")
    return {"stop": stop}


def write_index():
    """docs/data/ziele.json: Übersicht aller Ziele für die Webapp."""
    index = []
    for d in load_destinations(only_active=True):
        meta = load_json(WEB_DATA / d["id"] / "meta.json", {})
        routes = load_json(WEB_DATA / d["id"] / "routes.json", {}).get("routes", [])
        index.append({
            "id": d["id"], "name": d["name"], "bbox": d["bbox"],
            "regions": [r["name"] for r in d["regions"]],
            "routes": [{k: r[k] for k in ("id", "name", "color", "length_km")} for r in routes],
            "schedule": d.get("schedule", "taeglich"), "weekday": d.get("weekday", 1),
            "links": d.get("links", []), "sources": sources_of(d), "counts": meta.get("counts", {}),
            "youtube_ready": bool(d.get("search_queries") or d.get("channels")),
            "errors": meta.get("errors", {}), "opendata": [o["name"] for o in d.get("opendata", [])],
            "spots": meta.get("counts", {}).get("total", meta.get("spots", 0)), "last_run": meta.get("last_run"), "queue": meta.get("queue", 0),
            "videos_total": meta.get("videos_total", 0), "last": (meta.get("history") or [None])[-1],
        })
    save_json(WEB_DATA / "ziele.json", {
        "repo": REPO, "ziele": index, "model": CONFIG["claude_model"],
        "fixkosten": CONFIG.get("fixkosten", []), "youtube_budget": CONFIG["youtube_daily_budget"],
        "standard_links": CONFIG.get("standard_links", []),
    })


# --------------------------------------------------------------------------- Vergleich


def compare(dests: list[dict], n: int, yt: YouTube | None):
    """Dieselben Videos mit zwei Modellen auswerten und als Bericht gegenüberstellen. Ändert keine Daten."""
    a, b = Claude(CONFIG["claude_model"]), Claude(CONFIG["compare_model"])
    tapi = transcript_client()
    lines = [f"# Modellvergleich {dt.date.today()}", "",
             f"**A:** `{a.model}`  ·  **B:** `{b.model}`", ""]
    for dest in dests:
        state = load_json(DATA_DIR / dest["id"] / "state.json", {"videos": {}, "queue": {}})
        pool = [{"id": k, **v} for k, v in state["videos"].items() if v.get("transcript") == "ok"]
        pool += [v for v in state["queue"].values()]
        pool = sorted(pool, key=lambda v: v.get("published", ""), reverse=True)[:n]
        if not pool:
            lines += [f"## {dest['name']}", "", "Noch keine Videos vorhanden – zuerst einen normalen Lauf starten.", ""]
            continue
        schema = extraction_model(dest)
        lines += [f"## {dest['name']}", ""]
        for v in pool:
            meta = state["queue"].get(v["id"]) or v
            if "description" not in meta and yt:
                item = yt.videos([v["id"]])
                if item:
                    meta = {**meta, "description": item[0]["snippet"].get("description", "")}
            meta.setdefault("description", "")
            transcript, tstatus = fetch_transcript(tapi, v["id"], dest["languages"])
            comments = yt.comments(v["id"], CONFIG["max_comments"]) if yt else []
            prompt = build_prompt(meta, comments, transcript)
            lines += [f"### [{meta['title']}](https://youtu.be/{v['id']})", f"{meta['channel']} · {meta['published']} · Transkript: {tstatus}", ""]
            for label, c in (("A", a), ("B", b)):
                try:
                    r = c.extract(dest, schema, prompt)
                except anthropic.APIError as ex:
                    lines.append(f"- **{label}:** Fehler {ex}")
                    continue
                if not r or not r.relevant:
                    lines.append(f"- **{label}:** {'nicht relevant' if r else 'keine Antwort'}")
                    continue
                spots = "; ".join(
                    f"{s.name} ({s.spot_type}, {s.rating}/5{', Koord.' if s.latitude is not None else ''}"
                    f"{', t=' + str(s.timestamp_seconds) + 's' if s.timestamp_seconds else ''})" for s in r.spots)
                lines.append(f"- **{label}:** {len(r.spots)} Plätze – {spots or '–'}")
            lines.append("")
    lines += ["## Kosten", "", "| Modell | Tokens ein | Tokens aus | USD |", "|---|---|---|---|",
              f"| {a.model} | {a.tokens_in} | {a.tokens_out} | {a.cost_usd()} |",
              f"| {b.model} | {b.tokens_in} | {b.tokens_out} | {b.cost_usd()} |"]
    for c in (a, b):
        book("vergleich", c.model, c.tokens_in, c.tokens_out, ziel=",".join(d["id"] for d in dests),
             youtube_units=yt.units if yt and c is a else 0)
    report = "\n".join(lines) + "\n"
    out = ROOT / "berichte" / f"vergleich-{dt.date.today()}.md"
    out.parent.mkdir(exist_ok=True)
    out.write_text(report, encoding="utf-8")
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(report)
    log(report)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ziel", default=os.getenv("ZIEL") or None, help="nur dieses Ziel (id)")
    ap.add_argument("--vergleich", type=int, default=int(os.getenv("VERGLEICH") or 0),
                    help="Anzahl Videos für den Modellvergleich")
    ap.add_argument("--nur-index", action="store_true", help="nur docs/data/ziele.json neu schreiben")
    args = ap.parse_args()

    if args.nur_index or args.ziel == "-":
        write_index()
        return
    if not os.getenv("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY fehlt (GitHub → Settings → Secrets and variables → Actions)")
    yt_key = os.getenv("YOUTUBE_API_KEY")
    yt = YouTube(yt_key) if yt_key else None
    if not yt:
        log("Kein YOUTUBE_API_KEY: nur RSS-Feeds der Kanallisten werden abgefragt")

    all_dests = load_destinations()
    dests = [d for d in all_dests if not args.ziel or d["id"] == args.ziel]
    if not dests:
        sys.exit(f"Ziel «{args.ziel}» nicht gefunden oder nicht aktiv")
    if os.getenv("GITHUB_EVENT_NAME") == "schedule" and not args.ziel:
        today = dt.date.today().isoformat()
        dests = [d for d in dests if is_due(d)
                 and (load_json(WEB_DATA / d["id"] / "meta.json", {}).get("last_run") or "")[:10] != today]
        log(f"Zeitplan: heute fällig und noch nicht gelaufen {[d['id'] for d in dests] or 'keine Ziele'}")
        if not dests:
            return

    if args.vergleich:
        compare(dests, args.vergleich, yt)
        return

    claude, tapi, geocode = Claude(), transcript_client(), Geocoder()
    try:
        for d in dests:
            if process_destination(d, all_dests.index(d), all_dests, yt, claude, tapi, geocode)["stop"]:
                break
    finally:
        geocode.save()
        write_index()
    log(f"\nGesamt: YouTube {yt.units if yt else 0} Einheiten, Claude ca. {claude.cost_usd()} USD")


if __name__ == "__main__":
    main()
