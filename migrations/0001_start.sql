-- Personen, Rollen, Merkliste, eigene Plätze und Fotos (Phase 1)
CREATE TABLE IF NOT EXISTS personen (
  email     TEXT PRIMARY KEY,
  name      TEXT NOT NULL DEFAULT '',
  rolle     TEXT NOT NULL DEFAULT 'gast' CHECK (rolle IN ('admin', 'mitreisend', 'gast')),
  erstellt  TEXT NOT NULL,
  zuletzt   TEXT
);

-- Favoriten, Besuche (Logbuch), Notizen und Bewertungen; schluessel = "<ziel>/<platz-id>"
CREATE TABLE IF NOT EXISTS merk (
  email      TEXT NOT NULL,
  schluessel TEXT NOT NULL,
  daten      TEXT NOT NULL,
  geaendert  TEXT NOT NULL,
  PRIMARY KEY (email, schluessel)
);

-- Eigene Plätze
CREATE TABLE IF NOT EXISTS eigene (
  email     TEXT NOT NULL,
  id        TEXT NOT NULL,
  daten     TEXT NOT NULL,
  geaendert TEXT NOT NULL,
  PRIMARY KEY (email, id)
);

-- Fotos; die Bilder selbst liegen im Speicher R2 unter medien/<id> und medien/<id>-k (Vorschau)
CREATE TABLE IF NOT EXISTS medien (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  bezug       TEXT NOT NULL,
  typ         TEXT NOT NULL,
  groesse     INTEGER NOT NULL,
  breite      INTEGER,
  hoehe       INTEGER,
  aufgenommen TEXT,
  lat         REAL,
  lng         REAL,
  notiz       TEXT NOT NULL DEFAULT '',
  erstellt    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS medien_bezug ON medien (email, bezug);
