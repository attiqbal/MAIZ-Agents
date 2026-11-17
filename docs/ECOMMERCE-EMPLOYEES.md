# Online-seller employees

Four add-on employees for people who sell goods online. Each is hired from the store at the same add-on price as the other add-on employees (the Supply chain manager, the Data mining agent): **£25 a month**, and **2000 energy a week** (`addOnWeeklyEnergy`). The six core employees are unchanged.

| Template key | Name | One job |
|---|---|---|
| `online-shop-manager` | E-commerce manager | Runs the whole shop day to day: product pages, prices, stock watch, returns, promotions and the weekly numbers |
| `dropshipping-agent` | Dropshipping agent | Finds products, checks a supplier's real handling and shipping times, works out the true margin, watches supplier orders and stock |
| `marketplace-manager` | Marketplace manager | Listings, fees and rules for Etsy, Amazon and eBay |
| `shop-care-agent` | Shop customer care agent | Where is my order, returns, refunds and complaint replies, written as drafts |

The key `online-shop-manager` is deliberate: `ecommerce-manager` is already a legacy specialist key.

## How they differ from the employees a client already has

- **Customer service** specialists (the customer support agent, receptionist and similar ready-made roles) answer any business's customers in general. The Shop customer care agent works only from orders, tracking, returns and refund rules for goods, and knows the 14-day cancellation right, carrier and supplier delays and when a refund is owed. It sits at the top of the Customer department's roles.
- **Marketing manager** plans campaigns, copy and the calendar for any business. The E-commerce manager owns the shop's numbers and listings (price, margin, stock, returns, promotions) and sends campaign ideas to the Marketing manager rather than doing the writing itself. The Marketplace manager is specific to marketplace rules and fees.
- **Supply chain manager** (existing add-on) plans stock and suppliers for a business that holds stock. The Dropshipping agent is for the seller who holds none: the supplier ships to the shopper.

## What each reads and does

All four read only what the client connected, and what the client typed. They do not read shoppers' names or addresses.

- **E-commerce manager.** Reads shop figures (Shopify, WooCommerce, BigCommerce, Squarespace: takings, tax, refunds, order counts), website and Google search figures, email list and review figures, support counts, and market data the client shared from the Data mining agent. Produces listing drafts, price and margin checks, a stock watch from the client's own numbers, a promotion plan and the weekly summary.
- **Dropshipping agent.** Reads Printful and Printify counts (see below), shop figures and shared market data. Produces supplier comparisons, a landed-cost and margin sheet, honest delivery ranges, and a check of a product idea against the supplier's own page.
- **Marketplace manager.** Works from what the owner tells it plus shop figures. Produces listing drafts, a fee sheet per marketplace and a rules check. Marketplace order figures are planned: each marketplace has to approve MAIZ first.
- **Shop customer care agent.** Reads support counts and refund totals, and the order text, tracking text and messages the owner pastes in. Produces reply drafts. It never contacts a shopper itself.

What is "planned" and not built: reading a single order or stock level from a shop, publishing an approved listing or price change, placing a supplier order, sending a reply, issuing a refund. The job descriptions say so, so nobody is promised it.

## Rules every one of them follows

The single source is `src/modules/ecommerce/rules.ts` (`SHOP_RULES`). The same text is appended to each employee's instructions ("The rules you always follow:") and listed in each job description, and a test checks all four carry every rule.

1. Nothing is listed, published, ordered, repriced, emailed, texted or refunded without the owner's approval. Drafts only.
2. No fake reviews, testimonials or star ratings, and no reviews in return for gifts or discounts.
3. No fake countdowns, "only 3 left", "selling fast" or "people are viewing this". A stock or time claim is used only when the shop's own connected data shows it is true now, and the source is named.
4. No invented stock, prices, sales, supplier facts or delivery times.
5. A realistic delivery time for dropshipped goods: the supplier's handling time plus shipping to the shopper's country, as a range.
6. No claim (health, safety, eco, approvals) beyond the supplier's page, the maker's documents or the owner's papers.
7. UK basics built in: the 14-day cancellation right with its exceptions, the total price including delivery and VAT where the seller is registered, clear seller details, no hidden fee.
8. Product safety and labelling apply. No help selling restricted or age-limited goods or counterfeit goods, and the owner is sent to the Compliance manager.
9. Rules differ by country: say so, tell the owner to check each country they sell to, point to the Compliance manager. No legal advice.
10. Shoppers' personal details are used only for the job in hand.

This is not legal advice and is not a substitute for the client checking the rules where they sell.

### The copy check

Instructions alone cannot guarantee a model's output, so `checkShopCopy` / `shopCopyNote` look at a finished draft. When a shop employee's deliverable contains false urgency, invented social proof or reviews, a claim such as "clinically proven", or "no returns", a note starting "Check before you use this" is added under the draft, naming each problem once and pointing at the Compliance manager. The draft itself is not changed or blocked, because the same words can appear inside a warning. It is a pattern check, not a guarantee, and it is tested with a spy gateway in `test/ecommerce-employees.test.ts` and on the patterns in `test/ecommerce-rules.test.ts`.

## One per business

These four are hired once. The cart forces quantity 1 (`ONE_PER_BUSINESS` in `src/modules/store/cart.ts`), `quoteForPlan` drops one the team already has with the reason "you already have this employee", and `fulfil` in `src/server/platform.ts` hires at most one and skips one already on the team. The store hides the quantity box for them and says so politely when one is left out of the cart.

## Supplier connectors

Added in `src/modules/integrations/connectors/dropship-suppliers.ts` and declared through the registry only (`DROPSHIP_SUPPLIERS` in `catalogue.ts`). Shopify and the other shop connectors are untouched. Each client pastes their own token on the Apps page, so **the owner sets up nothing** for these.

| Supplier | Status | Interface | Read |
|---|---|---|---|
| Printful | live | Bearer private token. `GET /orders` (status filter, `paging.total`) and `GET /store/products`. Docs: developers.printful.com/docs | Open orders (pending, in process, partial), failed and on-hold orders in the last 30 days, fulfilled orders by day, products out of stock or discontinued |
| Printify | live | Bearer personal access token, `User-Agent` set. `GET /shops.json`, orders and products per shop. Docs: developers.printify.com and its openapi.json | Open, problem and fulfilled orders in the last 30 days, products with an enabled but unavailable variant. Up to 5 shops, 6 pages of 50 |
| CJ Dropshipping | planned, Zapier or Make for now | API key swapped for an access token (developers.cjdropshipping.com). Only the sign-in page could be read | None yet |

Left out: Spocket, Zendrop and AliExpress Dropshipping. No public developer page that could be read and confirmed was found, so nothing is listed for them.

Only counts are read, stored as the `supply` activity area (capability `suppliers.read`), and visible to the Dropshipping agent, the E-commerce manager and the Business consultant. Shoppers' names and addresses sit inside supplier orders and are never read or kept. The Printify token is long, so api-key fields can now set their own `maxLength` (the default stays 500). The old Printful placeholder row in `business-apps.ts` was removed to avoid a duplicate key.

Etsy, Amazon Seller and eBay are listed in onboarding as "connect through Zapier or Make" (bridge). Each marketplace has its own approval process for third-party apps, which MAIZ has not started.

## Where a client meets them

- Store and `employees.html` (section "For online sellers"), with the price filled from the store price list.
- Onboarding: new needs "Run my online shop", "Find products to sell", "Sell on marketplaces" and "Look after shop customers"; new sectors "Dropshipping" and "Marketplace seller" (the online store sector now leads with the shop manager). They are offered as add-ons and never added silently.
- Team page, Overview table, Apps access chips, conversation screen. They have no example dashboard: `#desk/<key>` for these four opens their conversation (`#chat/<key>`), as the Data mining agent's desk opens its own screen.
- The ask bar and connected chat apps recognise "shop:", "dropship:", "marketplace:" and "care:" prefixes.
- The admin setup form has optional fields (shop platform, delivery terms, marketplaces, supplier countries, returns policy).
- Avatars are four original paper-cut characters in `web/src/styles.css`.

## Counts that changed

Employee templates: four more employee-kind templates (store catalogue, `test/workforce.test.ts`). Onboarding sectors: 13 to 15 including "Other" (industry pages are generated from it). Job descriptions and generated skill files: four more each.

## Not tested against real services

Everything external. The Printful and Printify connectors are tested against fake local servers built from the documented response shapes, not against a real account. Nothing was run against Etsy, Amazon or eBay. The model's behaviour (that it follows the rules) is not proven by any test; only the instruction text, the job descriptions and the copy check on finished drafts are.
