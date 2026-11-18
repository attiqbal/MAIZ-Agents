# Google setup: sign-in and analytics (maizagents.com)

Two **separate** Google OAuth clients. Both are pasted into `deploy/.env` on the server only (the Owner > Connections page just shows whether each is set; it cannot take keys). Never paste an ID or secret into chat.

| | 1. "Continue with Google" (customer login) | 2. Analytics and Search Console (growth agent) |
| --- | --- | --- |
| Variables | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `GOOGLE_DATA_CLIENT_ID`, `GOOGLE_DATA_CLIENT_SECRET` |
| Scopes | `openid email` only (non-sensitive: no Google review needed) | `analytics.readonly`, `webmasters.readonly` (sensitive: needs verification) |
| Authorised redirect URI | `https://maizagents.com/api/signin/oauth/google/callback` | `https://maizagents.com/api/integrations/callback` |

Both: Google Cloud Console > APIs & Services > Credentials > Create credentials > OAuth client ID > **Web application**. No JavaScript origins are needed (the flow is server-side); leave that box empty. Redirect URIs must match exactly (https, no trailing slash).

## 1. Customer login (do this first, about 10 minutes)
1. Pick or create a Google Cloud project. OAuth consent screen (Google Auth platform > Branding): app name MAIZ Agents, support email, logo optional, authorised domain `maizagents.com`, links to `https://maizagents.com/privacy.html` and `/terms.html`.
2. Data access: add only `openid` and `.../auth/userinfo.email` (they are added by default).
3. Audience: set **External**, then **Publish app** (In production). Non-sensitive scopes publish without review. If left in Testing, only listed test users can sign in.
4. Create the Web application client with the redirect URI above. Copy the Client ID and Client secret.
5. On the server: `nano /opt/maiz/deploy/.env`, add `GOOGLE_CLIENT_ID=...` and `GOOGLE_CLIENT_SECRET=...` (both, or neither: the server refuses to start with one), save, then `cd /opt/maiz && docker compose up -d` (restart only, no rebuild).
6. Check: `docker compose logs --tail=20 app` shows no `config:` error. Open `https://maizagents.com/signin.html`: a "Continue with Google" button should appear. Sign in with a non-owner Google account; you should land signed in. (The platform owner always gets the emailed link instead, by design.)

## 2. Analytics and Search Console (needed for the verification video)
Create a second Web client in the same or another project, enable the Google Analytics Data/Admin APIs and Search Console API, add the two read-only scopes on the consent screen, add the redirect URI above, then set `GOOGLE_DATA_CLIENT_ID` and `GOOGLE_DATA_CLIENT_SECRET` in `deploy/.env` and run `docker compose up -d`. Until verified, only listed test users (max 100) can connect and permission expires after 7 days. Full verification steps: `docs/GROWTH-ANALYTICS.md` and the project's `google-oauth-demo/` folder.

## Not needed
Microsoft sign-in is optional and independent (`MICROSOFT_CLIENT_ID/SECRET`, redirect `https://maizagents.com/api/signin/oauth/microsoft/callback`).
