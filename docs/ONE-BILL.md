# One bill per client

Written 2026-11-17. Nothing in the Stripe part has been run against real Stripe: it is built from the pinned API version's types (`stripe@23.1.0`, `2026-10-28.endive`) and Stripe's documentation, and tested against a fake client (`test/stripe-one-bill.test.ts`).

## Always on

1. **Stopping the Team package stops the extras.** When the package order is cancelled (by the client in MAIZ, or Stripe deletes the subscription, for example after the client cancels in Stripe's portal), every other monthly order of that client is stopped at the end of its own paid month (`cancelSubscription` on each). The client gets one notice naming what was stopped. Safe to repeat. If Stripe cannot be reached for an extra, the order stays marked "stop wanted", is retried every 15 minutes by `PaymentService.sweep`, and the owner is emailed once.
2. **An ended extra leaves the team.** When a monthly line's paid month is over (or Stripe deletes its subscription), `sweep` removes the employee it hired with `WorkforceService.remove` (the inverse of hire; the six core employees are refused). The weekly energy goes with it because the team pool is counted from who is on the team. The work it did is kept; `formerName` keeps its name for labels. The removal is stored (`employee_removed`) so it survives a restart. One notice per client per pass. Each line is released once (`stops[key].releasedAt`). `sweep` runs once a minute (`main.ts`) and whenever Plan and billing is opened.
3. **Plan and billing** lists every monthly line with its price and renewal or end date (`GET /api/billing/lines`) and lets the client stop one extra ("Stop at the end of the month", with a confirm step, `POST /api/billing/lines/stop`). It keeps working until the end of the paid month. Nothing is refunded.

## Behind the owner switch (default off)

Owner Prices page, "One monthly bill for each client". When on, a client who already pays the Team package (a paid plan order with a Stripe subscription, no discount running) who adds monthly extras and presses "Add to my monthly bill" after the cart has explained it, gets the lines added to the same Stripe subscription instead of a new Checkout.

Flow (`StripeBill.add`): check the subscription is this client's plan (metadata `orderId` and `workspaceId` match), active, not ending, charged to a saved card, no change already waiting, same currency; create one monthly price per line (idempotency key `addprice-<order>-<n>`); save the price ids on the order; `subscriptions.update` with `proration_behavior=always_invoice` and `payment_behavior=pending_if_incomplete` (key `addline-<order>`), expanding `latest_invoice`. The order is **paid only when the invoice is `paid` and charges for our new prices**. An open invoice sends the client to Stripe's own invoice page (3-D Secure, card trouble); the employee is added only when the signed `invoice.paid` event arrives and matches the order (subscription, invoice or price ids, workspace, currency, amount). `invoice.voided`, `customer.subscription.pending_update_expired`, or 25 hours without payment fail the order and nothing is added.

Safety rules:
- **Definite refusal before money moves** (Stripe invalid request, card, auth, permission, rate limit): the add-order is marked failed and the normal Checkout is opened, so the client can always buy.
- **No clear answer** (connection lost, Stripe fault): no second way to pay is opened. The order stays waiting, the owner is emailed, the client is told not to retry. A later `invoice.paid` completes it; otherwise it closes within a day.
- Only one change waits on a subscription: starting a new addition closes an older unpaid one (the older invoice is voided).
- An addition cancelled before it is paid never hires: a late payment emails the owner instead.
- The cart's part-month amount is shown only when Stripe's preview is made purely of prorations with no tax, discount or credit in it (`invoices.createPreview`); otherwise the cart says Stripe works the amount out and shows it on the invoice. The preview's proration date is kept on our side for 15 minutes and passed to the real update, so the charge matches what was shown.
- One-off items (consultant passes) keep today's checkout: they stay in the cart after the monthly lines are added.
- **Discount codes**: a client holding a waiting code, or whose code is still running on their bill, uses the normal checkout (the code is applied exactly as today, once). The cart says so.
- Stopping one line of a shared subscription deletes that subscription item with `proration_behavior=none` (nothing charged or refunded); the employee stays until the end of the paid month. The only line left on a subscription cancels the subscription instead. A line is matched by its price id (added lines) or by name, price and quantity (lines sold at Checkout); anything but exactly one match is refused and the owner is emailed.
- Clients who already have separate subscriptions are left as they are. Items 1 to 3 cover them.

## Owner to-do after deploy

1. In Stripe, add these events to the webhook: `invoice.paid`, `invoice.voided`, `customer.subscription.pending_update_expired` (the rest are already there).
2. Give the restricted key Prices (write), Products (write) and Invoices (write) as well.
3. Part A needs nothing else. To use part B: turn on the switch, then in **test mode** buy the Team package, then add one extra with the saved card, check Stripe shows one subscription with two items and one part-month invoice, and check the employee appears. Then stop that extra from Plan and billing and check the item is gone from the subscription. Also try the 3-D Secure test card (`4000 0027 6000 3184`) to see the invoice page path.
4. Turn the switch off at any time: it only changes new purchases.
