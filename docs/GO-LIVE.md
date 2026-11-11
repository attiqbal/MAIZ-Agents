# Go-live checklist (owner only steps)

Everything in the repo is ready. These steps need your accounts. Never paste keys into chat: they go into Render's **Environment** tab.
Domain used below is `maizagents.com`. If the registrar receipt says otherwise, change `SITE_URL`, `APP_URL` and `EMAIL_FROM` in `render.yaml` first.

1. **Neon** (neon.com): New project, copy the connection string. Then in the SQL editor run `ALTER ROLE app_user PASSWORD '<long random>';` after the first start (see DEPLOY.md section 1). Turn on point-in-time restore.
2. **Resend** (resend.com): Domains > Add `maizagents.com`, add the DNS records it lists at your registrar, wait for Verified. API Keys > Create.
3. **Render** (render.com): New > Blueprint > pick this repo. Fill in the prompted secrets:
   `DATABASE_URL`, `DATABASE_APP_URL`, `TOKEN_KEY` (`openssl rand -hex 32`, back it up), `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `PLATFORM_OWNER_EMAILS` (your sign-in email), `RUNPOD_API_KEY` + `RUNPOD_ENDPOINT_ID` (both, or leave both empty). Google/Microsoft sign-in ids once that work lands.
4. **Custom domain**: service > Settings > Custom Domains > add `maizagents.com` and `www.maizagents.com`, copy the DNS records to your registrar, wait for the certificate.
5. **Check**: open `https://maizagents.com/api/health` (expects `{"ok":true}`), sign in with your owner email, confirm the email arrives, open `/review.html`.
6. Keep **one instance**. The batch queue and rate limits are in memory.
