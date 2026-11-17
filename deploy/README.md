# Self-hosting (interim)

Compose stack for one server: Caddy (HTTPS), the app, Postgres. See [docs/INTERIM-HOSTING.md](../docs/INTERIM-HOSTING.md) for the plan, cost, backups and risks.

- `compose.yml`, `Caddyfile`: the stack. Only ports 80/443 are published.
- `.env.example`: copy to `.env`, fill in (git-ignored).
- `initdb/`: creates the `app_user` role with its password on first start.
- `replica/`: live standby database on Oracle (bootstrap and promote scripts).
- In-app backups (set up on the owner's Backups page, nothing to install here): the app image carries `pg_dump` and `pg_restore` 16 and makes a nightly encrypted copy to your own S3-compatible bucket, plus a weekly restore test. Steps for the owner, and for restoring after losing this server, are in [docs/BACKUPS.md](../docs/BACKUPS.md). The `DATABASE_URL` in `compose.yml` uses the `postgres` role, which the restore test needs (it creates a throwaway database).
- `backup.sh`: encrypted `pg_dump`, copied to a second server by rsync. Run nightly from cron.
- `restore.sh <file>`: restore a `backup.sh` backup (destructive, asks for confirmation). For in-app backups use the steps in docs/BACKUPS.md, "Restoring for real".

`backup.sh` still works as before and can run alongside the in-app backups.
