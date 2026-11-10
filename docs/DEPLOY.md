# Deploying MAIZ agents

One service runs the website and the API together (`Dockerfile`), with Neon for the database and Resend for sign-in emails.
The recommended host is **Render** (`render.yaml`). Any host that runs a Docker image works the same way (Fly.io, Railway, a VPS).

Nothing here needs code changes. Put each value in the host's environment settings or the repo's secrets, never in chat or in a file.

Order: 1 Neon, 2 Resend, 3 Anthropic key, 4 Render, 5 Slack (optional), 6 domain. Day-two operations are in [RUNBOOK.md](RUNBOOK.md).

## 1. Database: Neon (neon.com)
1. Create a project (free plan is enough for a pilot). Pick the region closest to your customers.
2. In the project, open **Connection details** and copy the connection string for the default owner role. That is `DATABASE_URL`. Keep it secret: it can read every customer's data.
3. Start the API once with `DATABASE_URL` set (plus a placeholder `DATABASE_APP_URL` and `TOKEN_KEY`). It applies `db/*.sql` and creates the `app_user` role.
4. In Neon's SQL editor run `ALTER ROLE app_user PASSWORD '<a long random password>';`. Build `DATABASE_APP_URL` from the same connection string with `app_user` and that password. The API uses this role for every customer write, so row-level security applies.
5. Generate `TOKEN_KEY` with `openssl rand -hex 32`. It encrypts Slack bot tokens. **Losing it means customers have to reconnect Slack**, so back it up.
6. Turn on Neon's point-in-time restore (history retention) before real customers arrive.

## 2. Sign-in emails: Resend (resend.com)
1. Create an account, add and verify your sending domain (DNS records).
2. Create an API key: `RESEND_API_KEY`. Set `EMAIL_FROM` to an address on that domain and `APP_URL` to the website address.

## 3. Anthropic key (console.anthropic.com)
Create an API key for the workspace that will pay for usage and set a monthly spend limit there. That is `ANTHROPIC_API_KEY`. The server will not start in production without it, so trial customers never get mock answers.

## 4. Host: Render (render.com)
1. Sign in with GitHub and choose **New > Blueprint**, then pick this repository. Render reads `render.yaml`: one always-on Docker web service (Starter plan) with a health check on `/api/health`.
2. Fill in the values it asks for: `SITE_URL` and `APP_URL` (your address, for example `https://maizagents.com`; use the `onrender.com` address until the domain is ready), `DATABASE_URL`, `DATABASE_APP_URL`, `TOKEN_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, and the Slack values if you use Slack. `SESSION_SECRET` is generated for you.
3. Pick the region nearest the Neon database (the blueprint says Frankfurt; change both together).
4. Deploy. The first start applies the database migrations. Open `/api/health`: it should say `{"ok":true}`.
5. Keep **one instance**. Sign-in links in use and rate limits are held in memory; see the runbook before scaling out.

## 5. Slack app (api.slack.com/apps)
1. Create an app from scratch. Under **OAuth & Permissions** add the redirect URL `<API address>/api/slack/callback` and the bot scopes `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`.
2. Under **Event Subscriptions** set the request URL to `<API address>/api/slack/events` and subscribe to bot events `app_mention` and `message.im`.
3. Under **App Home** turn on the Messages tab.
4. Copy **Client ID**, **Client Secret** and **Signing Secret** into `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`. Set `SLACK_REDIRECT_URI` to the redirect URL from step 1.

Use your live address (`APP_URL`) as `<API address>`: the website and the API share it.

## 6. Domain
In Render, open the service, **Settings > Custom domains**, add your domain and create the DNS records it shows. Then set `SITE_URL`, `APP_URL` and `SLACK_REDIRECT_URI` to the new address, update the Slack app URLs, and redeploy.

## Production checks
The server refuses to start in production (`NODE_ENV=production`) without `SESSION_SECRET` (32+ characters), `DATABASE_URL`, `DATABASE_APP_URL`, `TOKEN_KEY` (64 hex), `RESEND_API_KEY`, `EMAIL_FROM`, an `https://` `APP_URL` and `ANTHROPIC_API_KEY`, refuses half a Slack setup, and refuses if `ALLOW_DEV_AUTH=1`. Each problem is printed in the log.
