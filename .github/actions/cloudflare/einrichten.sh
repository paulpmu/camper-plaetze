#!/usr/bin/env bash
# Richtet bei Cloudflare ein, was der Server-Teil braucht, und schreibt wrangler.toml.
# Fehlt ein Recht des API-Schlüssels, wird die App trotzdem veröffentlicht; die persönlichen Funktionen
# melden dann «noch nicht eingerichtet», und der Lauf zeigt eine Warnung mit dem fehlenden Recht.
set -uo pipefail
API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/${CLOUDFLARE_ACCOUNT_ID}"
DB_NAME="camper-planer"
BUCKET="camper-planer-medien"
cf() { curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" "$@"; }
fehler() { echo "$1" | jq -r '[.errors[]?.message] | join("; ")' 2>/dev/null; }

# 1. Pages-Projekt und seine Adresse
R=$(cf "$API/pages/projects/$PROJEKT")
if [ "$(echo "$R" | jq -r '.success')" != "true" ]; then
  cf -X POST "$API/pages/projects" -d "{\"name\":\"$PROJEKT\",\"production_branch\":\"main\"}" >/dev/null
  R=$(cf "$API/pages/projects/$PROJEKT")
fi
DOMAIN=$(echo "$R" | jq -r '.result.subdomain // empty')
echo "Adresse: ${DOMAIN:-unbekannt}"

# 2. Datenbank D1 (Westeuropa)
DB_ID=$(cf "$API/d1/database?name=$DB_NAME" | jq -r ".result[]? | select(.name==\"$DB_NAME\") | .uuid" | head -1)
if [ -z "$DB_ID" ]; then
  R=$(cf -X POST "$API/d1/database" -d "{\"name\":\"$DB_NAME\",\"primary_location_hint\":\"weur\"}")
  DB_ID=$(echo "$R" | jq -r '.result.uuid // empty')
  [ -n "$DB_ID" ] && echo "Datenbank angelegt" || echo "::warning::Datenbank nicht angelegt ($(fehler "$R")). Recht «D1: Edit» beim Cloudflare-Schlüssel ergänzen, siehe BETRIEB.md 2.14."
fi

# 3. Fotospeicher R2 (Westeuropa)
R=$(cf "$API/r2/buckets/$BUCKET")
if [ "$(echo "$R" | jq -r '.success')" != "true" ]; then
  R=$(cf -X POST "$API/r2/buckets" -d "{\"name\":\"$BUCKET\",\"locationHint\":\"weur\"}")
  if [ "$(echo "$R" | jq -r '.success')" = "true" ]; then echo "Fotospeicher angelegt"; else
    BUCKET=""
    echo "::warning::Fotospeicher nicht angelegt ($(fehler "$R")). R2 im Cloudflare-Dashboard aktivieren und Recht «Workers R2 Storage: Edit» ergänzen, siehe BETRIEB.md 2.14."
  fi
fi

# 4. Anmeldeprüfung: AUD-Tag der Access-Anwendung für diese Adresse
AUD="${ACCESS_AUD:-}"
if [ -z "$AUD" ] && [ -n "$DOMAIN" ]; then
  R=$(cf "$API/access/apps?per_page=100")
  AUD=$(echo "$R" | jq -r --arg d "$DOMAIN" '.result[]? | select(.domain == $d or ((.self_hosted_domains // []) | index($d)) or ((.destinations // []) | map(.uri // "") | index($d))) | .aud' | head -1)
  [ -z "$AUD" ] && echo "::warning::Access-Anwendung für $DOMAIN nicht gefunden ($(fehler "$R")). Recht «Access: Apps and Policies: Read» ergänzen, siehe BETRIEB.md 2.14."
fi
[ -z "${ADMIN_EMAIL:-}" ] && echo "::warning::Variable ADMIN_EMAIL fehlt: niemand hat die Admin-Rolle. Siehe BETRIEB.md 2.14."

# 5. wrangler.toml schreiben
{
  echo "name = \"$PROJEKT\""
  echo 'pages_build_output_dir = "docs"'
  echo 'compatibility_date = "2026-10-01"'
  echo
  echo '[vars]'
  echo "ACCESS_AUD = \"$AUD\""
  echo "ADMIN_EMAIL = \"${ADMIN_EMAIL:-}\""
  if [ -n "$DB_ID" ]; then
    echo; echo '[[d1_databases]]'; echo 'binding = "DB"'
    echo "database_name = \"$DB_NAME\""; echo "database_id = \"$DB_ID\""; echo 'migrations_dir = "migrations"'
  fi
  if [ -n "$BUCKET" ]; then
    echo; echo '[[r2_buckets]]'; echo 'binding = "MEDIEN"'; echo "bucket_name = \"$BUCKET\""
  fi
} > wrangler.toml
echo "--- wrangler.toml"; cat wrangler.toml
{
  echo "### Cloudflare"
  echo "- Adresse: ${DOMAIN:-?}"
  echo "- Datenbank: $([ -n "$DB_ID" ] && echo bereit || echo fehlt)"
  echo "- Fotospeicher: $([ -n "$BUCKET" ] && echo bereit || echo fehlt)"
  echo "- Anmeldeprüfung: $([ -n "$AUD" ] && echo bereit || echo fehlt)"
  echo "- Admin: ${ADMIN_EMAIL:-fehlt}"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit 0
