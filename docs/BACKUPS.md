# Backups

What this page covers: how MAIZ Agents keeps a copy of all its data away from the server, how the owner sets that up in the browser, how the copy is checked, how the site is watched from outside, and how to get everything back after the server has been lost. The first half is for the owner and uses plain words. "Restoring for real" is for a technical person.

## What it does, in plain words

- Every night at 03:10 (owner time zone, `OWNER_TIMEZONE`, default London) the site copies its whole database, locks the copy with your recovery key, and puts it in a storage bucket that you own at a different company from the one that runs the server.
- It keeps the last 30 nightly copies (you can choose 7 to 365). Copies made with the "Back up now" button are kept apart, the last 5 of them, so pressing the button never pushes a night out.
- Once a week it takes the newest copy, unlocks it, loads it into a spare empty database, counts what is there, and deletes the spare. That proves a copy can really be restored. It never touches the live data.
- If the nightly copy fails, if a restore test fails, or if there has been no good copy for 36 hours, the owner gets an email (and a push message on their devices, except between 22:00 and 07:00). Each kind of problem is reported at most once a day.
- A separate check from outside (see "The uptime check") asks the live site every 10 minutes whether it is up and whether its copies are fresh.

What it does not do: it does not set up the live standby database (the Oracle replica in `docs/INTERIM-HOSTING.md`), and it cannot recover anything newer than the last copy. Between two nightly copies, up to 24 hours of changes exist only on the server. "Back up now" before a risky change narrows that.

## Setting it up (all in the browser)

Log in as the platform owner and open **Backups** in the owner menu.

1. **Where backups are kept.** Make a private bucket at a storage company (any S3-compatible one: Cloudflare R2, Backblaze B2, AWS S3, Wasabi and others) and an access key limited to that bucket. Paste five things into the form: the storage address (starts with https://), the bucket name, the key id, the secret, and, only if the company gives you one, the region. A folder inside the bucket is optional. Press **Check and save**. Before saving, the site writes a small test file to your bucket, finds it again and removes it. If any step fails nothing is saved and the page says why in words.
2. **Your recovery key.** Press **Make my recovery key**. The site shows the key once. Save it in a password manager, or print it, and keep it somewhere that is not this server. Then press **I have saved it somewhere safe**. After that the key is hidden for good.
3. The page now says when the first backup will be made. Press **Back up now** and **Test a restore now** once, to see both work before you rely on them.

The storage details and the key are kept only through the site's existing encrypted secret store (`TOKEN_KEY`, the same one that holds Slack tokens). The secret you type is never shown again; the page only says "Saved". Editing the address, bucket or key id means typing the secret again, so a saved secret can never be sent to a new place.

### Worked example: Cloudflare R2

All of this is done on the Cloudflare website.

1. Log in at dash.cloudflare.com and open **R2 Object Storage** in the left menu. The first time, Cloudflare asks for a payment card to switch R2 on. Check their price list yourself: this page does not know what they charge.
2. Press **Create bucket**, name it (for example `maiz-backups`), leave the rest, and create it. Keep it private.
3. On the R2 overview press **Manage API tokens**, then **Create API token**.
4. Permissions: **Object Read & Write**. Under "Specify bucket" choose **Apply to specific buckets only** and pick your bucket. Create the token.
5. Cloudflare shows an **Access Key ID**, a **Secret Access Key** and an address ending in `.r2.cloudflarestorage.com`. Copy all three before leaving the page. The secret is shown once.
6. In MAIZ: paste the address, the bucket name, the key id and the secret. Leave Region empty. Press **Check and save**.

Cloudflare renames buttons from time to time. If a name here does not match, look for the nearest one.

### Why the bucket should be at another company

If the server, its company account and the bucket were all at one company, one billing problem or one closed account could take everything. Use a different company for the bucket than the one that runs the server.

## What the page tells you

The top of the page says in words which of these is true:

| Heading | Meaning | What to do |
|---|---|---|
| Your data is backed up | Newest copy is under 36 hours old and the last test passed | Nothing |
| Backups are not set up yet | No storage details or no recovery key | Do the two steps on the page |
| Set up, and waiting for the first backup | Set up, first nightly run not yet due | Wait, or press Back up now |
| A backup is being made right now | A job is running | Wait; the page updates itself |
| The newest backup is more than 36 hours old | The nightly runs are failing | Read the reason on the page, fix it, press Back up now |
| You have a recent backup, but the last try failed | Last night failed, an earlier copy is fine | Read the reason; it retries each hour, three times |
| The last restore test did not pass | A copy could not be loaded in the test | Read the reason; make a fresh copy and test again |
| Backups are not available on this server | No database on this server, or `pg_dump` and `pg_restore` are not installed on it | Whoever runs the server must fix it; the page cannot |

The reason shown is always in plain words (for example "Your storage did not accept the key id or the secret."). A short technical line is tucked under "Technical detail for whoever helps you". Secrets are removed from it.

## The recovery key: what is true

- The key is made on the server and shown to you once. Nobody at MAIZ can show it again or make the same one again.
- The server also keeps its own copy, encrypted, because the nightly run needs it to lock the copy without you. That copy lives on the server. **If the server is lost, its copy is lost with it. The copy you saved is then the only way to open a backup.** Saving the key somewhere else is not optional.
- Anyone who has the key and a backup file can read all your data. Do not email the key or paste it into a chat.
- **Make a new recovery key** locks new backups with a new key. Backups already in storage still need the old key, so keep the old one until those have aged out (30 nights by default). The server remembers up to five older keys so its weekly test can still open older copies.
- Turning backups off keeps the keys, because copies already in storage still need them.

## What is inside a backup

A backup file is a database dump (`pg_dump -Fc` of `DATABASE_URL`) locked with AES-256-GCM. The lock key is derived from your recovery key (HKDF-SHA256). The server's own `TOKEN_KEY` is sealed inside the header, locked with the same recovery key. This matters: `TOKEN_KEY` encrypts staff HR records, saved app tokens and the backup settings themselves, so a restored database is useless without it. Sealing it means the one saved recovery key is enough after losing the server. To turn this off, remove `serverKeys` where `backup` is set in `src/server/main.ts`; then keep `TOKEN_KEY` in a password manager (the Runbook already says to).

The dump itself is streamed straight into the lock, so a plain copy of the database is never written to the server's disk by a backup. The restore test must write the unlocked dump to a temporary file for `pg_restore`; that file is removed when the test ends, also when it fails, and any left over from a crash are swept when the server starts.

Files in the bucket are named `maiz-nightly-YYYYMMDDTHHMMSSZ.backup` and `maiz-manual-YYYYMMDDTHHMMSSZ.backup`. The site only ever lists, reads and removes files with those names. Other files in the bucket, including the `maiz-*.dump.enc` files from `deploy/backup.sh`, are left alone.

## Restoring for real (after the server has been lost)

For a technical person. You need three things: this repository, one backup file from the bucket, and the recovery key. No old server, no database and no running site are needed to open the file.

1. **Get a new server** and the repository on it, with Docker as in `deploy/README.md`. Fill in `deploy/.env`. Set a new `POSTGRES_PASSWORD` and `APP_USER_PASSWORD`; leave `TOKEN_KEY` for step 4.
2. **Start only the database**, so the `app_user` role is created by `deploy/initdb`:
   ```
   docker compose -f deploy/compose.yml --env-file deploy/.env up -d db
   ```
3. **Download the newest backup file** from your bucket using the storage company's website (or any S3 tool). Pick the newest `maiz-nightly-…` or `maiz-manual-…` file. Put it in a private folder.
4. **Open it with the recovery key.** On any machine with Node 22 and this repository (`npm ci` once):
   ```
   MAIZ_RECOVERY_KEY='XXXXX-XXXXX-...' npm run backup:open -- maiz-nightly-20261116T031000Z.backup maiz.dump
   ```
   The script prints when the backup was made and which key id it needs. It writes `maiz.dump` (the database dump) and `maiz.dump.server-keys.env`, which holds the old server's `TOKEN_KEY`. Both files are readable by you only. A wrong key is refused with a plain message and nothing is written. Without `MAIZ_RECOVERY_KEY` set it asks for the key at the prompt.
5. **Copy `TOKEN_KEY=…`** from `maiz.dump.server-keys.env` into `deploy/.env`. If the file says the backup does not carry it, use the copy from your password manager.
6. **Load the dump** into the new database:
   ```
   docker compose -f deploy/compose.yml --env-file deploy/.env exec -T db pg_restore -U postgres -d postgres --clean --if-exists --no-owner < maiz.dump
   ```
   Messages about objects that "do not exist, skipping" at the start are normal on an empty database.
7. **Start everything:**
   ```
   docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
   ```
   Check `https://<your address>/api/health` answers `{"ok":true}`, log in as the owner, and open Backups. The old storage details are in the restored data, so backups carry on by themselves. Press **Back up now** and **Test a restore now** to confirm.
8. **Switch DNS** to the new server if it has a new address.
9. **Delete `maiz.dump` and `maiz.dump.server-keys.env`** from every machine they were written to. They hold all the data and the server key in the clear.

This sequence (open with the script, `pg_restore --clean --if-exists --no-owner` into an empty database, start the app on it) is rehearsed against a real Postgres 16 by `npm run db:backup`, with a wrong-key refusal. It has not been run against a real bucket or a real lost server.

`deploy/backup.sh` and `deploy/restore.sh` still work as before and are separate: they make `maiz-*.dump.enc` files with a passphrase and `openssl`. Use `restore.sh` only for files `backup.sh` made. You can run both, or retire `backup.sh` once the in-app backups have run well for a while.

## The uptime check

`.github/workflows/uptime.yml` runs on GitHub every 10 minutes. It has two steps, so the email says which one failed:

1. **The site answers**: `GET /api/health`, with three more tries 20 seconds apart, so one slow moment or a restart during a deploy is not an alarm.
2. **Backups are fresh**: `GET /api/health/backups`. This public address answers only `{"ok":true}` or `{"ok":false}` (HTTP 503) and nothing else. It says yes until backups are set up, then no when the newest good backup is more than 36 hours old.

Set the address: repository **Settings > Secrets and variables > Actions > Variables**, new variable `UPTIME_SITE_URL`, for example `https://maizagents.com`. Without it the check uses `https://maizagents.com`.

Who gets the email: when a scheduled run fails, GitHub emails the person who last edited the workflow's schedule or switched the workflow on. To make sure that is the owner: in the repository, open **Actions > Uptime**, use the three dots menu, **Disable workflow**, then **Enable workflow** while logged in as the owner. Then check GitHub **Settings > Notifications > Actions** so failed-workflow emails are on. Press **Run workflow** once and read the result.

Limits to know, all GitHub's:

- Scheduled runs can start late (often several minutes) and GitHub sometimes skips one when it is busy. This is a watchdog, not a stopwatch.
- GitHub switches scheduled workflows off after 60 days with no activity in the repository. It sends a notice; re-enable it in the browser. A quiet repository needs a visit now and then.
- Every run uses Actions minutes. Public repositories are free. For a private repository, one run a minute or so at 144 runs a day is about 4,300 minutes a month, which is more than the 2,000 free on the GitHub Free plan. Check **Settings > Billing**, or change the schedule in the file to every 30 minutes.
- It watches from GitHub's network. If GitHub is down it says nothing. The in-app alerts do not depend on it, and it does not replace them.

## Settings and environment

- `DATABASE_URL`: the database that is dumped. It must be a role that can read everything and create databases (the compose file uses `postgres`). The restore test creates and drops a database named `maiz_restore_test_<random>`, and refuses to drop any other name.
- `PG_BIN_DIR`: folder holding `pg_dump` and `pg_restore` 16. The Docker image sets it to `/usr/lib/postgresql/16/bin`. Left empty, they are looked up on the search path.
- `OWNER_TIMEZONE`: sets "03:10" and the quiet hours for push messages.
- `TOKEN_KEY`: see above.
- The repository variable `UPTIME_SITE_URL` for the uptime check.

The restore test needs free disk space for one unlocked copy of the dump plus the throwaway database. For a database of a few hundred MB that is small; check it if the database grows into many GB. Uploads over about 4.5 GB are refused with a plain message (the site does not yet split them into parts).

## If something goes wrong

- "Backups are not available on this server": the server is running without a database, or the image does not have `pg_dump`. The Docker image built from this repository has them (Postgres 16 client tools from the PostgreSQL project's own apt repository). A server run by other means needs `postgresql-client-16` installed.
- "Your storage did not accept the key id or the secret": the key was mistyped, expired, or limited to another bucket. Make a new key and save the form again.
- "Your storage could not be reached": the address is wrong, or the site cannot reach it. The address must start with https:// and be a public name.
- "Older backups could not be removed": the newest backup is safe. The key probably lacks permission to delete. Give it Object Read & Write on the bucket.
- The restore test says it could not open the backup: the file was made with a key the server no longer remembers (more than five keys ago) or was damaged. Make a fresh backup and test again, and keep every old key until its backups have aged out.
- A backup says the database tools returned an error: the technical line under the message has the first lines of what `pg_dump` said.

## Tested against what

Written tests cover the signing code (against Amazon's published example values), the file format, the schedule, alerts, the routes, and the whole backup and restore test using a fake storage service that checks every signature. A test against a real Postgres 16 (`npm run db:backup`, also in CI) runs the real `pg_dump` and `pg_restore`, the full restore test, and the real-restore steps above. **No real storage service has been used** (not Cloudflare R2, Backblaze, AWS or any other); the first save on the live site is the first real test, which is why the form checks by writing, finding and deleting a file before it saves. The Docker image build, the GitHub uptime workflow and the push and email alert delivery have not been run end to end either.
