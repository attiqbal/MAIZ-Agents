#!/usr/bin/env bash
# Restore an encrypted backup into the running database. DESTRUCTIVE: replaces current data. Usage: restore.sh <file.dump.enc>
set -euo pipefail
cd "$(dirname "$0")"
: "${BACKUP_PASSPHRASE_FILE:?}"
FILE="${1:?usage: restore.sh <file.dump.enc>}"
read -r -p "This replaces the live database with $FILE. Type RESTORE to continue: " ok
[ "$ok" = RESTORE ] || exit 1
docker compose -f compose.yml --env-file .env stop app
openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$FILE" \
  | docker compose -f compose.yml --env-file .env exec -T db pg_restore -U postgres -d postgres --clean --if-exists --no-owner
docker compose -f compose.yml --env-file .env start app
