# Interim hosting until funded

Goal: run MAIZ Agents for the first pilot customers at the cost of one small server, without a rewrite, and move to a proper server later without pain.

## Recommendation

Keep the app exactly as it is (Node, one container, Postgres). Run it on the **Hetzner** server you already pay for. Use the **Oracle** server as the off-site backup store and cold standby. Keep **RunPod Serverless** for inference. Do not rebuild in Python/FastAPI now: the FastAPI blueprint is a good target shape, but a rewrite costs weeks and adds no customer value before there is revenue.

| Piece | Where | Why |
|---|---|---|
| Website + API (one container) | Hetzner | 4 cores / 8 GB is far more than a pilot needs |
| HTTPS, certificates | Caddy on Hetzner | automatic, free |
| Postgres (authoritative records, row-level tenant isolation) | Hetzner, Docker volume, not public | `app_user` role keeps RLS enforced |
| Nightly encrypted backup + 14-day history | Oracle (copied over SSH) | a copy on a different provider survives losing Hetzner |
| Cold standby | Oracle (12 GB RAM) | same compose file; restore latest backup and repoint DNS |
| AI inference | RunPod Serverless (+ Claude as light QA/fallback) | pay per second, no idle GPU |
| Sign-in email | Resend free tier | 3,000 emails/month |
| Uptime alerts | UptimeRobot or Better Stack free, watching `/api/health` | outside both servers, so it still alerts if one dies |
| DNS | Registrar, or Cloudflare free | |

Not used yet: Redis, Celery/Dramatiq, WireGuard, OCR workers. The app keeps its queue and batch jobs in memory/Postgres and has no OCR or PDF pipeline to offload, so they would be idle weight. Add them when a real feature needs them (see the backlog below).

## Monthly cost

| Item | Cost |
|---|---|
| Hetzner (4 cores, 8 GB, 80 GB SSD) | about £10 |
| Oracle (already owned) | £0 extra |
| Domain | about £1/month (£10 to £15/year) |
| Resend, Caddy, uptime monitor, Cloudflare DNS | £0 |
| RunPod, Anthropic | usage only; set a spend limit in each console |
| **Fixed total** | **about £11/month** |

Lowest-effort fallback if you would rather not run a server: Render Starter (about $7/month) plus Neon free (`render.yaml` and `docs/GO-LIVE.md` already cover it). Render is about the same price as the Hetzner server (£10), so the Hetzner route mainly buys more headroom and control; the cost of it is being your own system administrator. Neon free also has a short point-in-time restore window.

## Honest risks

- One server is one failure domain. Recovery is manual: about an hour, with up to 24 hours of data lost (nightly backups). Tighten later by running backups every 6 hours or adding Postgres WAL archiving.
- The app must stay a **single instance** (sign-in links and rate limits are in memory). A bigger machine is the scaling path, not more containers.
- You patch the server. Turn on automatic security updates (`unattended-upgrades`), key-only SSH, and a firewall that allows only 22 (your IP), 80 and 443.
- `TOKEN_KEY` encrypts Slack and business-app connections. Store a copy in a password manager. Without it a restore works but customers must reconnect their apps.

## Disk budget (80 GB)

OS and Docker images about 10 GB, the database a few hundred MB for a pilot, and local backups kept 14 days (a few hundred MB each at most). That leaves well over 50 GB free. Watch it with `df -h`; prune old images with `docker image prune -f` after deploys. Oracle only holds the encrypted dumps.

## Setup (about an hour, done by you on the server)

Files are in `deploy/`. Nothing here has been run on your servers.

1. Hetzner: install Docker, open ports 22, 80, 443 only. Point `maizagents.com` and `www` DNS at the server IP.
2. `cp deploy/.env.example deploy/.env` and fill it in, adding the production variables listed in `render.yaml` that you use. Generate secrets with `openssl rand -hex 32`.
3. `docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build`, then open `https://maizagents.com/api/health`.
4. Oracle: run `uname -m` to confirm x86_64, then create a `backup` user with a directory `/srv/maiz-backups`; add the Hetzner server's SSH public key. Put a backup passphrase in `/root/.maiz-backup-pass` (mode 600) on Hetzner and keep a copy in your password manager.
5. Hetzner cron, nightly: `BACKUP_PASSPHRASE_FILE=/root/.maiz-backup-pass BACKUP_REMOTE=backup@<oracle-ip>:/srv/maiz-backups /opt/maiz/deploy/backup.sh`
6. **Test a restore on Oracle before the first customer** (`deploy/restore.sh`). An untested backup is not a backup.
7. Add the uptime monitor on `/api/health`.

Day-two operations remain in `docs/RUNBOOK.md`.

## Moving to a proper server later

The compose file is the same shape as the eventual server. Steps: take a final backup, restore it on the new host, bring up compose, switch DNS (lower the TTL a day before), keep the old box read-only for a week. Postgres can later move to a managed database by changing only `DATABASE_URL` and `DATABASE_APP_URL`.

## Ideas from the blueprint worth keeping as a backlog

1. Audit events table for who did what (high value for a finance-adjacent product).
2. A test that fails if any tenant table lacks a row-level-security policy.
3. RunPod outage behaviour: queue and retry, with a clear status to the customer. Partly covered by `docs/AI-ROUTING.md`.
4. WireGuard between the two servers once Oracle runs real workers; until then SSH keys are enough.
5. OCR/PDF extraction on Oracle when document upload becomes a customer need.
6. Redis and a job queue only when more than one instance is needed.

## Decisions for you

1. Hetzner self-host (chosen: about £10/month for the server) or Render + Neon (about $7/month, less admin)? Proceeding on Hetzner.
2. Is a day of possible data loss acceptable for the pilot? If not, backups every 6 hours (a one-line cron change).
3. Oracle is believed to be x86 (AMD). Confirm with `uname -m` (`x86_64` expected). The images are multi-architecture, so ARM would also work.
