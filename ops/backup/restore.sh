#!/bin/sh
# Herstel een backup in een LEGE database (nooit rechtstreeks over productie heen).
# Zie docs/12-backup.md.
#
# Gebruik:
#   restore.sh <backupbestand.dump.age> <age-privésleutelbestand> <doel-DATABASE_URL>
set -eu

[ $# -eq 3 ] || { echo "Gebruik: $0 <bestand.dump.age> <privesleutel.txt> <doel-DATABASE_URL>"; exit 2; }
file=$1
identity=$2
target=$3

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "[herstel] ontsleutelen"
age --decrypt --identity "$identity" --output "$work/db.dump" "$file"
pg_restore --list "$work/db.dump" > /dev/null

existing=$(psql "$target" -Atc "select count(*) from information_schema.tables where table_schema in ('public','drizzle')")
[ "$existing" = "0" ] || { echo "[herstel] FOUT: doeldatabase is niet leeg ($existing tabellen). Gebruik een nieuwe, lege database."; exit 1; }

echo "[herstel] terugzetten"
pg_restore --no-owner --no-acl --exit-on-error --dbname="$target" "$work/db.dump"

echo "[herstel] controle"
psql "$target" -Atc "select 'klanten: ' || count(*) from customers"
psql "$target" -Atc "select 'projecten: ' || count(*) from projects"
psql "$target" -Atc "select 'facturen: ' || count(*) from invoices"
psql "$target" -Atc "select 'laatste auditregel: ' || coalesce(max(occurred_at)::text, '-') from audit_log"
echo "[herstel] klaar"
