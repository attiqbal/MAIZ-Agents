import Stripe from "stripe";
import { PaymentUncertainError, type AddPreview, type AddToSubscriptionRequest, type AddToSubscriptionResult, type RemoveFromSubscriptionRequest } from "./types.js";

/**
 * One bill per client on Stripe (docs/ONE-BILL.md): later monthly lines are added to the subscription the client
 * already pays, the saved card is charged for the part month, and a line is taken off again at the client's request.
 * Nothing here has been run against real Stripe: every call is written from the pinned API version's types and
 * Stripe's documentation, and checked in tests against a fake client.
 */

const iso = (seconds: number | null | undefined): string | undefined => (typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : undefined);
const idOf = (x: unknown): string | undefined => (typeof x === "string" ? x : typeof x === "object" && x && typeof (x as { id?: unknown }).id === "string" ? (x as { id: string }).id : undefined);

/** The ids of the prices an invoice charges for. */
export function priceIdsOfInvoice(inv: Stripe.Invoice): string[] {
  const ids: string[] = [];
  for (const l of inv.lines?.data ?? []) {
    const id = idOf(l.pricing?.price_details?.price);
    if (id) ids.push(id);
  }
  return ids;
}

/** Errors that mean Stripe refused before anything was charged. Anything else leaves the outcome unknown. */
function isDefinite(e: unknown): boolean {
  return e instanceof Stripe.errors.StripeInvalidRequestError || e instanceof Stripe.errors.StripeCardError || e instanceof Stripe.errors.StripeAuthenticationError
    || e instanceof Stripe.errors.StripePermissionError || e instanceof Stripe.errors.StripeRateLimitError || e instanceof Stripe.errors.StripeIdempotencyError;
}

export class StripeBill {
  constructor(private stripe: Stripe) {}

  /** The subscription, only if it is the one MAIZ opened for this client's plan and can take a new line. */
  private async ownSubscription(ref: string, workspaceId: string, planOrderId: string, expand: string[] = []): Promise<Stripe.Subscription> {
    const sub = await this.stripe.subscriptions.retrieve(ref, expand.length ? { expand } : undefined);
    if (sub.metadata?.orderId !== planOrderId || sub.metadata?.workspaceId !== workspaceId) throw new Error("this subscription does not belong to the plan order");
    return sub;
  }

  private assertCanTakeLine(sub: Stripe.Subscription, currency: string): void {
    if (sub.status !== "active") throw new Error("the subscription is not active");
    if (sub.cancel_at_period_end || sub.cancel_at) throw new Error("the subscription is ending");
    if (sub.pending_update) throw new Error("the subscription already has a change waiting for payment");
    if (sub.collection_method !== "charge_automatically") throw new Error("the subscription is not charged to a saved card");
    if (sub.currency !== currency) throw new Error("the subscription is in another currency");
  }

  async add(req: AddToSubscriptionRequest): Promise<AddToSubscriptionResult> {
    const currency = req.currency.toLowerCase();
    const sub = await this.ownSubscription(req.subscriptionRef, req.workspaceId, req.planOrderId);
    this.assertCanTakeLine(sub, currency);
    const prices: string[] = [];
    for (const [i, l] of req.lines.entries()) {
      const price = await this.stripe.prices.create(
        { currency, unit_amount: l.unitMinor, recurring: { interval: "month" }, product_data: { name: l.title }, metadata: { orderId: req.orderId, workspaceId: req.workspaceId, key: l.key } },
        { idempotencyKey: `addprice-${req.orderId}-${i}` },
      );
      prices.push(price.id);
    }
    // Saved before any money can move, so a payment event can be matched to this order even if the call below never returns.
    req.prepared?.(prices);
    let updated: Stripe.Subscription;
    try {
      updated = await this.stripe.subscriptions.update(
        req.subscriptionRef,
        {
          items: req.lines.map((l, i) => ({ price: prices[i]!, quantity: l.qty })),
          proration_behavior: "always_invoice",
          // The change applies only if the part-month invoice is paid (Stripe "pending updates").
          payment_behavior: "pending_if_incomplete",
          ...(req.prorationDate ? { proration_date: req.prorationDate } : {}),
          expand: ["latest_invoice"],
        },
        { idempotencyKey: `addline-${req.orderId}` },
      );
    } catch (e) {
      if (isDefinite(e)) throw new Error(e instanceof Error ? e.message : "Stripe refused the change");
      throw new PaymentUncertainError(e instanceof Error ? e.message : "no clear answer from Stripe");
    }
    return this.outcome(updated, prices);
  }

  /** "paid" only for an invoice that Stripe says is paid and that charges for our new lines. Anything else waits or is unclear. */
  private async outcome(sub: Stripe.Subscription, prices: string[]): Promise<AddToSubscriptionResult> {
    const latest = sub.latest_invoice;
    const inv = typeof latest === "string" ? await this.stripe.invoices.retrieve(latest).catch(() => undefined) : latest ?? undefined;
    if (!inv?.id) throw new PaymentUncertainError("Stripe did not return the invoice for the change");
    const ours = prices.every((p) => priceIdsOfInvoice(inv).includes(p));
    if (!ours) throw new PaymentUncertainError("the latest invoice does not carry the new lines", inv.id);
    if (inv.status === "paid") return { status: "paid", providerRef: inv.id, amountMinor: inv.amount_paid, itemRefs: prices };
    if (inv.status !== "open" || !inv.hosted_invoice_url) throw new PaymentUncertainError(`the invoice is ${inv.status ?? "in an unknown state"}`, inv.id);
    const payBy = iso(sub.pending_update?.expires_at);
    return { status: "requires_payment", providerRef: inv.id, url: inv.hosted_invoice_url, amountMinor: inv.amount_due, itemRefs: prices, ...(payBy ? { payBy } : {}) };
  }

  /** The part-month charge, only when Stripe's preview is made of nothing but prorations and has no tax, discount or credit in it. */
  async preview(req: Omit<AddToSubscriptionRequest, "orderId" | "prepared">): Promise<AddPreview> {
    const sub = await this.ownSubscription(req.subscriptionRef, req.workspaceId, req.planOrderId);
    const first = sub.items.data[0];
    const product = idOf(first?.price.product);
    const renewsAt = iso(first?.current_period_end);
    const prorationDate = Math.floor(Date.now() / 1000);
    if (!first || !product) return { ...(renewsAt ? { renewsAt } : {}), prorationDate };
    const inv = await this.stripe.invoices.createPreview({
      subscription: req.subscriptionRef,
      subscription_details: {
        items: req.lines.map((l) => ({ price_data: { currency: req.currency.toLowerCase(), product, recurring: { interval: "month" as const }, unit_amount: l.unitMinor }, quantity: l.qty })),
        proration_behavior: "always_invoice",
        proration_date: prorationDate,
      },
    });
    const lines = inv.lines?.data ?? [];
    const sum = lines.reduce((n, l) => n + l.amount, 0);
    const allProrations = lines.length > 0 && lines.every((l) => l.parent?.subscription_item_details?.proration === true);
    const exact = allProrations && inv.total === sum && inv.subtotal === sum;
    return { prorationDate, ...(renewsAt ? { renewsAt } : {}), ...(exact ? { amountMinor: sum } : {}) };
  }

  /** Takes one line off the subscription now, without charging or refunding anything. Returns the end of the time already paid for. */
  async remove(req: RemoveFromSubscriptionRequest): Promise<{ endsAt?: string }> {
    const sub = await this.ownSubscription(req.subscriptionRef, req.workspaceId, req.planOrderId, ["items.data.price.product"]);
    if (sub.items.data.length < 2) throw new Error("this is the only line on the subscription");
    const found = req.itemRef
      ? sub.items.data.filter((i) => i.price.id === req.itemRef)
      : sub.items.data.filter((i) => i.price.unit_amount === req.match.unitMinor && i.quantity === req.match.qty && (typeof i.price.product === "object" && "name" in i.price.product ? i.price.product.name === req.match.title : false));
    // Taking the wrong line off would stop a service the client is still paying for: only a single clear match is acted on.
    if (found.length !== 1) throw new Error(`expected one matching line on the subscription, found ${found.length}`);
    const item = found[0]!;
    await this.stripe.subscriptions.update(req.subscriptionRef, { items: [{ id: item.id, deleted: true }], proration_behavior: "none" }, { idempotencyKey: `remove-${item.id}` });
    const endsAt = iso(item.current_period_end);
    return endsAt ? { endsAt } : {};
  }
}
