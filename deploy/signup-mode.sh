#!/usr/bin/env bash
# Switch the site between pre-launch ("interest": register your interest only) and live ("open": signup, login, trial).
# Usage, on the server:  cd /opt/maiz && git pull && deploy/signup-mode.sh open     (or: interest)
# It edits SIGNUP_MODE in deploy/.env and rebuilds, because the website copy is built in. Takes about two minutes.
set -euo pipefail
mode="${1:-}"
case "$mode" in open|interest) ;; *) echo "usage: $0 open|interest" >&2; exit 2;; esac
cd "$(dirname "$0")"
[ -f .env ] || { echo "deploy/.env not found" >&2; exit 1; }
if grep -q '^SIGNUP_MODE=' .env; then sed -i "s/^SIGNUP_MODE=.*/SIGNUP_MODE=$mode/" .env; else printf '\nSIGNUP_MODE=%s\n' "$mode" >> .env; fi
echo "SIGNUP_MODE=$mode set in deploy/.env. Rebuilding..."
docker compose up -d --build
sleep 8
echo; echo "Server said at start-up:"; docker compose logs --tail=30 app | grep -E "signup is open|config:|listening" || true
echo; echo "Live check:"; curl -fsS "https://$(grep '^DOMAIN=' .env | cut -d= -f2)/api/signup/mode" || echo "(could not reach the site yet; try again in a minute)"
echo
