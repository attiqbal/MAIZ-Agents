#!/usr/bin/env bash
# Starts a throwaway Postgres, exports TEST_DATABASE_URL / TEST_DATABASE_APP_URL, runs the given command, cleans up.
set -eu
BIN=$(ls -d /usr/lib/postgresql/*/bin | tail -1)
DIR=$(mktemp -d); chmod 777 "$DIR"
RUN="runuser -u postgres --"
$RUN $BIN/initdb -D "$DIR/data" -A trust >/dev/null
$RUN $BIN/pg_ctl -D "$DIR/data" -o "-p 54330 -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/log" -w start >/dev/null
trap '$RUN $BIN/pg_ctl -D "$DIR/data" -m immediate stop >/dev/null; rm -rf "$DIR"' EXIT
export TEST_DATABASE_URL="postgres://postgres@127.0.0.1:54330/postgres"
export TEST_DATABASE_APP_URL="postgres://app_user@127.0.0.1:54330/postgres"
"$@"
