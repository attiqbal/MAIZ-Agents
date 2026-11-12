#!/usr/bin/env bash
# DISASTER RECOVERY ONLY: make the Oracle standby the live database. Afterwards run the app stack on Oracle
# (compose.yml with DATABASE_URL pointing at this database) and point DNS at Oracle. Never run this while Hetzner is still serving.
set -euo pipefail
cd "$(dirname "$0")"
read -r -p "Promote the standby to primary? Type PROMOTE: " ok
[ "$ok" = PROMOTE ] || exit 1
docker compose -f compose.yml exec -T db psql -U postgres -c "SELECT pg_promote(wait => true);"
