# Self-hosting (interim)

Compose stack for one server: Caddy (HTTPS), the app, Postgres. See [docs/INTERIM-HOSTING.md](../docs/INTERIM-HOSTING.md) for the plan, cost, backups and risks.

- `compose.yml`, `Caddyfile`: the stack. Only ports 80/443 are published.
- `.env.example`: copy to `.env`, fill in (git-ignored).
- `initdb/`: creates the `app_user` role with its password on first start.
- `backup.sh`: encrypted `pg_dump`, copied to a second server by rsync. Run nightly from cron.
- `restore.sh <file>`: restore a backup (destructive, asks for confirmation).
