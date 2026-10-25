# Betriebshandbuch Camper-Plätze

Stand: 25. Oktober 2026 · Inhaber: Paul Müller · Repository: https://github.com/paulpmu/camper-plaetze

Dieses Dokument beschreibt, was wo läuft, was es kostet und wie das Werkzeug gepflegt wird. Die technische Einrichtung steht im [README](README.md).

---

## 1. Überblick: Was passiert wo?

```
               jede Nacht 04:17 (Winterzeit) / 05:17 (Sommerzeit)
                                 │
                    ┌────────────▼─────────────┐
                    │  GitHub Actions (Abruf)  │
                    └─┬──────┬──────┬──────┬───┘
       Videos suchen  │      │      │      │  Plätze herauslesen
   ┌──────────────────▼┐  ┌──▼──────────┐  ┌▼───────────────────┐
   │ YouTube Data API  │  │ Webshare    │  │ Anthropic Claude   │
   │ (Google Cloud)    │  │ → YouTube   │  │ (Haiku)            │
   │ Titel, Kommentare │  │ Transkripte │  │                    │
   └───────────────────┘  └─────────────┘  └────────────────────┘
                                 │  Orte → Koordinaten, Routenverlauf
                    ┌────────────▼─────────────┐
                    │ OpenStreetMap / OSRM     │
                    └────────────┬─────────────┘
                                 │  Daten werden im Repository gespeichert
                    ┌────────────▼─────────────┐
                    │ GitHub Pages (Webapp)    │ ◄── Safari auf iPhone / iPad
                    └──────────────────────────┘
```

### Plattformen und ihre Rolle

| Plattform | Wofür | Konto / Zugang | Wo verwaltet |
|---|---|---|---|
| **GitHub** | Code und Daten, nächtlicher Abruf (Actions), Webapp (Pages), Anfragen (Issues) | `paulpmu` | https://github.com/paulpmu/camper-plaetze |
| **Google Cloud** | YouTube Data API: Videos suchen, Beschreibungen und Kommentare lesen | Ihr Google-Konto, Projekt `camper-plaetze` | https://console.cloud.google.com |
| **Anthropic** | Claude liest die Videos aus und bearbeitet Anfragen aus der App | paul_p_mueller@bluewin.ch | https://console.anthropic.com |
| **Webshare** | Rotating-Residential-Proxy, damit YouTube die Transkripte herausgibt | paul_p_mueller@bluewin.ch | https://dashboard.webshare.io |
| OpenStreetMap Nominatim | wandelt Ortsnamen in Koordinaten um | kein Konto, gratis | – |
| OSRM | Strassenverlauf der Routen | kein Konto, gratis | – |
| OpenStreetMap-Kacheln | Kartenbild in der App | kein Konto, gratis | – |

### Gespeicherte Schlüssel (GitHub Secrets)

Diese Schlüssel stehen unter **Settings → Secrets and variables → Actions** im Repository. Sie sind nicht einsehbar, nur ersetzbar.

| Secret | Herkunft | Ersetzen, wenn … |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Console → API Keys | der Schlüssel gelöscht oder kompromittiert ist |
| `YOUTUBE_API_KEY` | Google Cloud → APIs & Dienste → Anmeldedaten | dito |
| `WEBSHARE_USER` / `WEBSHARE_PASS` | Webshare → Rotating Residential → Proxy List | das Webshare-Passwort geändert wurde |

---

## 2. Die Abläufe im Detail

### 2.1 Nächtlicher Abruf

Workflow: «Plätze aktualisieren & Webapp veröffentlichen», Datei `.github/workflows/update.yml`. Er läuft täglich um 03:17 UTC, das ist 04:17 Winterzeit bzw. 05:17 Sommerzeit.

Ablauf pro Ziel, zum Beispiel Marokko, dann Spanien & Portugal:

1. **Suchen:** YouTube nach den Suchbegriffen des Ziels der letzten 21 Tage durchsuchen und die RSS-Feeds fester Kanäle lesen.
2. **Vorfiltern:** Kurzvideos unter 3 Minuten und Videos ohne Bezug zum Ziel aussortieren. Das kostet nichts.
3. **Warteschlange:** Die neuen Videos kommen in eine Warteschlange. Pro Nacht und Ziel werden höchstens 40 ausgewertet, die neuesten zuerst.
4. **Auswerten:** Pro Video holt die App das Transkript über Webshare und die Kommentare über YouTube. Claude Haiku liest dann alles und liefert die Übernachtungsplätze mit Bewertung.
5. **Verorten:** Fehlen Koordinaten, sucht die App den genannten Ort über OpenStreetMap. In der App erscheint der Platz dann als «ungefährer Standort».
6. **Zusammenführen:** Derselbe Platz aus mehreren Videos ergibt einen Eintrag mit Durchschnittsbewertung.
7. **Routen:** Für jeden Platz werden Streckenkilometer und Abstand zur Route berechnet.
8. **Speichern und veröffentlichen:** Die Daten werden ins Repository geschrieben, die Webapp wird neu veröffentlicht.

Den Verlauf jedes Laufs sehen Sie unter **Actions**: grün heisst erfolgreich, rot heisst Fehler. Bei einem Fehler schickt GitHub Ihnen eine E-Mail.

### 2.2 Anfrage aus der Webapp

1. In der App tippen Sie auf den Zielnamen, dann auf **Ziel hinzufügen oder ändern**, schreiben einen Text und tippen auf **Anfrage senden**.
2. Auf GitHub öffnet sich ein vorbereitetes Issue mit dem Titel «[Ziel] …». Sie tippen auf **Submit**.
3. Der Workflow «Anfrage aus der Webapp verarbeiten» startet. Claude Opus erstellt oder ändert die Zieldatei in `ziele/`.
4. Die Antwort erscheint als Kommentar im Issue, das Issue wird geschlossen und der Abruf für dieses Ziel startet sofort.
5. Bei Unklarheiten stellt Claude eine Rückfrage. Sie antworten mit einem Kommentar im Issue.

Es werden nur Anfragen von Ihrem GitHub-Konto verarbeitet.

### 2.3 Manueller Start und Modellvergleich

Unter **Actions → Plätze aktualisieren → Run workflow** gibt es drei Felder:

| Feld | Wirkung |
|---|---|
| alle leer | normaler Abruf aller Ziele |
| **Ziel** = `marokko` | nur dieses Ziel |
| **Max. Videos** = `100` | mehr Videos in diesem Lauf, um die Warteschlange schneller abzubauen |
| **Modellvergleich** = `10` | 10 Videos mit Haiku und Opus vergleichen, ohne Daten zu ändern. Den Bericht finden Sie in der Zusammenfassung des Laufs und unter `berichte/`. |

---

## 3. Kosten

| Posten | Kosten | Bemerkung |
|---|---|---|
| GitHub (Repository, Actions, Pages) | **0** | gratis, weil das Repository öffentlich ist |
| YouTube Data API | **0** | 10'000 Einheiten pro Tag gratis, die App plant mit höchstens 9'000 |
| OpenStreetMap, OSRM | **0** | |
| Webshare Rotating Residential | **3.50 USD pro Monat** | 1 GB Datenvolumen, monatliches Abo |
| Claude Haiku (Videoauswertung) | **ca. 1–4 USD pro Monat** | gemessen: 0.03 USD für 40 Videos ohne Transkript. Mit Transkript geschätzt 0.002–0.005 USD pro Video |
| Claude Opus (Anfragen aus der App) | ca. 0.05–0.15 USD pro Anfrage | fällt nur bei Anfragen an |
| **Total** | **ca. 5–8 USD pro Monat** | |

**Kostenbremsen:**
- **Anthropic:** Unter **Settings → Limits** ein Monatslimit setzen, empfohlen 20 USD. Mehr kann nie belastet werden.
- **Webshare:** Ist das Volumen aufgebraucht, kommen keine Transkripte mehr durch. Es entstehen keine Zusatzkosten.
- **App:** `max_videos_per_run` in `config.json` begrenzt die Auswertungen pro Nacht.

Die effektiven Kosten jedes Laufs stehen in `docs/data/<ziel>/meta.json` unter `history` → `cost_usd`.

---

## 4. Pflege

### 4.1 Routine: einmal pro Monat, etwa 5 Minuten

| Prüfen | Wo | Worauf achten |
|---|---|---|
| Läufe | Repository → **Actions** | Alle grün? Rote Läufe öffnen und den Fehler lesen, siehe 4.3 |
| Anthropic-Guthaben | console.anthropic.com → **Billing** | genug Guthaben? Wenn es leer ist, bricht die Auswertung ab |
| Webshare-Volumen | dashboard.webshare.io → **Dashboard** | Wie viel ist verbraucht? Über 80 % → grösseres Paket |
| Transkripte | `docs/data/marokko/meta.json` → letzter Eintrag unter `transcripts` | `ok` sollte die meisten Videos ausmachen, nicht `blockiert` |
| App | in Safari öffnen | Gibt es neue Plätze? Stimmt das Datum unter «i»? |

### 4.2 Inhalte anpassen

| Was | Wie |
|---|---|
| neues Ziel, Route oder Kanal | in der App über **Ziel hinzufügen oder ändern**, das ist der einfachste Weg |
| Ziel ausblenden | in der App, zum Beispiel «Spanien & Portugal deaktivieren» |
| Feineinstellungen | direkt auf GitHub die Datei in `ziele/` bzw. `config.json` öffnen, auf den Stift tippen, ändern und **Commit changes** |
| anderes Modell | in `config.json` `claude_model` ändern: `claude-haiku-5-5` ist günstig, `claude-sonnet-5-5` mittel, `claude-opus-5-5` am genausten |

### 4.3 Häufige Probleme und Lösungen

| Anzeichen | Ursache | Lösung |
|---|---|---|
| Lauf rot, Fehler 401 oder «credit balance» bei Claude | Anthropic-Guthaben leer oder Schlüssel ungültig | Guthaben aufladen bzw. neuen Schlüssel als `ANTHROPIC_API_KEY` eintragen |
| «YouTube-Kontingent aufgebraucht» | zu viele Suchbegriffe oder Ziele | Das löst sich am Folgetag von selbst. Dauerhaft: weniger Suchbegriffe pro Ziel |
| Transkripte meist `blockiert` | Webshare-Volumen aufgebraucht oder Passwort geändert | Webshare-Dashboard prüfen, Secrets aktualisieren |
| Transkripte meist `fehler` | YouTube hat etwas geändert und die Transkript-Bibliothek ist veraltet | Version in `requirements.txt` erhöhen, siehe 4.4 |
| Lauf rot mit Hinweis auf ein Modell | das Claude-Modell wurde abgelöst | In `config.json` das aktuelle Modell eintragen |
| nächtlicher Lauf startet nicht mehr | GitHub pausiert Zeitpläne nach 60 Tagen ohne Aktivität im Repository | Unter **Actions** den Workflow wieder aktivieren (**Enable workflow**) |
| App zeigt alte Daten | Safari-Cache | App schliessen und neu öffnen, notfalls neu laden |

### 4.4 Technische Wartung, etwa zweimal pro Jahr

- **Bibliotheken aktualisieren:** In `requirements.txt` sind die Versionen festgelegt, etwa `anthropic` und `youtube-transcript-api`. Bei der Transkript-Bibliothek lohnt sich ein Update, sobald Fehler auftauchen.
- **Modelle:** Anthropic veröffentlicht regelmässig neue Modelle. Mit einem Vergleichslauf (siehe 2.3) prüfen Sie, ob sich ein Wechsel lohnt.

**Am einfachsten mit Claude Code:** Starten Sie auf https://claude.ai/code eine neue Sitzung mit dem Repository `paulpmu/camper-plaetze` und beschreiben Sie das Problem oder den Wunsch, zum Beispiel «Die Läufe sind seit gestern rot, bitte prüfen und beheben» oder «Bitte Bibliotheken aktualisieren». Claude liest dieses Handbuch und den Code und nimmt die Änderung vor.

### 4.5 Pausieren oder stilllegen

| Ziel | Schritte |
|---|---|
| vorübergehend pausieren | **Actions** → Workflow «Plätze aktualisieren» → **…** → **Disable workflow**. Die App bleibt online mit den letzten Daten |
| Kosten stoppen | Webshare-Abo kündigen (**Subscription**), Anthropic-Guthaben nicht mehr aufladen |
| ganz stilllegen | zusätzlich unter **Settings → Pages** die Webapp abschalten und die API-Schlüssel bei Google und Anthropic löschen |

---

## 5. Wo liegt was im Repository?

| Pfad | Inhalt |
|---|---|
| `ziele/*.json` | ein Reiseziel pro Datei: Suchbegriffe, Regionen, Routen |
| `config.json` | globale Einstellungen: Modelle, Grenzen, Kontingent |
| `scripts/update.py` | nächtlicher Abruf und Auswertung |
| `scripts/anfrage.py` | Verarbeitung der Anfragen aus der App |
| `scripts/common.py` | Geodaten und Routenberechnung |
| `.github/workflows/` | Zeitplan und Abläufe auf GitHub |
| `docs/` | die Webapp; `docs/data/` enthält die veröffentlichten Plätze |
| `data/` | interner Zustand: bearbeitete Videos, Warteschlange, Geocache |
| `berichte/` | Modellvergleiche |

Der ganze Verlauf liegt in Git. Jede Datenänderung ist ein Commit und lässt sich jederzeit nachvollziehen oder zurücksetzen.

---

## 6. Rechtliches und Grenzen

- Die Transkripte werden über eine inoffizielle Schnittstelle abgerufen. Das bewegt sich im **Graubereich der YouTube-Nutzungsbedingungen**. Die App ist für den privaten Gebrauch gedacht.
- Die Bewertungen geben die subjektiven Aussagen der YouTuber wieder und sind keine geprüfte Platzqualität.
- Die Regeln zum Wildcampen ändern sich. Vor Ort gelten die lokalen Vorschriften. Die App zeigt deshalb standardmässig nur Plätze aus den letzten 12 Monaten.
- Die Webapp ist öffentlich erreichbar, aber nirgends verlinkt. Die Schlüssel sind nie in der App, sondern nur in GitHub Secrets gespeichert.
