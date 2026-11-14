# Meta service-provider system (clients' Facebook, Instagram, WhatsApp)

MAIZ has applied to Meta as a **Tech Provider**: a service provider that acts on behalf of client businesses. This is the system that goes live the day approval lands. It is multi-tenant: each client connects their **own** Page, Instagram professional account and WhatsApp Business number. The owner's single-owner Page/Instagram/WhatsApp setup (docs/META-WHATSAPP.md, promotion agent) is separate and unchanged; it keeps using `META_ACCESS_TOKEN` and `WHATSAPP_*`.

Code: `src/modules/meta-clients/` (service, providers, permission list), `src/server/meta-routes.ts` (HTTP), pages `connect-social.html`, `owner-meta.html`, `data-deletion.html`, `sandbox-meta.html`. Review pack: `docs/META-APP-REVIEW.md` (generated).

## How it works

1. **Connect** (`/connect-social.html`). Client presses *Connect Facebook Page* or *Instagram*. The server makes a signed, single-use `state` bound to that browser by a cookie, and sends them to Facebook Login for Business (live) or a rehearsal window (sandbox). On return the server exchanges the code (server side, using the app secret), swaps it for a long-lived token, reads the Pages (and linked Instagram accounts) the person manages, and **only after the client picks one** stores that account's token. WhatsApp uses Embedded Signup in the browser; its code and ids are posted to `/api/meta/whatsapp`.
2. **Plain-English permissions.** Each connection card lists what it lets MAIZ do, from one list (`permissions.ts`). The same list generates the App Review pack and the owner status table.
3. **Posts and the approval gate.** The marketing employee/client creates a draft → status *awaiting approval* → only a person with the `approval.decide` permission (owner/admin) in the dashboard, or the **confirmed** WhatsApp approver number, can approve it. Nothing else moves a post out of that state. Approved posts publish immediately or at the chosen time (a once-a-minute scheduler, `maintenance()`).
4. **WhatsApp approvals.** Client's business number (Embedded Signup) messages the client's own approver number: "Reply YES K7P2". The approver number must first prove itself by replying `CONFIRM <6 digits>`. Replies from any other number are ignored. Free text is used only inside WhatsApp's 24-hour window, otherwise the approved template `maiz_client_approval` (one body variable).
5. **Limits and rate limits.** Per client: posts per day (default 3), per month (60), and most waiting for approval (20); the platform owner can change them within hard ceilings. When Meta says "slow down" (error codes 4, 17, 32, 341, 613, 80001-80008) the post waits with exponential back-off and the account is paused, then retries automatically up to 5 times. A token error (190) marks the connection *needs reconnecting*. A timeout or 5xx after a write is **never retried** (it could post twice); the client is told to check the Page.
6. **Results.** Likes/comments/shares per post and followers per account, cached 15 minutes.
7. **Disconnect / deletion.** Disconnecting deletes the token at once and cancels waiting posts. *Delete everything from Meta* erases connections, tokens and posts. Meta's callbacks:
   - `POST /api/meta/deauthorize` (signed): disconnects that Meta user's accounts everywhere.
   - `POST /api/meta/data-deletion` (signed): erases their data and returns `{url, confirmation_code}`; `GET /api/meta/deletion-status?code=` backs the page at `/data-deletion.html`.
   - Signatures are HMAC-SHA256 of the payload with the app secret; anything else is refused.
8. **Token health.** Twice a day each token is checked with Meta's `debug_token`; invalid ones are marked *needs reconnecting* and expiring ones flagged. Page tokens obtained from a long-lived login do not expire, but Meta can still end access (password change, app removed, 90-day data access window).

## Sandbox and live

| | Sandbox (default) | Live |
|---|---|---|
| Switch | `META_MODE` unset | `META_MODE=live` plus `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` and an https `APP_URL` (startup refuses otherwise) |
| Login | MAIZ's own rehearsal window, fake accounts "Sunrise Bakery (test)" | Facebook Login for Business (config `META_LOGIN_CONFIG_ID`, else scopes sent directly) |
| Posting | Simulated; posts get a `sandbox-` id and a non-clickable "Test post" marker | Graph API (`/feed`, `/photos`, `/media` + `/media_publish`) |
| WhatsApp | Messages go to an on-screen "pretend phone"; replies are typed there | Cloud API + Embedded Signup |
| Who can use it | Everyone | Development mode: people with a role on the app (add testers). After approval: everyone. |

Going live is configuration only: set the variables, restart, and the "Ready to go live?" list on `/owner-meta.html` should be all green. A sandbox connection stays labelled *Test* and does not turn into a live one; clients reconnect once live (their old fake accounts are replaced when they choose again).

## What is verified and what is not (honest status)

**Verified by automated tests (27 + docs test):** the full connect flow in sandbox through the real HTTP routes; state/cookie/replay protection; only the starting user can finish a choice; approval gate; daily-limit refusal; scheduling; tenant isolation; disconnect cancels posts; signed deauthorize/deletion (good and bad signatures) and the status page; webhook handshake and signature; WhatsApp approver confirmation, YES/NO by code, ignoring other numbers; the **live provider against a fake Graph API** (request shapes, token in a header never an address, `appsecret_proof`, rate-limit back-off and later success, token-invalid handling, no retry after an uncertain outcome, health check); owner-only status endpoints; config validation; the generated review doc being current.

**NOT verified against real Meta** (no app credentials exist yet): the actual Facebook Login for Business dialog and `config_id` behaviour; the Embedded Signup message format (`WA_EMBEDDED_SIGNUP` / `FINISH`) and whether the number must be registered with `POST /{phone-id}/register` after signup; real token lifetimes; that `/me/accounts` returns Instagram accounts for the permissions granted; Instagram publishing limits; whether `maiz_client_approval` is approved; reach metrics (only followers are read live: Meta's insight metric names change often, so reach is not read for Facebook and is untested for Instagram); `DELETE /me/permissions` on revoke. Each of these is a first-day check once credentials exist; the Development-mode testers are the way to do it before approval.

## Setting up the Meta app (for Atif)

1. Developers dashboard → your app → add products: Facebook Login for Business, WhatsApp, Webhooks. Fill in the addresses from `/owner-meta.html` (it lists every one).
2. Create a Facebook Login for Business **configuration** with the permissions on `/owner-meta.html` (use the "User access token" type) → `META_LOGIN_CONFIG_ID`. Create a WhatsApp **Embedded Signup configuration** → `META_WHATSAPP_CONFIG_ID`.
3. WhatsApp → Configuration: webhook URL `<APP_URL>/api/meta/webhook`, verify token = `META_WEBHOOK_VERIFY_TOKEN`, subscribe to `messages`. If you also use the owner line, this one URL serves both (the old `/api/whatsapp/webhook` still works if you leave the webhook pointing there, but then client replies will not arrive).
4. Create and submit the message template `maiz_client_approval` (utility category, one `{{1}}` body variable, e.g. "MAIZ Agents: {{1}}").
5. Add testers (App roles), set `META_MODE=live` and the ids in the server environment, restart. Run each screencast script in `docs/META-APP-REVIEW.md` once yourself.
6. Submit App Review from that pack. As Meta decides each permission, record it on `/owner-meta.html`.

## Security notes

Tokens are only ever in memory and, with `DATABASE_URL`, encrypted AES-256-GCM with `TOKEN_KEY` (same store as the app connectors); they are never returned by any API, never put in a URL or log, and removed on disconnect/deletion. Every Graph call carries `appsecret_proof`. All routes check the caller's workspace and role; a business can never see or act on another's accounts or posts. Approver numbers are masked in every reply. Webhooks are acknowledged immediately and processed after, signatures verified over the raw bytes. `connect-social.html` has its own CSP allowing only Meta's SDK and frames (Node server honours the per-page rule in `_headers`; on a static host that merges duplicate CSP headers, mirror the rule).

## Not built / follow-ups

- The AI marketing employee does not yet draft into this queue by itself; today the client (or a later change to the Marketing desk) creates drafts through `MetaClientService.draft`. It's the one place to plug in.
- No ads or paid spend: "per-client spend" is expressed as post caps. Energy is not charged for posting yet.
- Facebook Page webhooks (comments/messages) and Instagram comments are out of scope; no inbox.
- Pending `/api/meta/pending` choices live in memory (15 min); a restart mid-login means starting again.
- The first-day chat (PR #54) can link straight to `/connect-social.html`; a chat-native version should reuse the `/api/meta` calls in `connect-social.ts`. The owner Connections thread's branch was not available to reuse at the time of writing.
