# Customer apps

Clients connect the apps they already use (CRM, support desk, bookings, online shop, accounting, email and task boards) on the **Apps** screen. Employees then see **counts and totals only**, never a customer's name, a ticket's subject or an email's text.

Code: `src/modules/integrations` (connectors), `src/modules/connections/client-apps.ts` (owner cards). Tests: `test/customer-apps.test.ts`.

> **Honest status.** Every connector below was written from the vendor's public API documentation and tested against a *fake server* that answers in the documented shape. **None has been run against the real service**, because that needs each vendor's account and keys. Expect small differences (a renamed field, a stricter permission) on first real use. The owner Connections page "Test connection" for OAuth apps also follows the standard OAuth error codes and has not been run live per provider.

## What exists

| Group | Direct (live) | Waiting for the provider's approval | Listed, Zapier or Make meanwhile |
|---|---|---|---|
| Accounting | QuickBooks Online (OAuth, profit and loss) | | Sage, FreeAgent, Zoho Books, MYOB, FreshBooks, open banking (TrueLayer / GoCardless) |
| Sales and customers | HubSpot (OAuth), Salesforce (OAuth), Pipedrive (key), Calendly (OAuth), Cal.com (key) | Google Business Profile, Trustpilot | Zoho CRM (separate sign-in address per country), Freshsales (needs a per-account view id) |
| Support | Zendesk (key), Freshdesk (key), Intercom (OAuth), Help Scout (OAuth) | | |
| Shops | Shopify (Dev Dashboard app), WooCommerce (REST key), BigCommerce (token), Squarespace (key) | Amazon Seller, Etsy, eBay | Wix, PayPal |
| Email and messaging | Outlook mail (OAuth, `Mail.ReadBasic`), Twilio texts (key), Mailchimp (key), Brevo (key), Constant Contact (OAuth) | Gmail: **built**; test users connect now, everyone after Google's verification | Klaviyo (needs its reporting API), Teams, Telegram, Discord (these three are **employee channels** like Slack, a separate build) |
| Marketing | (existing) Google Analytics, Search Console | LinkedIn Pages, TikTok, Google Ads, Meta Ads, Pinterest | Buffer, Canva, WordPress, Bing Webmaster, Semrush, Ahrefs |
| Teamwork | Trello (key), Asana (token), ClickUp (token) | DocuSign, Indeed | monday.com, Airtable |
| Documents | | | Google Drive/Docs/Sheets, OneDrive, Notion, Dropbox: these need a **knowledge-base feature** (a file picker and a document store), not a figures connector. Not built. |
| Anything else | Zapier / Make / n8n link (accepts `sales`, `payroll`, `accounts` and now `activity`) | | |

### The wider list (added 2026-11-15)

About 200 more apps a small business is likely to use are listed in `src/modules/integrations/business-apps.ts`: more CRMs and help desks, review sites, booking and reservation systems (salons, clinics, restaurants, gyms, events, short lets), trades and field-service tools, delivery platforms, payment providers and business bank accounts, accounting and expense tools, payroll, rotas and HR, more shop platforms, courses, stock and parcels, email marketing, forms, social tools, calls and meetings, task boards, spreadsheets, document signing and time tracking.

**None of these is built.** Each is shown on the Apps screen with one of two honest labels and a "Connect through Zapier or Make" button, which works today for any app that can send data to a web address:

- "Direct connection coming": the vendor documents a public API (from general knowledge of their developer pages, not tested).
- "API is partner-only": partner-only, paid, limited, or not confirmed. Its terms are read before anything is built.

The Apps screen now has a search box, because the list is long. Ask for the ones clients actually use and they are built next, one connector file each. Video template services (Creatomate, Shotstack and the rest) are a different kind of thing and live in `docs/PAID-SERVICES.md`.

Dropped as not feasible: reading LinkedIn profiles or posts (no public API, scraping breaks its terms), X post search for clients (paid, price unverified).

## How it works

- A **connector** (`connectors/*.ts`) is one object: key, honest availability, capabilities, auth (OAuth or API key fields) and a `read()` that maps the app's API into records. Register it in `catalogue.ts`; nothing else changes.
- Non-money data uses one record kind, **activity** (`areas.ts`): `{ date, area, figures }` with `area` one of `crm`, `support`, `inbox`, `bookings`, `audience`, `tasks`, `reviews`. A figure not listed for its area is dropped, so free text can never reach an employee's instructions.
- Activity is stored as a reference record (never posted to the books) and summarised in plain words into the instructions of the employees the owner allowed (`DEFAULT_ACCESS`: inbox counts reach the Business consultant only; the owner can change it per connection on the Apps screen).
- Credentials are stored encrypted like the other connectors, never returned to the browser, and a refusal from the app shows a plain message, not the key.
- **Owner cards** are generated from the registry (`client-apps.ts`): each OAuth app gets a Client ID and secret card with the redirect address and its steps; each approval app gets a card with the application steps and the usual wait. Keys typed in the browser (or `<PREFIX>_CLIENT_ID` and `<PREFIX>_CLIENT_SECRET` on the server) switch on the one-click Connect button for every client. Nobody needs SSH.

## Add a customer app

1. Add `connectors/<app>.ts` exporting a `Connector` with `capabilities: ["<area>.read"]` and a `read()` that returns `{ activity: DayBook(...).list() }` (see `connectors/support.ts`).
2. OAuth: set `auth.kind: "oauth2"`, an `envPrefix` and a `setup` block (console link, steps, approval wait). The owner card appears by itself. API key: give `auth.fields` and a `validate()` that rejects a wrong-shaped key.
3. Register it in `defaultRegistry()` and add a test with a fake server.

## Safety notes

- Hosts a client types are checked before any call: Shopify, Pipedrive, Zendesk, Freshdesk and Mailchimp only reach their own vendor domains; next-page links are followed only on the same host; redirects are refused so a key can only go where we chose.
- WooCommerce is the one app on the client's own website. The address must be https with a normal public name, and its name is resolved first: anything pointing at a private, loopback, link-local or metadata address is refused with a generic message. **Known limit:** the name is resolved again by the HTTP client, so a hostile DNS server could change its answer in between (rebinding). Also run the API server where private networks cannot be reached.
- Everything an app sends is checked once in `store()`: a real date, a three-letter currency, and for activity only the known numbers. Free text from an app never reaches the books or an employee's instructions.
- Shopify: apps created after 1 January 2026 use the Dev Dashboard and a client id and secret (the 24 hour token is fetched on each sync). Old `shpat_` tokens are not accepted by this connector.
- Pipedrive, Zendesk (first 1,000 recently updated tickets), Mailchimp and Asana count the connecting user's view; the card says so.
- Shopify API version is pinned in `connectors/shops.ts` (`2026-07`): Shopify retires versions after about a year.

## Owner to-do per approval app

Each approval card on the owner Connections page lists the steps and the usual wait. Nothing else is needed until the provider says yes; then tell the build thread and the connector is added the same way as the live ones.

## What an OAuth connection lets the agents do

Connecting an app gives **MAIZ's server** a read-only token for that one client's account. It does **not** hand the agents the service.

- The token is stored encrypted, per client, and only the server uses it. Agents never see it and cannot call the app.
- Scopes are the smallest read set we found for each app (for example `crm.objects.contacts.read`, `Mail.ReadBasic`, `gmail.metadata`). Nothing writes, sends, posts, deletes or spends.
- The server turns what it reads into counts and totals. Only those lines reach the instructions of the employees the client allowed on that connection (default access per kind is in `access.ts`; the client changes it with the chips on the Apps screen).
- The client can disconnect at any time; the stored token is deleted and, for Google, revoked.
- Sending an email, posting, updating a deal or booking would be a separate feature behind the sign-off gate; none exists here.
