# New outside services

What was added, what each costs, how to switch each on, and what was left out. Nothing here has been tried against a real provider account: every test runs against a fake server that answers in the shape the provider's own pages describe. Provider pages were read on 2026-11-17 unless a line says otherwise.

## What was built

| Service | What it does | Cost class | Prefer a cheaper way when |
|---|---|---|---|
| ElevenLabs (voice-over) | Turns a script into a spoken recording, kept as a file | Paid per use, double energy | A written script or an existing recording will do |
| Brave Search | Looks a question up on the live web, every result with its address | Paid per use, double energy | The answer is already in the business's own data or the Data desk |
| Page reader | Reads one public web page as plain words | Flat energy, nothing paid to anyone | Search already gave the facts needed |
| Pexels and Unsplash | Finds free photos and clips, kept with a credit line | Free | The business has its own photos |
| Shopify (one click) | Orders, tax, tips and refunds day by day, read only | Free | The shop already uses the paste-a-key Shopify card |
| FreeAgent | Income, expenses and profit month by month, read only | Free | The books are already in Xero or QuickBooks |

The cost class and the "prefer a cheaper way" advice live in `src/modules/toolbox/catalogue.ts` and reach the resource guide through `ResourceSources.tools` (keys `service:<key>`). That field is new and optional; nothing else in the guide changed.

### How a client uses the toolbox

`/api/tools` (signed in, workspace members only):

- `GET /api/tools` lists the tools, which are switched on, what each costs, and the kept files.
- `POST /api/tools/voice/quote` then `POST /api/tools/voice` makes a recording. The quote is shown first and the client sends the exact energy back to confirm. If the price moved, nothing runs and the new quote is returned.
- `POST /api/tools/search` and `POST /api/tools/read` follow the same quote, confirm, hold, settle or release path as the paid video services. The daily guard of 25 paid uses per payer applies.
- `POST /api/tools/stock` searches Pexels or Unsplash. `POST /api/tools/stock/keep` keeps a picture with its credit line. Nothing is posted or sent anywhere.
- Kept recordings and pictures are listed in the team's context with their credit lines.

Pages read go through the same guarded reader as onboarding (`publicPage` in `src/modules/onboarding/site-reader.ts`), which refuses addresses inside our network.

### How the owner switches it on

Connections page, four cards under the platform group, all optional: Voice-overs (ElevenLabs), Web search (Brave Search), Free pictures and video (Pexels), Free pictures (Unsplash). Paste the key, Save, Test connection. Keys are stored encrypted. The server environment variables `ELEVENLABS_API_KEY`, `BRAVE_SEARCH_API_KEY`, `PEXELS_API_KEY` and `UNSPLASH_ACCESS_KEY` also work, but typing them in the browser is the normal way.

Tests: ElevenLabs lists voices (free). Brave runs one search (one of the month's free credit). Pexels and Unsplash run one search each.

## Licence and price facts, and what they changed

- **ElevenLabs**: commercial use is only allowed on a paid plan, so the card says to pick one. Only ready-made voices are offered; nobody's voice is copied. Reselling recordings to clients may fall under ElevenLabs's separate OEM terms. That was not confirmed: ask ElevenLabs before selling this to clients. The exact header the voices list expects was not confirmed against a live call either.
- **Brave Search**: the terms allow showing results in your own app but not storing or caching them, and not training on them. So results are shown and never stored. A plan meant for AI training must not be chosen. The plan is five US dollars for 1,000 searches with five dollars of free credit a month.
- **Tavily and Serper** were looked at for search. Tavily's terms limit use to the customer's own internal business purposes, which does not fit showing results to clients. Serper's terms were not checked.
- **Pexels**: asks for a link back to Pexels and credit to the photographer. The credit line is kept with each picture. It does not allow an app that simply re-offers its library, so MAIZ searches and links. Default allowance is 200 searches an hour and 20,000 a month for every client together.
- **Unsplash**: needs the picture shown from Unsplash's own address, the credit line, and a download ping when a picture is used. A new application is in demo mode (50 searches an hour in total) until Unsplash approves it for production.
- **Shopify**: expiring offline tokens (the access token is short, the refresh token rotates and lasts about 90 days if used). Callbacks must be checked with Shopify's HMAC, and are. The API version is 2026-10. Reading orders older than 60 days needs Shopify's extra approval (read_all_orders), which is not asked for.
- **FreeAgent**: authorize at `/v2/approve_app`, tokens at `/v2/token_endpoint` with Basic auth, an access token lasts one hour, the refresh answer carries a new refresh token (which MAIZ keeps). FreeAgent's page names no review before other businesses can connect. The profit and loss summary has no cost of sales line, so costs show under expenses.

## Shopify (one click)

Added beside the existing paste-a-key Shopify card, which keeps working. The new connector is `shopify-app` (`src/modules/integrations/connectors/shopify-app.ts`).

- The client types a shop address on the Apps page. It must be exactly `name.myshopify.com` (checked when typed, when they return, and before every call, so no key can reach another host). A bare shop name is accepted and completed.
- Only `read_orders` is asked for. The comeback is refused unless Shopify's HMAC over the whole query checks out with our secret and the shop in it matches the shop typed. The connection is refused if Shopify did not grant `read_orders`.
- Tokens are the expiring kind. The rotating refresh token replaces the old one each time.
- Reads orders through GraphQL, skipping cancelled, voided, pending and authorised-only orders, into the same sales-per-day records as a till.
- Two small generic additions were needed: `Connector.connectFields` (boxes typed before the sign-in, kept in the signed state) and a fourth `values` argument on `authorizeUrl`. The Apps page opens its small key dialog for such an app, then sends the client to Shopify.

Owner steps: create an app in the Shopify Dev Dashboard, add the Redirect URI shown on the Connections card, give it only `read_orders`, paste the Client ID and secret on the card (environment names `SHOPIFY_APP_CLIENT_ID` and `SHOPIFY_APP_CLIENT_SECRET`), Save, Test connection. A listing in the Shopify App Store goes through Shopify's review; how long it takes was not checked. Until then, only shops the owner installs the app on can connect.

Not built: product and stock reads. They need the extra `read_products` permission, so they were left out of the first version.

## FreeAgent

Connector `freeagent` (`src/modules/integrations/connectors/freeagent.ts`), replacing the earlier "planned" placeholder. Same shape as Xero and QuickBooks. Owner steps: create an app in the FreeAgent Developer Dashboard, add the Redirect URI, paste the identifier and secret on the card (`FREEAGENT_CLIENT_ID`, `FREEAGENT_CLIENT_SECRET`), Save, Test connection.

## Left out, and why

- **Read-only bank feed.** Not built, and not faked. GoCardless Bank Account Data appears to have closed to new sign-ups (from a third-party article, not confirmed on GoCardless's own page). TrueLayer and similar need MAIZ to be a regulated account information provider, or to operate under a regulated firm's permissions as its agent. What is needed: either an FCA authorisation (or registration as an agent of an authorised firm) or a signed contract with a provider that already holds one, plus a privacy and consent flow for clients. Until then, clients can upload a bank statement file or use Xero, QuickBooks or FreeAgent, which already bring in bank-based books.
- **Sage Accounting.** Left as planned: no profit and loss endpoint was confirmed.
- **Calendar.** Needs new Google scopes, which must go through Google's verification first. No new Google scopes were added by this work.
- **Twilio.** Already exists in `connectors/more-work.ts`.
- **Employees calling the tools by themselves.** The task runner has no tool loop. The resource guide tells employees the tools exist and clients or the API start them. Making employees call tools on their own is a separate change.
- **A web screen for the toolbox.** There are routes and owner cards but no client screen yet. Pexels and Unsplash need one to show the link back, the credit line and the Unsplash download ping properly.
- **Canva, Adobe Express, LinkedIn, TikTok, Google Ads, Meta Ads, Amazon, Etsy, eBay, DocuSign, Indeed, Pinterest, Trustpilot, Google Business Profile, Salesforce**: owned by other work, untouched.

## Before going live

1. Open each card on the Connections page and paste the key. Use Test connection.
2. Ask ElevenLabs about reselling (OEM terms) before selling voice-overs to clients.
3. Apply to Unsplash for production access once pictures are shown from Unsplash's own address with credits.
4. Register the Shopify and FreeAgent apps, add the Redirect URI, and try one real shop and one real FreeAgent account. No real account has been tried yet.
