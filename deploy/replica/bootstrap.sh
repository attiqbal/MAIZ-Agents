#!/usr/bin/env bash
# Run once on Oracle: copy the primary's data and start following it. Needs PRIMARY_ADDR (Hetzner's WireGuard IP) and REPLICA_PASSWORD.
set -euo pipefail
cd "$(dirname "$0")"
: "${PRIMARY_ADDR:?}" "${REPLICA_PASSWORD:?}"
docker compose -f compose.yml down -v
docker compose -f compose.yml run --rm --no-deps --entrypoint bash -e PGPASSWORD="$REPLICA_PASSWORD" db -c \
  "pg_basebackup -h $PRIMARY_ADDR -U replicator -D /var/lib/postgresql/data -R -X stream -S oracle \
   -d 'host=$PRIMARY_ADDR user=replicator application_name=oracle' && chown -R postgres:postgres /var/lib/postgresql/data && chmod 700 /var/lib/postgresql/data"
docker compose -f compose.yml up -d
echo "standby running; check on the primary: SELECT application_name, state, sync_state FROM pg_stat_replication;"
