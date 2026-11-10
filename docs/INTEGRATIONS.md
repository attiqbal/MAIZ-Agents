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
| POST | `/api/integrations/post` | member: add pending records to the books |
| GET | `/api/integrations/callback` | public, signed state: OAuth return |
| POST | `/api/integrations/hooks/:id/:secret` | public, secret link: `{ sales | payroll | accounts: [...], amountsIn?: "major" }` |

## What each app actually offers (checked November 2026)

| App | What exists | What we do |
|---|---|---|
| **Xero** | Public OAuth 2.0 API. Apps created after 2 March 2026 must use granular scopes (`accounting.reports.profitandloss.read`). 30-minute access tokens with rotating refresh tokens. Xero now charges developers by number of connected organisations. | **Live**: monthly Profit and Loss, read only. |
| **BrightPay** | Cloud Payroll API is OAuth but UK only, in development, and open only to timesheet providers who apply by email. Its methods read employers, employees and hourly rates and push hours in; nothing reads payslips or totals. BrightPay posts payroll journals into Xero, QuickBooks, Sage and others, and exports reports to CSV/Excel. | **File**: payroll summary CSV. If the owner posts BrightPay journals to Xero, the Xero connection already sees payroll costs. |
| **Square** | Public OAuth API (Payments, Orders). | **Live**: completed payments per day. Tax is on Orders, so it shows 0 for now (flagged). |
| **Stripe** | Public API, restricted keys. | **Live**: balance transactions with a read-only restricted key. |
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
