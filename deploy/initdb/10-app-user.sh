#!/bin/bash
# Runs once, when the database volume is first created. The app's migrations create the role if missing; this gives it a password first.
set -eu
psql -v ON_ERROR_STOP=1 -U postgres -d postgres -v pw="$APP_USER_PASSWORD" <<'SQL'
CREATE ROLE app_user LOGIN PASSWORD :'pw';
SQL
