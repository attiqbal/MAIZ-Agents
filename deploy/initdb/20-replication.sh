#!/bin/bash
# Replication role, slot and access rule for the standby on Oracle (reachable only over WireGuard).
set -eu
psql -v ON_ERROR_STOP=1 -U postgres -d postgres -v pw="$REPLICA_PASSWORD" <<'SQL'
CREATE ROLE replicator REPLICATION LOGIN PASSWORD :'pw';
SELECT pg_create_physical_replication_slot('oracle');
SQL
echo "host replication replicator 10.10.0.0/24 scram-sha-256" >> "$PGDATA/pg_hba.conf"
