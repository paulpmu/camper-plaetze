# Camper-Plätze

Webapp für iPhone und iPad mit Übernachtungsplätzen für Camper. Die Plätze stammen aus aktuellen YouTube-Reisevideos von Overlandern. Es gibt mehrere Reiseziele, zum Start **Marokko & Dakhla** und **Spanien & Portugal**, jeweils mit Routen. Neue Ziele lassen sich direkt aus der Webapp anfordern.

**Webapp:** https://paulpmu.github.io/camper-plaetze/

**Betrieb, Kosten und Pflege:** siehe [BETRIEB.md](BETRIEB.md)

```
GitHub Action (täglich 03:17 UTC), pro Ziel:
  ├─ YouTube Data API: Suche in mehreren Sprachen + RSS-Feeds fester Kanäle
  ├─ Transkripte (youtube-transcript-api, optional über Proxy)
  ├─ Claude Haiku: Plätze, Typ, Infrastruktur, Zufahrt, Sicherheit, Bewertung
  ├─ fehlende Koordinaten über OpenStreetMap Nominatim, Strassenverlauf der Routen über OSRM
  └─ docs/data/<ziel>/spots.json → GitHub Pages → Safari auf iPhone/iPad

Anfrage aus der Webapp («Ziel hinzufügen oder ändern»):
  Webapp → GitHub-Issue «[Ziel] …» → Action → Claude erstellt ziele/<id>.json → Abruf startet → Antwort im Issue
```

## Einrichtung (einmalig, etwa 30 Minuten)

### 1. YouTube-Schlüssel (Google Cloud), gratis

1. https://console.cloud.google.com öffnen und mit einem Google-Konto anmelden.
2. Oben links **Projekt auswählen**, dann **Neues Projekt**. Name zum Beispiel `camper-plaetze`, dann **Erstellen**.
3. Menü **APIs & Dienste → Bibliothek**, nach **YouTube Data API v3** suchen und auf **Aktivieren** tippen.
4. **APIs & Dienste → Anmeldedaten**, dann **+ Anmeldedaten erstellen → API-Schlüssel**.
5. Den Schlüssel kopieren (beginnt mit `AIza…`). Empfohlen: **Schlüssel einschränken → API-Einschränkungen → YouTube Data API v3**.

### 2. Anthropic-Schlüssel (Claude API)

1. https://console.anthropic.com öffnen und ein Konto anlegen.
2. **Settings → Billing**: Guthaben aufladen, 10 USD reichen für Monate. Ein monatliches Ausgabenlimit ist empfehlenswert.
3. **Settings → API Keys → Create Key**, Name `camper-plaetze`. Den Schlüssel kopieren (beginnt mit `sk-ant-…`). Er wird nur einmal angezeigt.

### 3. Schlüssel in GitHub hinterlegen

Im Repository **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Wert |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-…` |
| `YOUTUBE_API_KEY` | `AIza…` |

### 4. GitHub Pages einschalten

**Settings → Pages → Build and deployment → Source: GitHub Actions**.

### 5. Ersten Lauf starten

**Actions → «Plätze aktualisieren & Webapp veröffentlichen» → Run workflow**. Im ersten Lauf werden pro Ziel die Videos der letzten 12 Monate in eine Warteschlange gelegt. Pro Lauf und Ziel werden höchstens 40 Videos ausgewertet, die neuesten zuerst.

### 6. Modellvergleich (empfohlen, einmalig)

Nach dem ersten Lauf: **Run workflow**, bei «Modellvergleich» `10` eintragen. Zehn Videos werden dann mit Haiku und mit Opus ausgewertet und nebeneinandergestellt. Das kostet einmalig etwa 1 USD. Den Bericht finden Sie in der Zusammenfassung des Laufs und unter `berichte/`. Gefällt Ihnen Opus deutlich besser, ändern Sie in `config.json` `claude_model` auf `claude-opus-5-5` oder als Mittelweg auf `claude-sonnet-5-5`.

### 7. Auf dem iPhone oder iPad installieren

Die Webapp in Safari öffnen, auf **Teilen** tippen, dann **Zum Home-Bildschirm**. Sie startet danach wie eine App im Vollbild. Die zuletzt geladenen Plätze bleiben offline verfügbar.

## Ziele und Routen

Jedes Ziel ist eine Datei in `ziele/`, zum Beispiel `marokko.json` oder `iberia.json`. Sie enthält Suchbegriffe, Stichwörter, Regionen, Kartenausschnitt, Kanäle und Routen. Routen sind Wegpunkte in Fahrreihenfolge. Die App berechnet daraus den Strassenverlauf und für jeden Platz den Streckenkilometer sowie den Abstand zur Route.

In der App: Unter **Filter → Route** zeigt die Liste nur Plätze entlang der Strecke, sortiert nach Kilometer. Das eignet sich zur Etappenplanung.

### Ziel hinzufügen oder ändern, direkt aus der Webapp

Tippen Sie auf den Zielnamen oben links und dann auf **Ziel hinzufügen oder ändern**. Schreiben Sie frei, was Sie möchten, zum Beispiel:

- «Neues Ziel Norwegen mit Lofoten, Route Oslo – Trondheim – Bodø – Nordkap»
- «Bei Marokko den Kanal @beispielkanal ergänzen»
- «Spanien & Portugal deaktivieren»
- «Marokko jetzt aktualisieren»

Die App öffnet GitHub mit der vorbereiteten Anfrage, Sie tippen auf **Submit new issue**. Claude erstellt oder ändert daraufhin das Ziel und startet den Abruf. Die Antwort erscheint in der Anfrage und in der App unter «Letzte Anfragen». Ist etwas unklar, stellt Claude eine Rückfrage. Sie antworten mit einem Kommentar in der Anfrage.

Verarbeitet werden nur Anfragen des Repository-Inhabers. Dafür müssen Sie in Safari bei GitHub angemeldet sein.

**YouTube-Kontingent:** Alle Ziele zusammen haben etwa 90 Suchbegriffe pro Tag zur Verfügung. Bei mehr Zielen verteilt die App die Suchen automatisch über mehrere Tage.

## Transkripte

Das Transkript enthält am meisten Ortsangaben. YouTube stellt es offiziell nicht für fremde Videos bereit, deshalb nutzt die App die Bibliothek `youtube-transcript-api`. Das bewegt sich im **Graubereich der YouTube-Nutzungsbedingungen**.

YouTube sperrt solche Abrufe von GitHub-Servern häufig. Das Video wird dann ohne Transkript ausgewertet. Wie oft das passiert, steht in `docs/data/<ziel>/meta.json` unter `transcripts.blockiert`. Bei vielen Sperren hilft ein Residential-Proxy, etwa Webshare für rund 3–7 USD pro Monat:

| Name | Wert |
|---|---|
| `WEBSHARE_USER` / `WEBSHARE_PASS` | Proxy-Benutzername und -Passwort von Webshare |
| `TRANSCRIPT_PROXY_URL` | alternativ ein beliebiger Proxy: `http://user:pass@host:port` |

Sobald ein Proxy eingetragen ist, wertet die App alle Videos, deren Transkript früher blockiert war, automatisch einmal neu aus. Die alten Plätze dieser Videos werden dabei ersetzt.

## Einstellungen: `config.json`

| Feld | Bedeutung |
|---|---|
| `claude_model` | Auswertung der Videos, Standard `claude-haiku-5-5` |
| `compare_model` | Vergleichsmodell für den Modellvergleich |
| `request_model` | Verarbeitung der Anfragen aus der Webapp, Standard `claude-opus-5-5`, selten und günstig |
| `max_videos_per_run` | Kostenbremse pro Ziel und Lauf |
| `route_corridor_km` | bis zu welchem Abstand ein Platz einer Route zugeordnet wird |

## iOverlander-Abgleich (optional)

Einen iOverlander-Export (CSV oder JSON) unter `data/<ziel>/ioverlander/` ablegen. Plätze im Umkreis von 250 m werden dann verknüpft.

## Kosten

- GitHub, YouTube, OpenStreetMap und OSRM: gratis
- Claude Haiku: etwa 0.002–0.005 USD pro Video, also etwa 1–4 USD pro Monat für zwei Ziele
- Anfragen aus der Webapp (Opus): etwa 0.05–0.15 USD pro Anfrage

Jeder Lauf schreibt die effektiven Kosten nach `docs/data/<ziel>/meta.json`.

## Grenzen

- Die Bewertungen geben die subjektiven Aussagen der YouTuber wieder und sind keine geprüfte Platzqualität.
- Plätze ohne Koordinaten im Video werden auf den genannten Ort gesetzt. Die App zeigt sie mit gestricheltem Marker als «ungefährer Standort».
- Die Regeln zum Wildcampen ändern sich und werden lokal unterschiedlich durchgesetzt, etwa auf der N1 nach Dakhla oder in Portugal. Standardmässig zeigt die App nur Plätze aus den letzten 12 Monaten.

## Lokal testen

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=… YOUTUBE_API_KEY=…
MAX_VIDEOS=3 python scripts/update.py --ziel marokko
cd docs && python -m http.server 8000   # → http://localhost:8000
```
