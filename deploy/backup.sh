#!/usr/bin/env bash
# Nightly encrypted database backup, copied off the server. Run from cron on the app server (see deploy/README.md).
# Needs: BACKUP_PASSPHRASE_FILE (a file holding a long passphrase) and BACKUP_REMOTE, either an rsync target
# (user@host:/path) or an rclone path starting with "rclone:" (e.g. rclone:r2:maiz-backups for Cloudflare R2).
set -euo pipefail
cd "$(dirname "$0")"
: "${BACKUP_PASSPHRASE_FILE:?}" "${BACKUP_REMOTE:?}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DIR="${BACKUP_DIR:-/var/backups/maiz}"
mkdir -p "$DIR"
OUT="$DIR/maiz-$(date -u +%Y%m%dT%H%M%SZ).dump.enc"
docker compose -f compose.yml --env-file .env exec -T db pg_dump -U postgres -Fc postgres \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" -out "$OUT"
[ -s "$OUT" ] || { echo "backup is empty" >&2; rm -f "$OUT"; exit 1; }
if [[ "$BACKUP_REMOTE" == rclone:* ]]; then
  REMOTE="${BACKUP_REMOTE#rclone:}"
  rclone copy "$OUT" "$REMOTE/"
  rclone delete "$REMOTE/" --min-age "${REMOTE_KEEP_DAYS:-30}d" --include 'maiz-*.dump.enc'
else
  rsync -a "$OUT" "$BACKUP_REMOTE/"
fi
find "$DIR" -name 'maiz-*.dump.enc' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $OUT"
