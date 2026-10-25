# Marokko Camper

Webapp für iPhone und iPad mit Übernachtungsplätzen in Marokko und Dakhla. Die Plätze stammen aus aktuellen YouTube-Reisevideos von Camper-Overlandern. Eine GitHub Action sucht jede Nacht neue Videos und liest Titel, Beschreibung, Kapitelmarken, Kommentare und Transkript. Die Claude API leitet daraus Plätze mit Bewertung und Empfehlung ab. Die Karte wird über GitHub Pages ausgeliefert.

**Webapp:** https://paulpmu.github.io/marokko-camper/

```
GitHub Action (täglich 03:17 UTC)
  ├─ YouTube Data API: Suche in 4 Sprachen + RSS-Feeds fester Kanäle
  ├─ Transkripte (youtube-transcript-api, optional über Proxy)
  ├─ Claude API: Plätze, Typ, Infrastruktur, Zufahrt, Sicherheit, Bewertung
  ├─ Geocoding fehlender Koordinaten über OpenStreetMap Nominatim
  └─ docs/data/spots.json → GitHub Pages → Safari auf iPhone/iPad
```

## Einrichtung (einmalig, etwa 30 Minuten)

### 1. YouTube-Schlüssel (Google Cloud), gratis

1. https://console.cloud.google.com öffnen und mit einem Google-Konto anmelden.
2. Oben links **Projekt auswählen**, dann **Neues Projekt**. Name zum Beispiel `marokko-camper`, dann **Erstellen**.
3. Menü **APIs & Dienste → Bibliothek**, nach **YouTube Data API v3** suchen und auf **Aktivieren** tippen.
4. **APIs & Dienste → Anmeldedaten**, dann **+ Anmeldedaten erstellen → API-Schlüssel**.
5. Den Schlüssel kopieren (beginnt mit `AIza…`). Empfohlen: **Schlüssel einschränken → API-Einschränkungen → YouTube Data API v3**.

Das Gratiskontingent beträgt 10'000 Einheiten pro Tag. Die App braucht täglich etwa 1'300.

### 2. Anthropic-Schlüssel (Claude API), kostenpflichtig

1. https://console.anthropic.com öffnen und ein Konto anlegen.
2. **Settings → Billing**: Guthaben aufladen, zum Beispiel 20 USD. Dort lässt sich auch ein monatliches Ausgabenlimit setzen. Das ist empfehlenswert.
3. **Settings → API Keys → Create Key**, Name `marokko-camper`. Den Schlüssel kopieren (beginnt mit `sk-ant-…`). Er wird nur einmal angezeigt.

### 3. Schlüssel in GitHub hinterlegen

Im Repository **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Wert |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-…` |
| `YOUTUBE_API_KEY` | `AIza…` |

Die Schlüssel bleiben auch bei einem öffentlichen Repository geheim.

### 4. GitHub Pages einschalten

**Settings → Pages → Build and deployment → Source: GitHub Actions**.

### 5. Ersten Lauf starten

**Actions → «Plätze aktualisieren & Webapp veröffentlichen» → Run workflow**. Im ersten Lauf werden die Videos der letzten 12 Monate gesucht und in eine Warteschlange gelegt. Jeder Lauf wertet höchstens 25 Videos aus, die neuesten zuerst. Die Warteschlange ist deshalb nach einigen Tagen abgearbeitet. Wenn es schneller gehen soll, können Sie den Lauf manuell starten und bei «Max. Videos» zum Beispiel 100 eintragen.

### 6. Auf dem iPhone oder iPad installieren

Die Webapp in Safari öffnen, auf **Teilen** tippen, dann **Zum Home-Bildschirm**. Sie startet danach wie eine App im Vollbild. Die zuletzt geladenen Plätze bleiben auch offline verfügbar, die Kartenkacheln brauchen aber Netz.

## Transkripte

Das Transkript enthält am meisten Ortsangaben. YouTube stellt es offiziell nicht für fremde Videos bereit, deshalb nutzt die App die Bibliothek `youtube-transcript-api`. Das bewegt sich im **Graubereich der YouTube-Nutzungsbedingungen**.

YouTube sperrt solche Abrufe von Cloud-Adressen wie GitHub Actions häufig. In diesem Fall wertet die App das Video trotzdem aus, nur ohne Transkript. Wie oft das passiert, sehen Sie im Log jedes Laufs und in `docs/data/meta.json` unter `transcripts.blockiert`.

Wenn fast alle Transkripte blockiert sind, hilft ein Residential-Proxy, etwa Webshare «Residential» für rund 3–7 USD pro Monat. Dafür eines der beiden Secret-Paare ergänzen:

| Name | Wert |
|---|---|
| `WEBSHARE_USER` / `WEBSHARE_PASS` | Proxy-Benutzername und -Passwort von Webshare |
| `TRANSCRIPT_PROXY_URL` | alternativ ein beliebiger Proxy: `http://user:pass@host:port` |

## Anpassen: `config.json`

| Feld | Bedeutung |
|---|---|
| `search_queries` | Suchbegriffe, jeder kostet 100 YouTube-Einheiten pro Tag |
| `channels` | feste Kanäle, als `@handle` oder Kanal-ID `UC…`, abgefragt über den Gratis-RSS-Feed |
| `relevance_keywords` | Vorfilter: Nur Videos mit einem dieser Wörter gehen an Claude |
| `max_videos_per_run` | Kostenbremse pro Lauf |
| `claude_model` / `claude_effort` | Standard `claude-opus-5-5` / `medium`. Für tiefere Kosten `claude-sonnet-5-5` oder `claude-haiku-5-5` |
| `search_window_days` | wie weit die tägliche Suche zurückblickt |

## iOverlander-Abgleich (optional)

Bei iOverlander lassen sich Plätze pro Land exportieren (https://www.ioverlander.com/countries/morocco, Export als CSV oder JSON). Legen Sie die Datei unter `data/ioverlander/` ab. Plätze im Umkreis von 250 m werden dann verknüpft und in der App mit iOverlander-Link angezeigt. park4night hat keine offene Schnittstelle. Die App verlinkt deshalb nur die park4night-Karte an der jeweiligen Position.

## Kosten

- GitHub Actions und Pages bei einem öffentlichen Repository: gratis
- YouTube Data API: gratis
- Claude API mit Opus 5.5: etwa 0.03–0.10 USD pro Video mit Transkript. Bei 10–25 neuen Videos pro Tag sind das etwa 10–40 USD pro Monat. Die Anfangsphase mit dem Rückblick über 12 Monate kostet einmalig mehr. Jeder Lauf schreibt die effektiven Kosten nach `docs/data/meta.json`.

## Grenzen

- Die Bewertungen geben die subjektiven Aussagen der YouTuber wieder und sind keine geprüfte Platzqualität.
- Viele Videos nennen keinen exakten Standort. Solche Plätze werden auf den genannten Ort gesetzt und sind in der App als «ungefährer Standort» mit gestricheltem Marker gekennzeichnet.
- Die Regeln zum Wildcampen werden lokal unterschiedlich durchgesetzt. Ältere Videos können deshalb überholt sein. Standardmässig zeigt die App nur Plätze aus den letzten 12 Monaten.

## Lokal testen

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=… YOUTUBE_API_KEY=…
MAX_VIDEOS=3 python scripts/update.py
cd docs && python -m http.server 8000   # → http://localhost:8000
```
