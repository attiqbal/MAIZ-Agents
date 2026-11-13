# Coupons and affiliates

Added 2026-11-12. Code: `src/modules/promotions` (`rules.ts` pure rules, `coupons.ts`, `affiliates.ts`). Pages: `web/owner-promotions.html` (platform owner), `web/affiliate.html` (affiliate), a code field on `web/onboarding.html` and a "Gift or discount code" panel in Settings (`web/app.html`).

## Coupons

The owner makes a code that gives one of:

| Kind | What happens | Wired today? |
|---|---|---|
| `trial_days` | Adds days to the end of the free trial (`EnergyMeter.extendTrial`, up to 90). Trial energy stays the same. | Yes |
| `energy_credit` | Adds energy once (`EnergyMeter.grantEnergy`): raises the trial pool, or on a paid plan is added as a roll-over top-up. | Yes |
| `percent_off`, `fixed_off`, `free_months` | Saved on the client as a `Redemption.discount` `{type, value, months \| null}`. | **Recorded only.** Checkout does not read it yet. |

Billing discounts last once, for N months or for ever (`Duration`). A client may hold one billing discount at a time. When checkout starts charging, call `applyDiscount(redemption.discount, monthlyGbp, monthIndex)` from `rules.ts` (month 0 is the first bill after the code was used) and read the active one with `CouponService.activeDiscount(workspaceId)`.

Limits on a coupon: most uses in total, an expiry date, only trial or only paying clients, only one email. Owner can turn a code on or off, see every use, and email a code to someone (branded email). Codes are normalised to upper case; a client may type them in any case.

Clients use a code at signup (`coupon` in `POST /api/signup`; a bad code never blocks signup, the answer comes back as `coupon: {ok, message}`), on `POST /api/coupons/check` (what it would give, changes nothing) and `POST /api/coupons/redeem` (Settings, needs `workspace.manage`). Each refusal has a plain-words message (unknown, turned off, expired on a date, used up, wrong email, wrong plan, already used, a discount already active). An email restriction is never named.

## Affiliates

The owner adds an affiliate (name, email, optional code, commission, hold days). They get a branded email with their link `/r/<code>` and log in with that email to see `/affiliate.html`.

- **Tracking:** `GET /r/<code>` counts one click per browser and sets a 30-day cookie (`maiz_ref`, `__Host-` prefixed over https, HttpOnly). `POST /api/signup` reads the cookie and records a referral.
- **Commission:** `AffiliateService.recordPayment(workspaceId, paidGbp, paymentRef)` is called when an order is fulfilled. It earns the first N payments of a referred client, once per payment reference, so a replayed webhook never pays twice. Renewals will call the same method.
- **Payouts:** nothing is paid automatically. A commission can be paid after its hold period (default 30 days, to cover refunds). The owner pays by hand and presses Mark as paid, which settles everything ready, stores the reference and emails the affiliate.
- **Privacy:** the affiliate sees counts and money, never the referred clients' names.

## Abuse protection

- Self-referral: the signup email and the affiliate email are compared after removing Gmail dots, `+tags` and `googlemail` (`canonicalEmail`). A match is not credited.
- A client can be referred once. A paused affiliate's link stops counting and attributing.
- Code guessing: 12 tries per address per 10 minutes on the check and redeem routes (`limitFor`), and 8 wrong codes per person per 15 minutes (`codeFails`), then HTTP 429.
- Referral visits are limited to 20 a minute per address and path.
- Not covered: the same person making a second account with a different address (no card yet to match on); a client who cancels after the hold period (no clawback; raise the hold period if refunds become a problem).

## Storage

`Sink.promo(kind, id, data)` writes `platform_records` rows with kind `promo_coupon`, `promo_redemption`, `promo_affiliate`, `promo_referral`, `promo_accrual`, `promo_payout`. They belong to no client and the restricted app user cannot read them. No migration is needed.

## Decisions for the platform owner

Defaults are in place (`DEFAULT_COMMISSION`, `DEFAULT_HOLD_DAYS` in `rules.ts`):

1. Default commission: 20% of each payment for the first 12 payments, held 30 days.
2. Payout method and minimum payout: manual, any method; no minimum is enforced.
3. Written affiliate terms: none written. The affiliate email says terms are sent separately and no terms are shown on any page.
4. Whether affiliate-referred clients should also get a perk (not built).
5. When billing arrives: whether a billing discount stacks with a trial, and whether commission is paid on the discounted amount (it is paid on what the client actually paid).
