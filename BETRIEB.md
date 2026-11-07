# Betriebshandbuch Camper-Planer

Stand: 7. November 2026 · Inhaber: Paul Müller · Repository: https://github.com/paulpmu/camper-plaetze (der Repository-Name bleibt `camper-plaetze`, die App heisst Camper-Planer)

Dieses Dokument beschreibt, was wo läuft, was es kostet und wie das Werkzeug gepflegt wird. Die technische Einrichtung steht im [README](README.md).

---

## 1. Überblick: Was passiert wo?

Jede Nacht um 04:17 (Winterzeit) bzw. 05:17 (Sommerzeit) startet **GitHub Actions** den Abruf:

1. **YouTube Data API** (Google Cloud): Videos suchen, Beschreibungen und Kommentare lesen.
2. **Webshare → YouTube**: Transkripte holen.
3. **Anthropic Claude (Haiku)**: Übernachtungsplätze herauslesen.
4. **OpenStreetMap / OSRM**: Ortsnamen in Koordinaten umwandeln, Routenverlauf berechnen.
5. **GitHub**: Daten speichern. **Cloudflare Pages** veröffentlicht die Webapp, geschützt durch **Cloudflare Access** (siehe 2.13). Bis zur Umstellung läuft sie noch über GitHub Pages.
6. **Safari auf iPhone/iPad** lädt die Webapp mit den neuen Plätzen.

In der Webapp unter **i → Läufe / Kosten / Handbuch** sehen Sie jederzeit den Stand der Läufe, die aufgelaufenen Kosten und dieses Handbuch.

### Plattformen und ihre Rolle

| Plattform | Wofür | Konto / Zugang | Wo verwaltet |
|---|---|---|---|
| **GitHub** | Code und Daten, nächtlicher Abruf (Actions), Anfragen (Issues) | `paulpmu` | https://github.com/paulpmu/camper-plaetze |
| **Cloudflare** | Webapp ausliefern (Pages) und Zugang nur für freigegebene Personen (Zero Trust Access) | paul_p_mueller@bluewin.ch | https://dash.cloudflare.com, https://one.dash.cloudflare.com |
| **Google Cloud** | YouTube Data API: Videos suchen, Beschreibungen und Kommentare lesen | Ihr Google-Konto, Projekt `camper-plaetze` | https://console.cloud.google.com |
| **Anthropic** | Claude liest Videos und Reiseberichte aus, sucht Reiseberichte im Web und bearbeitet Anfragen aus der App | paul_p_mueller@bluewin.ch | https://console.anthropic.com |
| **Cloudflare D1 und R2** | Datenbank mit Personen, Rollen, Favoriten, Notizen, Logbuch und eigenen Plätzen; Fotospeicher | Ihr Cloudflare-Konto | https://dash.cloudflare.com → Storage & Databases |
| GitHub, privat (alt) | frühere Ablage von eigenen Plätzen und Merkliste, nur noch für die einmalige Übernahme | `paulpmu` | https://github.com/paulpmu/camper-plaetze-privat |
| **Webshare** | Rotating-Residential-Proxy, damit YouTube die Transkripte herausgibt | paul_p_mueller@bluewin.ch | https://dashboard.webshare.io |
| OpenStreetMap Nominatim | wandelt Ortsnamen in Koordinaten um | kein Konto, gratis | – |
| OSRM | Strassenverlauf der Routen | kein Konto, gratis | – |
| OpenStreetMap-Kacheln | Kartenbild in der App | kein Konto, gratis | – |
| Open-Meteo | Wetterprognosen und Ensembles, direkt aus der App abgerufen | kein Konto, gratis (nicht-kommerziell) | https://open-meteo.com |
| MeteoAlarm (EUMETNET) | offizielle Unwetterwarnungen; Regionsumrisse von gitlab.com/meteoalarm-pm-group | kein Konto, gratis (CC BY 4.0) | https://meteoalarm.org |
| MeteoSchweiz Open Data | Lokalprognose für Plätze in der Schweiz | kein Konto, gratis | https://opendatadocs.meteoswiss.ch |
| Wikimedia Commons, Wikipedia, Panoramax | Fotos, Strassenbilder und bekannte Orte in der Nähe eines Platzes | kein Konto, gratis | – |
| Mapillary (optional) | Vorschaubilder von Strassenbildern | gratis Client-Token, nur auf Ihrem Gerät | https://www.mapillary.com/dashboard/developers |

### Gespeicherte Schlüssel (GitHub Secrets)

Diese Schlüssel stehen unter **Settings → Secrets and variables → Actions** im Repository. Sie sind nicht einsehbar, nur ersetzbar.

| Secret | Herkunft | Ersetzen, wenn … |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Console → API Keys | der Schlüssel gelöscht oder kompromittiert ist |
| `YOUTUBE_API_KEY` | Google Cloud → APIs & Dienste → Anmeldedaten | dito |
| `WEBSHARE_USER` / `WEBSHARE_PASS` | Webshare → Rotating Residential → Proxy List | das Webshare-Passwort geändert wurde |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens, Recht «Cloudflare Pages: Edit» | der Schlüssel abläuft oder kompromittiert ist |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → Workers & Pages, rechts «Account ID» | nie, ausser bei Kontowechsel |

Dazu kommt unter **Variables** die Variable `HOSTING` mit dem Wert `cloudflare`. Sie schaltet die Veröffentlichung von GitHub Pages auf Cloudflare um.

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

### 2.2 Zeitplan pro Ziel

Jedes Ziel hat einen eigenen Zeitplan:

| Zeitplan | Wirkung |
|---|---|
| **täglich** | jede Nacht abrufen |
| **wöchentlich** | einmal pro Woche, Standard Montag. Den Wochentag ändern Sie per Anfrage, etwa «Spanien wöchentlich am Freitag» |
| **nur manuell** | nie automatisch, nur über «Jetzt aktualisieren» |

Umstellen in der App: Zielname antippen, dann beim Ziel das Auswahlfeld ändern. Dafür braucht es den GitHub-Schlüssel, siehe 2.4. Bezahlt wird pro neuem Video, nicht pro Lauf. Häufigere Läufe kosten deshalb kaum mehr, die Daten sind aber aktueller.

### 2.3 Anfrage aus der Webapp

1. In der App tippen Sie auf den Zielnamen, schreiben unter **Ziel hinzufügen oder ändern** einen Text und tippen auf **Anfrage senden**.
2. Mit GitHub-Schlüssel geht die Anfrage direkt an GitHub. Ohne Schlüssel öffnet sich ein vorbereitetes Issue «[Ziel] …», und Sie tippen dort auf **Submit**.
3. Der Workflow «Anfrage aus der Webapp verarbeiten» startet. Claude Opus erstellt oder ändert die Zieldatei in `ziele/`.
4. Die Antwort erscheint als Kommentar im Issue, das Issue wird geschlossen und der Abruf für dieses Ziel startet sofort.
5. Bei Unklarheiten stellt Claude eine Rückfrage. Sie antworten mit einem Kommentar im Issue.

Es werden nur Anfragen von Ihrem GitHub-Konto verarbeitet.

### 2.4 Steuerung direkt aus der App (GitHub-Schlüssel)

Mit einem persönlichen GitHub-Schlüssel auf dem iPhone oder iPad steuern Sie alles direkt aus der App:
- **Zielliste:** Zeitplan ändern, **Jetzt aktualisieren**
- **i → Läufe:** **Alle Ziele aktualisieren**, **Modellvergleich**, **Alle Videos neu auswerten**
- **Anfragen** gehen ohne Umweg über die GitHub-Seite

**Schlüssel erstellen** (einmalig, etwa 3 Minuten):
1. https://github.com/settings/personal-access-tokens/new öffnen.
2. **Token name:** `camper-plaetze iPhone`. **Expiration:** zum Beispiel 1 Jahr.
3. **Repository access:** **Only select repositories** → `camper-plaetze`.
4. Zusätzlich `camper-plaetze-privat` auswählen, solange Sie Ihre alten Daten noch übernehmen möchten (siehe 2.14).
5. **Permissions → Repository permissions:** **Actions**, **Contents** und **Issues** je auf **Read and write**. **Metadata** setzt GitHub automatisch auf «Read».
6. **Generate token**, dann den Schlüssel (`github_pat_…`) kopieren.
7. In der App: Zielname antippen, ganz nach unten scrollen, Schlüssel einfügen, **Speichern & prüfen**. Es erscheint «Verbunden als paulpmu».

Der Schlüssel bleibt nur auf diesem Gerät, im Speicher von Safari. Wer das entsperrte Gerät hat, kann damit das Repository verändern, aber nichts anderes. Läuft er ab oder geht das Gerät verloren, löschen Sie ihn unter https://github.com/settings/personal-access-tokens und erstellen einen neuen.

### 2.5 Manueller Start auf GitHub und Modellvergleich

Ohne App: Unter **Actions → Plätze aktualisieren → Run workflow** gibt es diese Felder:

| Feld | Wirkung |
|---|---|
| alle leer | normaler Abruf aller Ziele |
| **Ziel** = `marokko` | nur dieses Ziel |
| **Max. Videos** = `100` | mehr Videos in diesem Lauf, um die Warteschlange schneller abzubauen |
| **Modellvergleich** = `10` | 10 Videos mit Haiku und Opus vergleichen, ohne Daten zu ändern. Den Bericht finden Sie in der Zusammenfassung des Laufs und unter `berichte/`. |
| **neu_auswerten** = `ja` | alle bisherigen Videos mit den aktuellen Regeln neu auswerten, zum Beispiel nach Änderungen am Prompt |

### 2.6 Standortgenauigkeit und park4night

Jeder Platz hat eine von vier Genauigkeitsstufen:

| Stufe | Bedeutung | Darstellung |
|---|---|---|
| **genaue Koordinaten** | Koordinaten oder Kartenlink im Video | Marker durchgezogen |
| **Platz verortet** | benannter Platz (Camping, Strand, See …) über OpenStreetMap gefunden | Marker durchgezogen |
| **ungefähr** | nur der Ort ist bekannt, der Marker steht in der Ortsmitte | Marker gestrichelt |
| **nur Region** | nur eine Gegend ist bekannt | nicht auf der Karte, nur in der Liste |

### 2.7 Quellen pro Ziel

Jedes Ziel wählt seine Quellen selbst, alle Kombinationen sind möglich. In der App: Zielname antippen → **Quellen**.

| Quelle | Was | Kosten | Aktualisiert |
|---|---|---|---|
| **YouTube-Videos** | Overlander-Videos, ausgewertet von Claude Haiku. Braucht Suchbegriffe, die Sie per Anfrage ergänzen. | ca. 1–4 USD/Monat | gemäss Zeitplan |
| **OSM Stellplätze** | `tourism=caravan_site` aus OpenStreetMap | gratis | bei jedem Lauf |
| **OSM Campingplätze** | `tourism=camp_site`, ohne reine Zeltplätze | gratis | bei jedem Lauf |
| **OSM Entsorgung** | `amenity=sanitary_dump_station` | gratis | bei jedem Lauf |
| **Reiseberichte** | Claude Sonnet sucht einmal pro Woche aktuelle Blogs und Forenbeiträge. Claude Haiku liest bis zu 12 Seiten pro Lauf aus. Seiten, die das per robots.txt verbieten, sowie Plattformen wie park4night werden ausgelassen. | ca. 0.50–1 USD/Monat pro Ziel | wöchentliche Suche |
| **Offene Datensätze** | amtliche oder freie Listen als CSV, GeoJSON oder JSON mit offener Lizenz. Ergänzen per Anfrage mit Download-Adresse, z. B. «Bei Spanien den Datensatz https://… (CC BY) ergänzen». | gratis | bei jedem Lauf |
| **Eigene Plätze** | von Ihnen erfasst, siehe 2.8 | gratis | sofort |

**Neue Ziele** (per Anfrage) starten ohne YouTube, dafür mit allen anderen Quellen: OSM-Stellplätze, -Camping, -Entsorgung, Reiseberichte und offene Datensätze. Die YouTube-Suchbegriffe werden trotzdem angelegt. YouTube lässt sich später unter **Quellen** per Schalter dazunehmen.

**Zusammenführen und Bestätigung:** Nach jedem Lauf werden alle aktiven Quellen zu einer Liste zusammengeführt (`docs/data/<ziel>/places.json`):
- Derselbe Platz aus Video und Blog wird ein Eintrag.
- Passt ein Bericht namentlich zu einem OpenStreetMap-Eintrag oder Datensatz in der Nähe, übernimmt er dessen **genaue Koordinaten** und gilt als **bestätigt**. Auf der Karte hat er einen goldenen Rand.
- Die **Verlässlichkeit** von 0 bis 100 setzt sich zusammen aus Standortgenauigkeit (bis 40 Punkte), weiteren Quellen (je 20, höchstens 40), mehreren Erwähnungen (je 5, höchstens 15) und Aktualität (bis 15). Ab 70 Punkten gilt sie als «hoch», ab 45 als «mittel». **Filter → Verlässlichkeit** blendet unsichere Plätze aus.

**Link-Knöpfe:** park4night und camping.info erscheinen bei allen Zielen. camping.info wird über eine Google-Suche nach dem Ort auf camping.info geöffnet, weil es keine direkte Adresse für eine Kartenposition gibt. Weitere Knöpfe, etwa Wohnmobilland oder Campercontact, fügen Sie pro Ziel unter **Quellen** hinzu. Platzhalter in der Adresse: `{lat}`, `{lng}`, `{name}`, `{ort}`. Plattformen ohne offene Schnittstelle werden bewusst nur verlinkt, nicht ausgelesen.

### 2.8 Eigene Plätze, Favoriten, Logbuch und Fotos

Diese Daten liegen in der **Datenbank des Camper-Planers** bei Cloudflare, getrennt pro Person (siehe 2.14). Jede Person sieht nur ihre eigenen Einträge. iPhone und iPad zeigen denselben Stand. Offline zeigt die App den zuletzt geladenen Stand. Änderungen ohne Netz merkt sich die App und sendet sie beim nächsten Empfang. Unter **Zielname → Konto** steht, wie viele Änderungen noch warten.

- **Eigener Platz:** der runde «+»-Knopf über dem Standort-Knopf. Position aus Ihrem Standort oder der Kartenmitte, dazu Name, Typ, Bewertung, Notiz und Link. Auf der Karte erscheint ein pinkfarbener ♦-Marker.
- **Pro Platz:** **☆ Favorit**, **Besucht?** (trägt das heutige Datum ein), **Meine Notiz** und **Meine Bewertung**. Auf der Karte zeigen ein gelber Stern den Favoriten und ein grüner Haken den Besuch.
- **Meine Fotos:** Im Platz unter **Meine Fotos → + Fotos** eines oder mehrere Bilder aus der Mediathek wählen oder direkt fotografieren. Die App verkleinert sie vor dem Hochladen auf höchstens 2048 Pixel, das spart Datenvolumen unterwegs. Antippen öffnet das Foto gross, dort lässt es sich auch löschen. Hochladen braucht Netz.
- **Liste:** Unter den Reitern **Favoriten** und **Logbuch** stehen die besuchten Plätze, die neuesten zuerst, mit Notiz. **Filter → Nur meine Favoriten**.

Nutzen können das Personen mit der Rolle **Admin** oder **Mitreisend**. Gäste sehen nur die Plätze.

### 2.9 Mehrere Ziele, Regionen und «Meine Plätze»

- **Mehrere Ziele zugleich:** Zielname oben links antippen. Das **Häkchen** neben einem Ziel blendet es zusätzlich ein oder aus. Ein Tippen auf den **Namen** zeigt nur dieses Ziel. In der Kopfzeile steht dann z. B. «Schweiz + 1». Filter, Liste, Routen und Etappenplaner gelten für alle gewählten Ziele.
- **Mehrere Regionen:** **Filter → Regionen**, beliebig viele antippen. «Alle» hebt die Auswahl auf. Bei mehreren Zielen sind die Regionen nach Ziel gruppiert.
- **Meine Plätze** (Filter, ganz oben), unabhängig von den gewählten Zielen:
  - **Eigene Plätze zeigen**: alle eigenen Plätze aus allen Zielen ein- oder ausblenden.
  - **Favoriten immer zeigen**: Favoriten erscheinen immer, auch aus nicht gewählten Zielen und trotz anderer Filter.
  - **Besuchte Plätze immer zeigen**: dasselbe für besuchte Plätze.
  - Ist ein Schalter aus, erscheinen Favoriten und besuchte Plätze nur als normale Plätze ihres Ziels.
  - Ein Platz aus einem nicht gewählten Ziel zeigt den Knopf **Ziel dazunehmen**.
  - Die Reiter **Favoriten** und **Logbuch** in der Liste zeigen immer alle Ziele.

### 2.10 Etappenplaner

Ist unter **Filter** eine Route gewählt, zeigt die **Liste** oben den Bereich **Etappen planen**. Sie wählen die minimale und maximale Tagesetappe (Standard 150–250 km) und den Start (Routenstart oder Ihr Standort). Der Planer schlägt pro Etappe einen Platz vor. Favoriten haben Vorrang, sonst gewinnt die höchste Verlässlichkeit. Er berücksichtigt die aktiven Filter, etwa «ohne Allrad» oder «nur Camping». Gibt es im gewünschten Abstand nichts, wählt er etwas längere, notfalls kürzere Etappen.

**Wetter je Etappe:** Unter **Abfahrt** wählen Sie das Datum, Standard ist heute. Jede Etappe zeigt dann die Wetternote für den Tag, an dem Sie dort ankommen: Etappe 1 am Abfahrtstag, Etappe 2 am Folgetag und so weiter. Bei einer Note unter 4 schlägt die App einen Ruhetag, eine Therme oder einen Stadtbesuch vor. Die Prognose reicht 8 Tage weit.

### 2.11 Wetter

Die App holt die Prognosen direkt beim Wetterdienst Open-Meteo, ohne Schlüssel und ohne Kosten. Die **Wetternote 1–10** gilt für tagsüber (08–17 Uhr). Sie gewichtet Regen am stärksten (35 %), dann tiefe Wolken und Hochnebel (25 %), Gesamtbewölkung (15 %), Nebel (10 %) und Sonne (15 %).

- **Im Platz:** Für 8 Tage zeigt die App die Note als Mittel der Wettermodelle ECMWF, ICON und GFS, dazu Sonnenstunden, Regen und den Sonnenuntergang. **trocken** ist der Anteil der 51 ECMWF-Ensembleläufe mit weniger als 1 mm Regen tagsüber. Ein **?** heisst: Die Modelle sind uneinig, die Prognose ist unsicher. Darunter stehen Hinweise auf **Hochnebel**, etwa «Platz liegt darin; über ~900 m meist sonnig». Sie werden aus dem Temperaturprofil geschätzt. Der Link **Webcams in der Nähe** öffnet die Webcam-Karte von Windy.
- **Wetter-Knopf (☀) oben:**
  - **Wetterkarte für Kartenausschnitt:** färbt den sichtbaren Ausschnitt nach der Wetternote des gewählten Tages ein, mit 7 × 7 Feldern. Antippen zeigt Note, Sonne und Regen. Zum Ausblenden den Knopf nochmals antippen.
  - **Regionen vergleichen:** Rangliste der Regionen aller gewählten Ziele nach der mittleren Note der nächsten 7 Tage, berechnet aus bis zu 3 Plätzen pro Region. Eine Region antippen filtert die Karte auf diese Region.
- **Offizielle Warnungen:** Oben in der Wettertabelle stehen die aktiven Unwetterwarnungen der staatlichen Wetterdienste (MeteoAlarm), passend zur Warnregion des Platzes: gelb, orange oder rot, mit Ereignis und Zeitraum. Sonst erscheint «✓ Keine offiziellen Unwetterwarnungen». Im Wetter-Fenster (☀) listet **Offizielle Warnungen** alle Warnungen in den gewählten Zielen; Antippen zeigt das Gebiet auf der Karte. Abgedeckt sind rund 30 Länder Europas. In der Schweiz gibt es keine Regionsumrisse, dort zeigt die App alle Schweizer Warnungen. Marokko ist nicht dabei.
- **MeteoSchweiz:** Bei Plätzen in der Schweiz zeigt die Tabelle zusätzlich die Note und die Regenwahrscheinlichkeit der offiziellen MeteoSchweiz-Lokalprognose für die nächste Postleitzahl oder den nächsten Bergpunkt (höchstens 6 km entfernt). Diese Prognose berücksichtigt den Schatten der Berge und ist für Schweizer Täler meist die beste Quelle.
- **Aktualisierung:** Warnungen und MeteoSchweiz-Daten bereitet der Ablauf **«Wetterdaten aktualisieren & Webapp veröffentlichen»** (`.github/workflows/wetter.yml`) alle 3 Stunden auf (Minute 23). Er ist gratis, braucht keinen Schlüssel und veröffentlicht die Webapp nur, wenn sich etwas geändert hat. Ein Lauf dauert rund 2 Minuten. Manuell starten: **Actions → Wetterdaten aktualisieren → Run workflow**.
- **Zwischenspeicher:** Die App speichert Prognosen 3 Stunden zwischen. Offline gibt es kein Wetter.
- **Grenzen:** Ab dem 4. Tag werden Prognosen deutlich unsicherer. Die Hochnebel-Schätzung ist eine Faustregel.

### 2.12 Fotos & Umgebung

So wissen Sie ungefähr, was Sie antreffen:

- **Schnellknöpfe direkt unter dem Platznamen:**
  - **Street View:** öffnet Google Street View an genau dieser Stelle.
  - **Fotos:** öffnet die Bilder gross in der App. Wischen oder die Pfeile wechseln das Bild.
  - **Wetter:** springt zur Wettertabelle.
  - **Satellit:** öffnet das Luftbild.
- **Bilderleiste:** liegt gleich darunter. Ein Bild antippen öffnet es gross. Im Bild führt der Link zur 360°-Ansicht (Panoramax/Mapillary, dort kann man weitergehen) oder zu Urheber und Lizenz (Wikimedia).
- **Jede beliebige Stelle:** lange auf die Karte drücken. Es erscheint die «Gewählte Stelle» mit denselben Knöpfen, Wetter und Umgebung. Das hilft etwa, um einen Wildplatz oder eine Zufahrt vorher anzuschauen.
- **Abschnitt «Umgebung» weiter unten:**
  - **Google Street View:** öffnet die Strassenansicht von Google an dieser Stelle. Eine Einbettung in die App wäre bei Google kostenpflichtig.
  - **Google Satellit:** Luftbild.
  - **Mapillary** und **Panoramax:** offene Strassenbilder.
- **Quellen der Bilder:** Strassenbilder aus Panoramax im Umkreis von rund 200 m (optional Mapillary) und Fotos mit Standort von Wikimedia Commons im Umkreis von 1,5 km, jeweils mit Entfernung.
- **Bekannte Orte in der Nähe:** bis zu 10 Wikipedia-Artikel im Umkreis von 5 km, wie bei OsmAnd.
- **Mapillary-Vorschaubilder (optional):** Mapillary hat die beste Abdeckung mit Strassenbildern. Für Vorschaubilder in der App braucht es einen kostenlosen Client-Token:
  1. Auf mapillary.com anmelden.
  2. **Dashboard → Developers → Register application** wählen.
  3. Den **Client Token** kopieren.
  4. Im Platz auf **Mapillary-Vorschaubilder einschalten** tippen und den Token einfügen.

  Der Token bleibt nur auf Ihrem Gerät.
- **Kosten:** Alle Quellen sind gratis und brauchen kein Konto.

**park4night:** park4night bietet keine offene Schnittstelle, deshalb gleicht die App nicht automatisch ab. Jeder Platz hat stattdessen den Knopf **park4night**. Er öffnet die park4night-Karte genau an dieser Stelle. Angemeldet mit Ihrem Konto sehen Sie dort die Plätze in der Umgebung, immer mit dem aktuellen Stand.

### 2.13 Zugang und Sicherheit

Die Webapp ist nur für Personen zugänglich, die Sie freigeben. Das übernimmt **Cloudflare Access**: Wer die Adresse öffnet, gibt zuerst seine E-Mail-Adresse ein und erhält einen Einmalcode. Nur Adressen auf Ihrer Liste kommen hinein. Das schützt die App und alle Daten-Dateien. Gratis bis 50 Personen.

**Was zusätzlich schützt:**
- Die App lädt keine Skripte mehr von fremden Servern. Leaflet, Markercluster und das Handbuch-Modul liegen in `docs/vendor/`.
- Strenge Sicherheits-Header in `docs/_headers`: Skripte nur von der eigenen Adresse, Abfragen nur an die Dienste, die die App nutzt (GitHub, Open-Meteo, Panoramax, Mapillary, Wikimedia). Damit kann eingeschleuster Code Ihren GitHub-Schlüssel kaum abgreifen.
- Das Repository ist privat. Code, Daten und dieses Handbuch sind nicht mehr öffentlich.
- Steuern (Abrufe, Ziele, Anfragen, eigene Plätze) kann weiterhin nur, wer einen GitHub-Schlüssel hinterlegt hat, also nur Sie.

**Was freigegebene Personen sehen:** Karte, Plätze, Wetter, Fotos, Etappenplaner, ausserdem unter **i** die Läufe, die Kosten und dieses Handbuch. Was sie zusätzlich dürfen, bestimmt ihre Rolle, siehe 2.14. Ihre Favoriten, Ihr Logbuch und Ihre Fotos sieht niemand ausser Ihnen.

#### Umstellung, einmalig, etwa 30 Minuten

Die Reihenfolge ist wichtig: Das Repository erst privat stellen, wenn die neue Adresse funktioniert.

**1. Cloudflare-Konto und Schlüssel**
1. https://dash.cloudflare.com/sign-up öffnen und ein Gratiskonto anlegen.
2. **Workers & Pages** öffnen. Rechts steht die **Account ID**. Kopieren.
3. Oben rechts **My Profile → API Tokens → Create Token → Create Custom Token**.
   - **Token name:** `camper-planer GitHub`
   - **Permissions:** `Account` · `Cloudflare Pages` · `Edit`
   - **Account Resources:** Ihr Konto
   - **Continue to summary → Create Token**, den Schlüssel kopieren. Er wird nur einmal angezeigt.

**2. In GitHub eintragen**
1. Im Repository **Settings → Secrets and variables → Actions → New repository secret**:
   `CLOUDFLARE_API_TOKEN` und `CLOUDFLARE_ACCOUNT_ID` mit den beiden Werten.
2. Daneben den Reiter **Variables → New repository variable**: Name `HOSTING`, Wert `cloudflare`.
3. **Actions → «Plätze aktualisieren & Webapp veröffentlichen» → Run workflow**, bei **Ziel** ein `-` eintragen. Damit wird nur veröffentlicht, nichts abgerufen.
4. Nach etwa 2 Minuten läuft die App unter **https://camper-planer.pages.dev**. Ist der Name bei Cloudflare schon vergeben, steht die tatsächliche Adresse unter **Workers & Pages → camper-planer**.

**3. Zugang schützen (Cloudflare Zero Trust)**
1. https://one.dash.cloudflare.com öffnen. Beim ersten Mal einen **Team-Namen** wählen, etwa `paulpmu`, und den Plan **Free** wählen. Cloudflare verlangt dafür eventuell ein Zahlungsmittel, belastet beim Gratisplan aber nichts.
2. **Access → Applications → Add an application → Self-hosted**.
   - **Application name:** `Camper-Planer`
   - **Session Duration:** `1 month`, damit Sie sich nicht ständig neu anmelden müssen
   - **Public hostname:** Domain `camper-planer.pages.dev`. Mit **Add public hostname** zusätzlich `*.camper-planer.pages.dev` eintragen, das deckt die Vorschau-Adressen ab.
3. **Next → Add a policy**:
   - **Policy name:** `Freigegebene Personen`, **Action:** `Allow`
   - **Include → Selector: Emails** → Ihre Adresse und die der freigegebenen Personen
4. Bei **Login methods** «One-time PIN» eingeschaltet lassen. **Save**.
5. Testen: Die Adresse in einem privaten Safari-Fenster öffnen. Es erscheint die Anmeldeseite von Cloudflare. E-Mail-Adresse eingeben, Code aus der E-Mail eintippen, dann öffnet sich die App.

**4. Repository privat stellen und GitHub Pages abschalten**
1. **Settings → General → ganz unten «Change repository visibility» → Make private**.
2. **Settings → Pages → Unpublish site**, falls noch angezeigt. Die alte Adresse `paulpmu.github.io/camper-plaetze` ist dann nicht mehr erreichbar.

**5. iPhone und iPad umstellen**
1. Das alte Symbol auf dem Home-Bildschirm löschen.
2. Die neue Adresse in Safari öffnen, anmelden, dann **Teilen → Zum Home-Bildschirm**.
3. Den **GitHub-Schlüssel** neu einfügen: Zielname antippen, ganz unten. Ebenso den Mapillary-Token, falls Sie ihn nutzen. Safari speichert solche Angaben pro Adresse.

#### Personen freigeben oder entfernen

**Zero Trust → Access → Applications → Camper-Planer → Policies → Freigegebene Personen → Edit**, E-Mail-Adresse ergänzen oder löschen, **Save**. Die neue Person öffnet einfach die Adresse und meldet sich mit ihrer E-Mail-Adresse an.

Eine entfernte Person kommt nach Ablauf ihrer Sitzung nicht mehr hinein, spätestens nach einem Monat. Sofort sperren: **Zero Trust → My Team → Users** → Person → **Revoke session**.

#### Actions-Minuten im privaten Repository

Für private Repositories enthält das Gratiskonto von GitHub **2000 Minuten Actions pro Monat**. Der Verbrauch liegt im Normalbetrieb bei etwa 1400–1800 Minuten. Die Veröffentlichung auf Cloudflare läuft deshalb im selben Job wie der Abruf und kostet kaum zusätzliche Minuten. Den Stand sehen Sie unter https://github.com/settings/billing. Sind die Minuten aufgebraucht, laufen die Abläufe bis Monatsende nicht mehr. Es entstehen keine Kosten, solange Sie kein Ausgabenlimit über 0 setzen. Bei Bedarf: den Wetter-Ablauf in `.github/workflows/wetter.yml` von alle 3 auf alle 6 Stunden umstellen.

### 2.14 Personen, Rollen und Datenbank

Seit Phase 1 hat der Camper-Planer einen eigenen Server-Teil bei Cloudflare: Pages Functions (Code in `server/`), die Datenbank **D1** und den Fotospeicher **R2**, beide in Westeuropa. Die Anmeldung über Cloudflare Access gilt zugleich für die Daten. Es gibt kein zweites Passwort.

**Rollen:**

| Rolle | darf |
|---|---|
| **Admin** | alles, dazu Personen und Rollen verwalten. Die Adresse in der Variable `ADMIN_EMAIL` ist immer Admin |
| **Mitreisend** | eigene Favoriten, Notizen, Logbuch, eigene Plätze und Fotos |
| **Gast** | nur ansehen. Wer sich zum ersten Mal anmeldet und noch nicht eingetragen ist, ist Gast |

Zwei Listen, zwei Zwecke: **Cloudflare Zero Trust** entscheidet, *wer die App öffnen darf* (2.13). **Zielname → Konto → Personen und Rollen** entscheidet, *was die Person darin darf*.

**Selbst eingerichtet:** Datenbank, Fotospeicher und Anmeldeprüfung richtet der Ablauf bei jeder Veröffentlichung selbst ein, was fehlt, legt er an. Das Ergebnis steht in der Zusammenfassung jedes Laufs unter **Actions** im Abschnitt «Cloudflare»: Datenbank, Fotospeicher und Anmeldeprüfung sollen «bereit» zeigen.

#### Einrichtung, einmalig, etwa 15 Minuten

**Schritt 1: Rechte des Cloudflare-Schlüssels erweitern**
1. https://dash.cloudflare.com/profile/api-tokens öffnen.
2. Beim Schlüssel `camper-planer GitHub` (bzw. `camper-plaetze GitHub`) rechts auf **…** → **Edit**.
3. Unter **Permissions** mit **+ Add more** drei Zeilen ergänzen. Die bestehende Zeile «Cloudflare Pages · Edit» bleibt:
   - `Account` · `D1` · `Edit`
   - `Account` · `Workers R2 Storage` · `Edit`
   - `Account` · `Access: Apps and Policies` · `Read`
4. **Continue to summary → Update Token**. Der Schlüssel selbst bleibt gleich, in GitHub müssen Sie nichts ändern.

**Schritt 2: Fotospeicher R2 aktivieren**
1. https://dash.cloudflare.com öffnen, links **Storage & Databases → R2 Object Storage**.
2. Falls ein Knopf **Purchase R2 Plan** bzw. **Get started** erscheint: antippen und bestätigen. Der Gratisanteil umfasst 10 GB, das reicht für rund 20'000 Fotos. Erscheint eine Übersicht der Buckets, ist R2 schon aktiv.

**Schritt 3: Admin-Adresse in GitHub eintragen**
1. Im Repository **Settings → Secrets and variables → Actions → Reiter Variables → New repository variable**.
2. Name `ADMIN_EMAIL`, Wert: die E-Mail-Adresse, mit der Sie sich bei Cloudflare Access anmelden. **Add variable**.

**Schritt 4: Pull Request übernehmen**
1. Den Pull Request «Phase 1» auf GitHub öffnen und **Merge pull request → Confirm merge** tippen.
2. Die Veröffentlichung startet automatisch. Nach etwa 2 Minuten unter **Actions** den obersten Lauf öffnen. In der Zusammenfassung muss bei «Cloudflare» überall «bereit» stehen. Steht irgendwo «fehlt», nennt die gelbe Warnung darüber das fehlende Recht.

**Schritt 5: In der App prüfen**
1. Die App ganz schliessen und neu öffnen, damit sie die neue Version lädt.
2. Zielname antippen → Abschnitt **Konto**. Dort soll stehen: «Angemeldet als … (Admin)».

**Schritt 6: Bisherige Daten übernehmen**
1. Voraussetzung: Der GitHub-Schlüssel ist in der App hinterlegt (Zielname → ganz unten).
2. Zielname → **Konto → Bisherige Daten übernehmen → Daten übernehmen**. Die App meldet, wie viele Einträge übernommen wurden.
3. Kurz prüfen: Liste → Reiter **Favoriten** und **Logbuch**, Karte → Ebene «Meine Plätze».
4. Das Repository `camper-plaetze-privat` bleibt als Sicherung bestehen. Die App schreibt nicht mehr hinein.

**Schritt 7: Mitreisende eintragen**
1. Zielname → **Konto → Personen und Rollen**: E-Mail-Adresse, Name, Rolle **Mitreisend** → **Speichern**.
2. Dieselbe Adresse in Cloudflare Zero Trust freigeben, siehe 2.13 «Personen freigeben oder entfernen».
3. Die Person öffnet die Adresse, meldet sich mit ihrer E-Mail-Adresse an und legt die App auf den Home-Bildschirm.

#### Sicherung und Grenzen

- **Sicherung:** D1 hält automatisch einen Verlauf der letzten Tage (Time Travel). Eine Datenbank lässt sich damit auf einen früheren Zeitpunkt zurücksetzen: Cloudflare → D1 → camper-planer → **Time Travel**. Fotos werden nicht versioniert, gelöscht ist gelöscht.
- **Gratis-Grenzen:** D1 5 GB, R2 10 GB Speicher. Beides ist für diese Nutzung reichlich.
- **Sicherheit:** Jede Anfrage an den Server prüft die signierte Anmeldung von Cloudflare Access und die Rolle der Person. Schreiben ist nur aus der App selbst möglich. Jede Person sieht nur ihre eigenen Daten und Fotos.

---

## 3. Kosten

| Posten | Kosten | Bemerkung |
|---|---|---|
| GitHub (privates Repository, Actions) | **0** | 2000 Actions-Minuten pro Monat gratis, siehe 2.13 |
| Cloudflare Pages und Zero Trust Access | **0** | gratis bis 50 Personen |
| YouTube Data API | **0** | 10'000 Einheiten pro Tag gratis, die App plant mit höchstens 9'000 |
| OpenStreetMap, OSRM | **0** | |
| Webshare Rotating Residential | **3.50 USD pro Monat** | 1 GB Datenvolumen, monatliches Abo |
| Claude Haiku (Videoauswertung) | **ca. 1–4 USD pro Monat** | gemessen: 0.03 USD für 40 Videos ohne Transkript. Mit Transkript geschätzt 0.002–0.005 USD pro Video |
| Reiseberichte (Websuche mit Claude Sonnet, Auswertung mit Haiku) | ca. 0.50–1 USD pro Monat und Ziel | nur bei aktiver Quelle; pro wöchentlicher Suche bis 8 Websuchen à 0.01 USD |
| Claude Opus (Anfragen aus der App) | ca. 0.05–0.15 USD pro Anfrage | fällt nur bei Anfragen an |
| Cloudflare D1 (Datenbank) und R2 (Fotos) | **0** | gratis bis 5 GB bzw. 10 GB |
| **Total** | **ca. 6–11 USD pro Monat** | je nach Zahl der Ziele mit Reiseberichten |

**Kostenbremsen:**
- **Anthropic:** Unter **Settings → Limits** ein Monatslimit setzen, empfohlen 20 USD. Mehr kann nie belastet werden.
- **Webshare:** Ist das Volumen aufgebraucht, kommen keine Transkripte mehr durch. Es entstehen keine Zusatzkosten.
- **App:** `max_videos_per_run` in `config.json` begrenzt die Auswertungen pro Nacht.

Die aufgelaufenen Kosten pro Plattform und Monat zeigt die Webapp unter **i → Kosten**. Grundlage ist das Kostenbuch `docs/data/kosten.json`: Jeder Abruf, jede Anfrage und jeder Modellvergleich trägt dort Tokens, Kosten und YouTube-Einheiten ein. Die Webshare-Kosten stehen als Abo in `config.json` unter `fixkosten`. Ändert sich das Paket, passen Sie dort den Betrag an.

---

## 4. Pflege

### 4.1 Routine: einmal pro Monat, etwa 5 Minuten

| Prüfen | Wo | Worauf achten |
|---|---|---|
| Läufe | Webapp → **i → Läufe** oder Repository → **Actions** | Alle grün? Rote Läufe öffnen und den Fehler lesen, siehe 4.3 |
| Anthropic-Guthaben | console.anthropic.com → **Billing** | genug Guthaben? Wenn es leer ist, bricht die Auswertung ab |
| Webshare-Volumen | dashboard.webshare.io → **Dashboard** | Wie viel ist verbraucht? Über 80 % → grösseres Paket |
| Transkripte | Webapp → **i → Läufe** → «Transkripte ok» | sollte die meisten Videos ausmachen, nicht «blockiert» |
| Kosten | Webapp → **i → Kosten** | Entwicklung pro Monat und Plattform |
| App | in Safari öffnen | Gibt es neue Plätze? Stimmt das Datum unter «i»? |

### 4.2 Inhalte anpassen

| Was | Wie |
|---|---|
| neues Ziel, Route oder Kanal | in der App über **Ziel hinzufügen oder ändern**, das ist der einfachste Weg |
| Zeitplan | in der App beim Ziel, siehe 2.2 |
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
| App meldet «Schlüssel ungültig» oder Fehler 401 | GitHub-Schlüssel abgelaufen | neuen Schlüssel erstellen, siehe 2.4 |
| App zeigt alte Daten | Safari-Cache | App schliessen und neu öffnen, notfalls neu laden |
| App verlangt erneut die Anmeldung | Sitzung von Cloudflare Access abgelaufen (nach einem Monat) | E-Mail-Adresse eingeben, Code aus der E-Mail eintippen. Ohne Netz zeigt die App den zuletzt geladenen Stand |
| Freigegebene Person erhält keinen Code | Adresse nicht in der Liste oder Code im Spam | Liste prüfen, siehe 2.13; Spam-Ordner prüfen |
| Lauf rot beim Schritt «Webapp veröffentlichen (Cloudflare)» | Cloudflare-Schlüssel abgelaufen oder ohne Recht «Cloudflare Pages: Edit» | neuen Schlüssel erstellen und als `CLOUDFLARE_API_TOKEN` eintragen |
| App meldet «Datenbank noch nicht eingerichtet», «Fotospeicher noch nicht eingerichtet» oder «Anmeldeprüfung noch nicht eingerichtet» | Recht beim Cloudflare-Schlüssel fehlt oder R2 nicht aktiviert | 2.14 Schritte 1 und 2, danach unter Actions «Plätze aktualisieren» mit Ziel `-` starten |
| Konto zeigt «Gast» statt «Admin» | Variable `ADMIN_EMAIL` fehlt oder enthält eine andere Adresse als die Anmeldung | 2.14 Schritt 3, dann wie oben neu veröffentlichen |
| Konto zeigt «Anmeldung abgelaufen» | Sitzung von Cloudflare Access abgelaufen | App schliessen und neu öffnen, neu anmelden |
| Abläufe laufen nicht mehr, Hinweis auf «spending limit» | Actions-Minuten des Monats aufgebraucht | bis Monatsanfang warten oder Wetter-Ablauf seltener stellen, siehe 2.13 |

### 4.4 Technische Wartung, etwa zweimal pro Jahr

- **Bibliotheken aktualisieren:** In `requirements.txt` sind die Versionen festgelegt, etwa `anthropic` und `youtube-transcript-api`. Bei der Transkript-Bibliothek lohnt sich ein Update, sobald Fehler auftauchen.
- **Modelle:** Anthropic veröffentlicht regelmässig neue Modelle. Mit einem Vergleichslauf (siehe 2.3) prüfen Sie, ob sich ein Wechsel lohnt.

**Am einfachsten mit Claude Code:** Starten Sie auf https://claude.ai/code eine neue Sitzung mit dem Repository `paulpmu/camper-plaetze` und beschreiben Sie das Problem oder den Wunsch, zum Beispiel «Die Läufe sind seit gestern rot, bitte prüfen und beheben» oder «Bitte Bibliotheken aktualisieren». Claude liest dieses Handbuch und den Code und nimmt die Änderung vor.

### 4.5 Pausieren oder stilllegen

| Ziel | Schritte |
|---|---|
| vorübergehend pausieren | **Actions** → Workflow «Plätze aktualisieren» → **…** → **Disable workflow**. Die App bleibt online mit den letzten Daten |
| Kosten stoppen | Webshare-Abo kündigen (**Subscription**), Anthropic-Guthaben nicht mehr aufladen |
| ganz stilllegen | zusätzlich bei Cloudflare unter **Workers & Pages → camper-planer → Settings → Delete** die Webapp löschen und die API-Schlüssel bei Google, Anthropic und Cloudflare löschen |

---

## 5. Wo liegt was im Repository?

| Pfad | Inhalt |
|---|---|
| `ziele/*.json` | ein Reiseziel pro Datei: Suchbegriffe, Regionen, Routen |
| `config.json` | globale Einstellungen: Modelle, Grenzen, Kontingent |
| `scripts/update.py` | nächtlicher Abruf und Auswertung |
| `scripts/anfrage.py` | Verarbeitung der Anfragen aus der App |
| `scripts/quellen.py` | Quellen OpenStreetMap, Reiseberichte, offene Datensätze; Zusammenführen und Verlässlichkeit |
| `scripts/common.py` | Geodaten, Standortprüfung, Routenberechnung |
| `.github/workflows/` | Zeitplan und Abläufe auf GitHub |
| `.github/actions/cloudflare/` | Veröffentlichung auf Cloudflare Pages, von allen Abläufen genutzt |
| `docs/_headers` | Sicherheits-Header für Cloudflare Pages |
| `functions/`, `server/` | Server-Teil: Anmeldeprüfung (`server/auth.js`) und Schnittstelle für Daten, Personen und Fotos (`server/api.js`) |
| `migrations/` | Aufbau der Datenbank (D1) |
| `.github/actions/cloudflare/einrichten.sh` | richtet Datenbank, Fotospeicher und Anmeldeprüfung bei Cloudflare ein |
| `tests/auth.test.mjs` | Tests der Anmeldeprüfung (`node --test tests/auth.test.mjs`) |
| `docs/vendor/` | Kartenbibliotheken Leaflet und Markercluster sowie marked, lokal statt von fremden Servern |
| `docs/fotos.js` | Fotos & Umgebung: Panoramax, Mapillary, Wikimedia Commons, Wikipedia, Street-View-Links |
| `scripts/wetter_update.py` | bereitet Warnungen (MeteoAlarm) und MeteoSchweiz-Lokalprognose auf; übernommen aus dem Werkzeug «wetter-check» |
| `docs/data/wetter/` | `warnungen.json` und `ch.json` für die Webapp (alle 3 Stunden neu) |
| `docs/wetter.js` | Wetter: Abruf bei Open-Meteo, Wetternote, Ensemble, Hochnebel |
| `tests/wetter.test.js` | Tests der Wetterlogik (`node --test tests/wetter.test.js`) |
| `docs/` | die Webapp; `docs/data/<ziel>/places.json` enthält die zusammengeführten Plätze, die übrigen Dateien die einzelnen Quellen |
| `data/` | interner Zustand: bearbeitete Videos, Warteschlange, Geocache |
| `berichte/` | Modellvergleiche |

Der ganze Verlauf liegt in Git. Jede Datenänderung ist ein Commit und lässt sich jederzeit nachvollziehen oder zurücksetzen.

---

## 6. Rechtliches und Grenzen

- Die Transkripte werden über eine inoffizielle Schnittstelle abgerufen. Das bewegt sich im **Graubereich der YouTube-Nutzungsbedingungen**. Die App ist für den privaten Gebrauch gedacht.
- Die Bewertungen geben die subjektiven Aussagen der YouTuber und Blogger wieder und sind keine geprüfte Platzqualität.
- Reiseberichte: Die App liest öffentlich zugängliche Seiten, beachtet robots.txt und übernimmt nur Fakten (Ort, Ausstattung, Einschätzung) mit Quellenlink, keine Texte. Plattformen mit eigenen Datenbanken (park4night, camping.info, Campercontact, iOverlander u. a.) werden nicht ausgelesen, nur verlinkt.
- Die Regeln zum Wildcampen ändern sich. Vor Ort gelten die lokalen Vorschriften. Die App zeigt deshalb standardmässig nur Plätze aus den letzten 12 Monaten.
- Die Webapp ist öffentlich erreichbar, aber nirgends verlinkt. Die Schlüssel sind nie in der App, sondern nur in GitHub Secrets gespeichert.
