#!/bin/sh
# Dagelijkse versleutelde databasebackup naar S3-compatibele opslag bij een andere aanbieder (EU).
# Zie docs/12-backup.md. Draait als Render Cron Job (Dockerfile hiernaast).
#
# Stappen: pg_dump (custom formaat) → controle met pg_restore --list → versleutelen met age
# (publieke sleutel; de privésleutel staat NIET op de server) → upload met sha256-controle.
# Bewaren regelt de bucket (lifecycle per map): daily/ 30 dagen, monthly/ 12 maanden, yearly/ 7 jaar.
# Het script verwijdert nooit iets, zodat de opslagsleutel alleen schrijfrechten nodig heeft.
set -eu

: "${DATABASE_URL:?DATABASE_URL ontbreekt}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT (publieke age-sleutel) ontbreekt}"
: "${S3_ENDPOINT:?S3_ENDPOINT ontbreekt, bijv. https://s3.nl-ams.scw.cloud}"
: "${S3_REGION:?S3_REGION ontbreekt, bijv. nl-ams}"
: "${S3_BUCKET:?S3_BUCKET ontbreekt}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID ontbreekt}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY ontbreekt}"
PREFIX="${BACKUP_PREFIX:-gecko-crm}"

export TZ=Europe/Amsterdam
stamp=$(date +%Y-%m-%dT%H%M)
day=$(date +%d)
month=$(date +%m)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

log() { echo "[backup] $*"; }

log "dump starten"
pg_dump --format=custom --compress=9 --no-owner --no-acl --file="$work/db.dump" "$DATABASE_URL"
tables=$(pg_restore --list "$work/db.dump" | grep -c " TABLE DATA " || true)
[ "$tables" -gt 0 ] || { log "FOUT: dump bevat geen tabellen"; exit 1; }
log "dump ok: $(wc -c < "$work/db.dump") bytes, $tables tabellen"

age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$work/db.dump.age" "$work/db.dump"
rm -f "$work/db.dump"
sha=$(sha256sum "$work/db.dump.age" | cut -d' ' -f1)
size=$(wc -c < "$work/db.dump.age")

upload() {
  key="$PREFIX/$1/$stamp.dump.age"
  # De sha256 zit in de handtekening: de opslag weigert het bestand als het onderweg verandert.
  curl --fail-with-body --silent --show-error --retry 3 --retry-all-errors \
    --aws-sigv4 "aws:amz:$S3_REGION:s3" \
    --user "$S3_ACCESS_KEY_ID:$S3_SECRET_ACCESS_KEY" \
    -H "x-amz-content-sha256: $sha" \
    -H "x-amz-meta-sha256: $sha" \
    -H "Content-Type: application/octet-stream" \
    --upload-file "$work/db.dump.age" \
    "${S3_ENDPOINT%/}/$S3_BUCKET/$key" > /dev/null
  log "geüpload: $key ($size bytes, sha256 $sha)"
}

upload daily
[ "$day" = "01" ] && upload monthly
[ "$day$month" = "0101" ] && upload yearly

log "klaar"
