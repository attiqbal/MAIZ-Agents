# Growth analytics and market research

Two read-only abilities, both set up by keys typed on the owner's Connections page (`/owner-connections.html`), never in chat, git or a server login.

## 1. Clients' website growth (Marketing manager upgrade)

A client connects **Google Analytics** and/or **Google Search Console** from their Apps screen. Their Marketing manager (and the Business consultant) then see the figures, and the client gets:

- **A weekly growth report** (a notification, Monday or Tuesday from 7am in the client's own time zone, or straight away the first time): visits, visitors, goals, revenue if any, where visits came from, Google clicks, appearances, average position and the top searches, each against the week before.
- **Drop and spike alerts**, sent once each: the last 3 days against the 28 before, only for a fall of 40% or more (or a rise of 60% or more) that is also well outside the site's usual ups and downs, and never for a tiny site. Two days in a row of zero visits raises "your tracking may have stopped".
- A **Your growth this week** panel on the Apps screen.

All of it is plain arithmetic on Google's figures (`src/modules/integrations/insights.ts`). Nothing is charged to the client's energy and no AI is called to produce it. The Marketing manager's chat answers are given the same figures, labelled as from the owner's own analytics.

Code: `connectors/google.ts` (OAuth), `ga4.ts`, `search-console.ts`, `insights.ts`, `IntegrationService.growth/growthTick/choices/choose`. Tests: `test/google-connectors.test.ts`, `test/insights.test.ts`. Figures are `reference` records: read for context, never posted to the books.

### One-time setup for the owner (Connections page, card "Google Analytics and Search Console")

1. In Google Cloud, enable the **Analytics Data API**, **Analytics Admin API** and **Search Console API**.
2. Add the two read-only scopes `analytics.readonly` and `webmasters.readonly`, create a **Web application** client, and add `<APP_URL>/api/integrations/callback` as its redirect URI.
3. Paste the Client ID and secret on the card, Save, Test connection.
4. **Verification:** these two scopes are "sensitive" (confirm on the console's Data access page). Until Google has verified the app, only people you list as test users (up to 100) can connect, their permission stops after 7 days, and an unverified app is capped at 100 new users for the life of the project. To open it to every client, publish the app and complete Google's verification: a justification per scope, a demo video, and a privacy policy that names the Google data and carries the Limited Use statement (`web/privacy.html#google`). Sensitive scopes take up to about 10 business days (Google's figure, not guaranteed). Gmail's `gmail.metadata` is a *restricted* scope and also needs a yearly third-party security assessment, so it has its own client and is kept out of this submission.

**Disconnect deletes.** Pressing Disconnect on a Google app deletes the saved token and every figure that connection sent (memory and database), and revokes Google's permission once the client has no other Google connection through the same app. Google's User Data Policy asks for this; do not remove it.

If the Google login can read several sites, the client picks one; we re-check the choice against Google's own list before saving it.

Google's figures lag: Analytics up to yesterday, Search Console about three days. The report says so.

## 2. Market research (owner only: Reddit, Hacker News, YouTube, X)

On `/owner-growth.html`, **Find conversations** searches public posts, read-only:

| Source | How | Key |
|---|---|---|
| Reddit | Official API, app-only token (`client_credentials`), a descriptive User-Agent | Reddit card: Client ID, secret, your username |
| Hacker News | Algolia's public search | none |
| YouTube | Data API v3, key sent in a header | YouTube card: API key |
| X (Twitter) | API v2 recent search (last 7 days only), bearer token in a header | X card: bearer token. X's plan with post search is paid (check current price; we have not verified it) |

Rules built in: nothing is ever posted, voted, commented or messaged. Results drop adult posts and off-site links, strip control characters and shorten text, and are shown as data (they are text from strangers; never feed them to a model as instructions). At most 20 searches per 10 minutes per owner (and 40 YouTube searches a day, because each costs about 100 of Google's 10,000 daily units), results cached for 10 minutes, and each source fails on its own with a plain-words reason. **Use as a place** and **Reply to this** prefill the existing community growth forms; drafts still need the owner's approval and are posted by hand (`docs/GROWTH.md`).

Code: `src/modules/research`. Tests: `test/research.test.ts`.

### The data desk (owner page, "Data desk")

| Look-up | Source | Key |
|---|---|---|
| News stories worldwide | GDELT open index | none |
| Country figures (GDP growth, inflation, population…) | World Bank | none |
| Economic series (unemployment, prices, interest rates) | FRED (US Federal Reserve) | free FRED key |
| Share and fund prices | Alpha Vantage | free key (about 25 look-ups a day, as far as we know) |
| UK companies | Companies House | free key |

Same rules as the forum search: read-only, shared rate limit and cache, text and numbers shown as data. Not built: paid terminals and market data (Bloomberg, Refinitiv), SEC filings, Google Trends (no official API), anything that needs scraping.

### LinkedIn: not possible to read

LinkedIn has no public API for searching or reading other people's posts, and scraping it breaks its terms, so there is deliberately no LinkedIn source. LinkedIn stays a place the community growth manager can draft for (you post by hand). Posting through LinkedIn's own Marketing/Community APIs would need LinkedIn's approval and is not built.

### Unverified / to know

- Tested only against fake servers. Real Reddit, Google and YouTube answers have not been seen.
- Reddit's Data API terms: as we understand them, commercial use needs Reddit's approval and free use is rate limited. Read their terms before using results for clients' businesses. We only read, and stay far below the limit.
- Not built: client-side market listening (a weekly Reddit digest per client), Meta Ads / Google Ads read-only, image generation, brand voice from the website.
