# Stripe billing

Payments are behind one flag. `PAYMENTS_PROVIDER` empty = checkout refused, nothing charged. `PAYMENTS_PROVIDER=stripe` turns on Stripe.

## What it does
- **Checkout** (`POST /api/checkout`): the cart is priced on the server, then a Stripe Checkout Session opens. Monthly lines (base package, extra employees, specialists) recur monthly in GBP; one-off consultant passes are charged on the first invoice. A cart of one-offs only is a plain payment with an invoice. Prices are sent inline, so no products need creating in Stripe.
- **Webhooks** (`POST /api/payments/webhook`): signature checked on the raw body, replays ignored. `checkout.session.completed` / `async_payment_succeeded` hire the team and move the client from trial to the paid plan (full weekly energy pool). `expired` / `async_payment_failed` fail the order. `customer.subscription.deleted` cancels it. `invoice.payment_failed` on a renewal, disputes, refunds and fraud warnings email the platform owners.
- **Customer portal** (`POST /api/billing/portal`): returns a Stripe-hosted page for card, invoices and cancelling.
- **Cancel** (`POST /api/orders/:id/cancel`): stops renewal at the end of the paid month.
- **Invoices**: subscriptions create invoices automatically; Stripe emails receipts if enabled in the dashboard.
- **Promotions**: buyers can type a Stripe promotion code at checkout. The provider also accepts an agreed discount (`CheckoutRequest.discount`) and makes a one-use Stripe coupon; wire the promotions module (PR #45, `applyDiscount`) to it once that merges.
- Terminal (card readers) is not used: this is an online service.

## The Team package and plan changes (added 2026-11-16)

- The **Team package** (`team-package` in the store catalogue, priced by "Basic package, per month" on the owner's Prices page, £150 at launch) is what a client buys to keep their team after the free trial. Before this it could not be bought at all: the only way to become a paying client was to add a £25 or £35 extra, which then started the whole paid plan.
- A client still on the trial who buys any monthly item gets the Team package added to that first order (`quoteForPlan`), shown in the cart and on Stripe's page before they pay. A consultant pass on its own needs no plan. A client already on a paid plan cannot buy the package twice; clients who went paid before this change keep their plan as it is.
- Cancelling the Team package order (from the client's billing page, or when Stripe ends the subscription) ends the plan: the team works to the end of the month paid for when the client cancelled in MAIZ, or stops at once when Stripe ended the subscription, then pauses exactly like an ended trial. Buying the package again restarts it (`EnergyMeter.endPaidPlan`).
- Two open checkouts never both hold the Team package: starting a new one closes the older unpaid one, the same way a discount code is released.
- Extras bought after the package: cancelling the package now stops every other monthly order of the client too, each at the end of its own paid month (`cancelSubscription` on each, or on the shared subscription once), and the notice names what was stopped. If Stripe cannot be reached for one of them it is retried every 15 minutes and the owner is emailed. See docs/ONE-BILL.md.
- Top-up energy a client bought is kept when a cancelled plan is started again.
- An extra whose monthly order ends (the client stopped it, the package was cancelled, or Stripe deleted the subscription) is removed from the team when its paid month is over, and its weekly energy goes with it (the pool is worked out from who is on the team). The six core employees are never removed. The work it did is kept and still labelled with its name.
- Discount codes come off the first monthly order (docs/PROMOTIONS.md).

## Settings (server secrets, never chat or git)
| Variable | Meaning |
|---|---|
| `PAYMENTS_PROVIDER=stripe` | the feature flag |
| `STRIPE_SECRET_KEY` | restricted key `rk_test_...` (or `sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` of the endpoint below |
| `STRIPE_PORTAL_CONFIGURATION` | `bpc_...` of MAIZ's own customer portal configuration. Set it if the Stripe account is shared with other sites; otherwise customers see the account's default portal |
| `STRIPE_AUTOMATIC_TAX=1` | only after a tax registration is active |
| `STRIPE_ALLOW_LIVE=1` | required for live keys; leave unset until go-live |
| `STRIPE_ALLOW_TEST_IN_PRODUCTION=1` | required to use test keys on the production server (anyone could then "pay" with a test card) |

Restricted key permissions: Checkout Sessions (write), Customers (write), Subscriptions (write), Coupons (write), Customer portal (write). For the one-bill switch (docs/ONE-BILL.md) also: Prices (write), Products (write), Invoices (write, to read the part-month invoice and void an unpaid one). Without them the switch can be turned on, every add attempt is refused by Stripe before money moves, and the client gets today's separate checkout.

## Test it locally
1. `stripe login` (or `stripe sandbox create`), set the three variables in `.env`.
2. `stripe listen --forward-to localhost:8787/api/payments/webhook` prints the `whsec_` to use.
3. Buy in the app with card `4242 4242 4242 4242`.

## Stripe Dashboard steps only the account owner can do
1. Activate the account with MAIZ AI Ltd details and bank account.
2. Add the webhook endpoint `https://maizagents.com/api/payments/webhook` with events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`, `invoice.voided`, `customer.subscription.pending_update_expired`, `charge.dispute.created`, `charge.refunded`, `radar.early_fraud_warning.created`.
3. Settings > Billing > Customer portal: save a configuration (cancellation, payment method, invoices).
4. Tax: add the UK VAT registration, then set `STRIPE_AUTOMATIC_TAX=1`. Decide whether £150 is VAT-inclusive; prices are currently sent as tax-exclusive-by-default in the account setting.
5. Business details on invoices (legal name, address, VAT number) under Settings > Invoice template.
