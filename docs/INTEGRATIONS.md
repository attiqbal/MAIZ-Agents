# Business app integrations

Owners connect the apps they already use (accounting, tills, payments, payroll) on the **Apps** screen. Employees then work from real numbers instead of asking for them.

Code: `src/modules/integrations`. Tests: `test/integrations.test.ts`.

## How it works

```
app (Xero, Square, BrightPay export, Zapier…)
   │  connector turns it into normalised records
   ▼
SalesDay · PayrollRun · AccountsMonth        ← one shape whatever the app
   │
   ├─ sales / payroll → "Waiting to go into your books" → owner presses Add to books → Ledger (deterministic)
   ├─ accounts (Xero) → read for context only; the owner's books stay in their accounting app
   └─ every record    → employees whose job needs it, as totals in their instructions
```

- **Connector** (`types.ts`): one object with a key, name, category, honest availability, capabilities, an auth spec, and one or more of `read` (live API), `parseFile` (CSV export), `exchangeCode`/`refresh` (OAuth quirks), `validate` (API-key checks).
- **Registry** (`catalogue.ts`): `defaultRegistry()` registers every connector. It refuses a connector that could not work (live without `read`, file without `parseFile`).
- **Service** (`service.ts`): connect (OAuth, API key, webhook, file), sync, import, post to ledger, per-employee context. All calls check the user's role in that organisation; another organisation's connection looks like one that does not exist.
- **Credentials**: never returned by the API, never logged. Stored through the sink, which encrypts them with `TOKEN_KEY` (AES-256-GCM, same as Slack tokens). Webhook links keep only a SHA-256 of the secret. Stripe accepts only restricted (`rk_`) keys so it can never move money.
- **Permissions** (`access.ts`): least privilege by default. Sales: Finance, Consultant, Marketing, Compliance. Payroll: Finance, HR, Compliance. Accounts: Finance, Consultant, Compliance. The owner changes this per connection with the chips on the Apps screen. The Admin manager can never be given app data. Employees get totals only, never per-person pay.
- **Books**: nothing an app sends goes into the ledger until the owner confirms. Re-imports are idempotent; a changed figure for a day already in the books is shown as a conflict, never posted twice. Xero figures are never copied into our ledger.

## Add a new app

1. Create `src/modules/integrations/connectors/<app>.ts` exporting a `Connector`.
   - Has a public API with OAuth: set `auth: { kind: "oauth2", authorizeUrl, tokenUrl, scopes, envPrefix }` and write `read(ctx, range)` returning `{ sales | payroll | accounts }`. Add `exchangeCode`/`refresh` only if the app differs from the standard RFC 6749 form exchange (Xero wants Basic auth and a tenant id).
   - API key: `auth: { kind: "api_key", fields }`, plus `validate` to reject keys with too much access.
   - Only exports files: `auth: { kind: "file", accepts, howToExport }` and `parseFile`. Reuse `parseTillCsv` or add header aliases.
   - Not built yet: list it with `auth: { kind: "bridge" }` (the card offers Zapier or Make meanwhile).
2. Register it in `defaultRegistry()`.
3. For OAuth, set `<PREFIX>_CLIENT_ID` and `<PREFIX>_CLIENT_SECRET` and register `<APP_URL>/api/integrations/callback` as the redirect URI in the app's developer console. Without both, the card falls back to file upload or Zapier.
4. Add a test with a fake `http` that returns the app's real response shape.

No changes to the server, storage, website or employees are needed.

## API

| Method | Path | Who |
|---|---|---|
| GET | `/api/integrations` | member: catalogue, connections, pending records |
| POST | `/api/integrations/apps/:key/connect` | owner: OAuth URL, API key (`{ values }`) or new webhook link (shown once) |
| POST | `/api/integrations/apps/:key/import` | member: `{ csv, date? }` from an export |
| POST | `/api/integrations/connections/:id/sync` | member: pull the last 30 days |
| POST | `/api/integrations/connections/:id/access` | owner: `{ employees: [templateKey…] }` |
| DELETE | `/api/integrations/connections/:id` | owner |
| GET | `/api/integrations/growth` | member: this week's traffic and Google search figures, alerts, plain-words lines |
| GET | `/api/integrations/connections/:id/choices` | owner: the Analytics properties or Search Console sites this Google login can read |
| POST | `/api/integrations/connections/:id/choose` | owner: `{ id }`, re-checked against Google's live list |
| POST | `/api/integrations/post` | member: add pending records to the books |
| GET | `/api/integrations/callback` | public, signed state: OAuth return |
| POST | `/api/integrations/hooks/:id/:secret` | public, secret link: `{ sales | payroll | accounts: [...], amountsIn?: "major" }` |

> More apps (CRM, support, bookings, shops, email, task boards) and the approval-gated ones are in `docs/CUSTOMER-APPS.md`.

## What each app actually offers (checked November 2026)

| App | What exists | What we do |
|---|---|---|
| **Xero** | Public OAuth 2.0 API. Apps created after 2 March 2026 must use granular scopes (`accounting.reports.profitandloss.read`). 30-minute access tokens with rotating refresh tokens. Xero now charges developers by number of connected organisations. | **Live**: monthly Profit and Loss, read only. |
| **BrightPay** | Cloud Payroll API is OAuth but UK only, in development, and open only to timesheet providers who apply by email. Its methods read employers, employees and hourly rates and push hours in; nothing reads payslips or totals. BrightPay posts payroll journals into Xero, QuickBooks, Sage and others, and exports reports to CSV/Excel. | **File**: payroll summary CSV. If the owner posts BrightPay journals to Xero, the Xero connection already sees payroll costs. |
| **Square** | Public OAuth API (Payments, Orders). | **Live**: completed payments per day. Tax is on Orders, so it shows 0 for now (flagged). |
| **Stripe** | Public API, restricted keys. | **Live**: balance transactions with a read-only restricted key. |
| **Google Analytics 4**, **Google Search Console** | Public OAuth 2.0 APIs (Analytics Data and Admin, Search Console). One Google app serves both and every client. | **Live**, read-only, never posted to the books. See `docs/GROWTH-ANALYTICS.md`. |
| SumUp, Zettle, Epos Now, Clover | Public APIs (OAuth, or key and secret for Epos Now). | Listed; sales CSV upload works today. Direct connectors next. |
| Lightspeed, Toast | APIs for approved partners only. | Listed honestly; CSV upload works today. |
| QuickBooks Online, Sage Accounting, FreeAgent, Zoho Books, MYOB, FreshBooks | Public OAuth APIs. | Listed; Zapier/Make link today. QuickBooks is next after Xero. |
| PayPal, Shopify, WooCommerce, GoCardless | Public APIs. | Listed; Zapier/Make link today. |
| Gusto | Partner-only API. Staffology and Deel have public APIs. | Listed; Zapier/Make link today. |
| Anything else | Most apps have a Zapier or Make trigger. | Private webhook link. |

Not done yet, deliberately: email ingest (needs an inbound mail provider; the receipts inbox design covers it), bank feeds (need a regulated open-banking provider such as TrueLayer or Plaid), MCP servers as a connector type (the connector interface fits; add when a vendor ships a stable one), writing back into any app.

## Known limits

- Square and Stripe days are UTC days.
- Organisations default to USD as base currency unless onboarding sets one; records in another currency are kept but not posted (the owner sees why).
- Square tokens last 30 days; refresh is not wired for Square yet, so the card asks the owner to reconnect when Square refuses.

## Contract tests and what still needs real keys

`test/contracts.test.ts` checks, with no network, the exact URL, headers and body we send to Resend, Claude, RunPod, Slack (install link, code exchange, event signature) and Square, how we read each reply, and that each adapter only talks to its own vendor's host. Xero and Stripe request shapes are checked in `test/integrations.test.ts`. These tests catch accidental changes. They cannot show that a vendor still behaves as recorded, so each of these needs one real call once its key exists:

| Service | Key or setting | First real check |
| --- | --- | --- |
| Resend | `RESEND_API_KEY`, `EMAIL_FROM` on a verified domain | sign-in email arrives, not in spam |
| Claude | `ANTHROPIC_API_KEY` | a reply comes back and the spend page shows its cost |
| RunPod | `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID` | `/owner-ai.html` health check shows a worker, then a batch run finishes |
| Slack | the four `SLACK_*` settings | install from the website, send a message, get a reply |
| Xero | `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | connect a demo company, sync a month |
| Square | `SQUARE_CLIENT_ID`, `SQUARE_CLIENT_SECRET` | connect a sandbox seller, sync payments |
| Payments | a real provider class (not written) plus its keys and webhook secret | a test-mode checkout is paid, the webhook hires the employee once |

### Adding Stripe later

Write `StripePaymentProvider implements PaymentProvider` (`src/modules/payments/types.ts`): `createCheckout` makes a Checkout Session in `subscription` mode for the monthly lines (and a one-time line for the first-day extras) with `client_reference_id` set to the order id; `parseWebhook` verifies the `Stripe-Signature` header against the raw body with the endpoint secret and maps `checkout.session.completed`, `invoice.payment_failed` and `customer.subscription.deleted` to `ProviderEvent`; `cancelSubscription` cancels at period end. Pass it to `createPlatform({ payments })` from `main.ts` and allow its name in `checkEnv`. Nothing else changes.


## Services that were listed but not connectable (2026-11-17)

This is the state of every service that used to read "needs approval", "not built yet" or "stock library", plus Salesforce.
"Connects now" means a client can connect as soon as the owner has pasted the app's details. "Ready, needs provider approval" means every part is built and fake-server tested, and the provider must approve MAIZ's app before clients other than the owner (and the provider's listed testers) can connect. Nothing here has been run against a real provider: each needs one real connection by the owner.

How it works: the owner pastes the app's Client ID and secret (and the few extra boxes shown on the card) on the Connections page, or sets `<PREFIX>_CLIENT_ID`, `<PREFIX>_CLIENT_SECRET` and `<PREFIX>_<BOX>` on the server (names in `.env.example`). A client presses Connect on the Apps page. Where the provider supports it the sign-in carries a PKCE proof, derived from the server secret and the browser's one-time value so it is never stored. When a provider refuses, the owner or client sees the provider's own short error code and what to check.

| Service | State | Owner must do | Employees get | Documentation verified against |
| --- | --- | --- | --- | --- |
| Salesforce | Connects now (fixed, see below) | Make an External Client App with PKCE on, Callback URL from the card; package or install it in client orgs | Leads, deals won and lost, open pipeline | help.salesforce.com `remoteaccess_oauth_web_server_flow`; developer.salesforce.com `secure-code-ac-eca` |
| Google Business Profile | Ready, needs provider approval | Google's Business Profile API access request form, then enable three APIs | New Google reviews, average rating | developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list (account and location listing from memory) |
| Google Ads | Ready, needs provider approval | Developer token (Basic access) from a manager account, pasted in its own box | Daily spend, impressions, clicks, results | developers.google.com/google-ads/api/rest/common/search and `/rest/auth` |
| Meta Ads | Ready, needs provider approval | App Review: Advanced Access to `ads_read` | Daily spend, clicks, leads and purchases | developers.facebook.com/docs/marketing-api/insights (the long-token trade is from memory) |
| LinkedIn Pages | Ready, needs provider approval | Community Management API product request with demo video | Follower count and daily gains | learn.microsoft.com LinkedIn authorization-code-flow, follower-statistics, organization-access-control-by-role, organization-lookup-api |
| TikTok | Ready, needs provider approval | Login Kit review with demo video | Followers and video count | developers.tiktok.com `oauth-user-access-token-management` and `tiktok-api-v2-get-user-info` (the authorize address is from memory) |
| Pinterest | Ready, needs provider approval | Trial, then Standard access with a screen recording | Followers and Pin count | developers.pinterest.com set-up-authentication-and-authorization (the account figures are from memory) |
| Amazon Seller Central | Ready, needs provider approval | Developer profile, app, Application ID, region box | Daily order totals as sales | developer-docs.amazon website-authorization-workflow, getordermetrics, getmarketplaceparticipations (response shapes from memory) |
| Etsy | Ready, needs provider approval | Commercial access for the app; key goes in Client ID, shared secret in Client secret | Daily order totals as sales | developers.etsy.com essentials/authentication (order list and shop lookup from memory) |
| eBay | Ready, needs provider approval | Production keyset and RuName | Daily order totals as sales | developer.ebay.com oauth-auth-code-grant-request (the consent address and order list from memory) |
| DocuSign | Ready, needs provider approval | Go-Live review after sandbox calls | Documents sent, signed, waiting (counts only) | developers.docusign.com authcode-get-token and the envelopes list page |
| Canva | Ready, needs provider approval | Public integration review (Canva's rules not confirmed) | How many designs, how many changed | canva.dev authentication and list-designs pages |
| Trustpilot | Connects now (client pastes a key, no approval) | Nothing | New reviews, TrustScore | developers.trustpilot.com business-units pages (the review list was read from its page; the find response field `id` from memory) |
| Indeed | Cannot be connected | Nothing | Nothing: forward application emails through Zapier or Make | docs.indeed.com partner list (secondary summary at 100hires.com, not Indeed's own page) |
| VEED | Not built | Nothing | Nothing: its API does subtitles, dubbing, avatars, background removal, not templates | api.veed.io/docs |
| Adobe Express, Kapwing, InVideo | Cannot be connected (no public way in found; not re-verified in this session) | Nothing | Brief prepared by the team, finished in the tool | Not verified here |
| Envato Elements, Motion Array | Stock library, used by hand | Nothing | Ideas and links only | Not verified here |

### Salesforce: what was wrong

The connect step sent no PKCE proof, and the guide told the owner to make a Connected App. Since Salesforce's Spring '26 release new Connected Apps cannot be created without Salesforce Support, and an External Client App has PKCE required by default, so Salesforce would answer the sign-in with a "missing required code challenge" style refusal that the page showed only as "The app did not approve the connection". Now the sign-in sends PKCE (S256), the token call sends the verifier, the guide describes the External Client App, and the test button says exactly what Salesforce answered (`invalid_client_id`, `invalid_client`, `redirect_uri_mismatch`, `invalid_grant`, `unsupported_grant_type`). Other likely causes, in order: the app is under ten minutes old; the Callback URL differs from the one on the card; Authorization Code and Credentials Flow is off; the app only exists in the owner's org (Distribution State Local), so users in other orgs get OAUTH_APPROVAL_ERROR_GENERIC and need the app installed or the Approve Uninstalled Connected Apps permission.

### Tiers

Cards carry the shared `tier` field. Must: HubSpot, Salesforce, QuickBooks, Outlook, Gmail, Google Business Profile, Meta Ads, Google Ads. Optional: everything else here.
