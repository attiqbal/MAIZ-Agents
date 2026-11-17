# Runbook

How to run MAIZ Agents once it is live. Setup is in [DEPLOY.md](DEPLOY.md).

## Shape
- One Docker service serves the website (`web/dist`) and the API (`/api/*`) on one address. Built and checked by CI on every pull request; Render deploys `main` automatically.
- Postgres on Neon. Every customer write goes through the `app_user` role with row-level security, so one customer cannot see another's rows (`npm run db:test` proves it).
- The server keeps working data in memory and writes changes to Postgres in the background (write-behind). On start it loads everything back. On shutdown (SIGTERM) it stops taking requests and flushes pending writes first.

## Health
- `GET /api/health` answers `{"ok":true}`, or `503` when writes to Postgres are failing. Render restarts the service when the check fails.
- Logs (Render > service > Logs): start-up prints `storage: postgres`, `website: serving web/dist` and `listening on :PORT`. Failed requests print `... failed:` with the error. Config problems print `config: ...` and the service exits.
- External uptime check: `.github/workflows/uptime.yml` asks `/api/health` and `/api/health/backups` every 10 minutes and GitHub emails when either fails. Set the repository variable `UPTIME_SITE_URL`, and see docs/BACKUPS.md, "The uptime check", for who gets the email and GitHub's limits (late or skipped runs, switched off after 60 days without activity). A second monitor from another company (for example UptimeRobot or Better Stack) on `https://<your address>/api/health` is still sensible.

## Deploy and roll back
- Deploy: merge to `main`. Render builds the Dockerfile and swaps over when the health check passes.
- Roll back: Render > service > Events, pick the last good deploy, **Rollback**. Database migrations only ever add (`db/*.sql`, applied in order on start), so the previous version keeps working with the newer schema. A migration that removes or renames something needs its own plan.

## Backups
- In-app: the owner's **Backups** page (`/owner-backups.html`). Nightly encrypted dump at 03:10 owner time to the owner's own S3-compatible bucket, last 30 kept; weekly restore test into a throwaway database; email to the owner on a failed backup, a failed test, or no good backup for 36 hours (once a day per problem).
- `GET /api/health/backups` answers only `{"ok":true|false}`; it is false (503) when backups are set up and the newest good one is over 36 hours old.
- Needs `pg_dump` and `pg_restore` 16 (in the Docker image; `PG_BIN_DIR`) and a database role that can create databases. On a server without them the page says "not available on this server".
- Lost the server: follow docs/BACKUPS.md, "Restoring for real". It needs the backup file and the recovery key, nothing else. The recovery key is not recoverable from the server; make sure the owner saved it.
- `TOKEN_KEY` is sealed inside every backup (locked with the recovery key), so the one saved key is enough. Keep the password-manager copy of `TOKEN_KEY` too.

## Database
- Turn on Neon point-in-time restore before the first real customer.
- Restore: in Neon, create a branch from a point in time, check it, then point `DATABASE_URL` / `DATABASE_APP_URL` at it and redeploy.
- New migration: add `db/00N_name.sql`. It runs once on the next start (tracked in the database).

## Secrets
- All secrets live in Render's environment settings. None are in the repo, the image or the logs.
- Rotate `SESSION_SECRET`: everyone is signed out, nothing else breaks.
- Rotate `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, Slack secrets: replace the value and redeploy.
- **`TOKEN_KEY` cannot be rotated in place**: it encrypts stored Slack tokens. Changing it means every customer reconnects Slack. Keep a copy in a password manager.
- If a secret leaks: rotate it at the provider first, then here.

## Limits to know before growing
- **One instance only.** Used sign-in links, pending password sign-ups (a restart means the person registers again), the failed-password and reset-email limits, the per-email sign-in limit and per-address rate limits are in memory, and the write-behind store assumes a single writer. Moving these into Postgres is the step before running two instances.
- A restart forgets which sign-in links were used, so a link from the last 15 minutes could be used a second time. Links still expire after 15 minutes.
- Decisions: the platform owner gets at most one "decisions are waiting" email per 30 minutes (`src/server/decisions.ts`), linking to `/owner-decisions.html`.
- Rate limits: sign-in and sign-up 10 per 10 minutes per address, other POSTs 60 per minute. Tasks (`/api/ask`) have no request limit: energy (the weekly pool, daily ceiling and cost cap) is the limit. The weekly energy refill happens at each client's own Monday 00:00 (their batch time zone). Change them in `src/server/rate-limit.ts`.
- AI spend: each employee has a daily energy quota and a monthly cost cap (`docs/DEFAULTS.md`). Also set a spend limit on the Anthropic console.

## Free trial
- Trials are 7 days with no card. There are no payments yet; nothing charges customers.
