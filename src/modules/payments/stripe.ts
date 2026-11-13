import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { WebhookSignatureError, type CheckoutRequest, type CheckoutSession, type PaymentProvider, type ProviderEvent } from "./types.js";

/** The Stripe API version this integration was written and tested against. */
export const STRIPE_API_VERSION = "2026-10-28.endive";

export interface StripeOptions {
  /** A restricted key (rk_...) is best; a secret key (sk_...) works. Test-mode keys until the owner says go live. */
  secretKey: string;
  /** The signing secret (whsec_...) of the webhook endpoint, used to check every delivery. */
  webhookSecret: string;
  /** Stripe Tax. Only switch on once the account has an active tax registration, or Stripe collects no tax at all. */
  automaticTax?: boolean;
  /** Customer portal configuration (bpc_...) to use. Set it when the Stripe account is shared with other sites, or customers see the account default. */
  portalConfiguration?: string;
  /** Tests hand in a fake. */
  client?: Stripe;
}

const letters = (n: number) => Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join("");
const idOf = (x: unknown): string | undefined => (typeof x === "string" ? x : typeof x === "object" && x && typeof (x as { id?: unknown }).id === "string" ? (x as { id: string }).id : undefined);

/**
 * Stripe Checkout (subscription mode) plus webhooks. MAIZ owns the price book and sends each line inline as price_data,
 * so no products have to be created in the Stripe dashboard. Monthly lines recur; one-off lines (consultant passes) are
 * charged once on the first invoice. A cart with no monthly line is a plain one-off payment.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe";
  private stripe: Stripe;
  /** Tags our Checkout Sessions in the Stripe dashboard (the suffix is random, per Stripe's guidance). */
  private integrationId = `maiz-checkout-${letters(8)}`;

  constructor(private opts: StripeOptions) {
    this.stripe = opts.client ?? new Stripe(opts.secretKey, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion, maxNetworkRetries: 2 });
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const recurring = req.lines.some((l) => l.billing === "monthly");
    const currency = req.currency.toLowerCase();
    const common = {
      client_reference_id: req.orderId,
      metadata: { orderId: req.orderId, workspaceId: req.workspaceId },
      ...(req.customerEmail ? { customer_email: req.customerEmail } : {}),
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      line_items: req.lines.map((l) => ({
        quantity: l.qty,
        price_data: {
          currency,
          unit_amount: l.unitMinor,
          product_data: { name: l.title },
          ...(l.billing === "monthly" ? { recurring: { interval: "month" as const } } : {}),
        },
      })),
      billing_address_collection: "required" as const,
      tax_id_collection: { enabled: true },
      ...(this.opts.automaticTax ? { automatic_tax: { enabled: true } } : {}),
      integration_identifier: this.integrationId,
      // MAIZ AI Ltd is the seller of record (Terms). Stops an account-wide Managed Payments default from rejecting lines with no tax code.
      managed_payments: { enabled: false },
    };
    const discount = req.discount ? await this.couponFor(req) : undefined;
    const withCodes = discount ? { discounts: [{ coupon: discount }] } : { allow_promotion_codes: true };
    const session = await this.stripe.checkout.sessions.create(
      recurring
        ? { ...common, ...withCodes, mode: "subscription", subscription_data: { metadata: { orderId: req.orderId, workspaceId: req.workspaceId } } }
        : { ...common, ...withCodes, mode: "payment", invoice_creation: { enabled: true, invoice_data: { metadata: { orderId: req.orderId } } } },
      // The same order id can never open two sessions, even if our request is retried.
      { idempotencyKey: `checkout-${req.orderId}` },
    );
    if (!session.url) throw new Error("Stripe did not return a checkout address");
    return { providerRef: session.id, status: "requires_payment", url: session.url };
  }

  private async couponFor(req: CheckoutRequest): Promise<string> {
    const d = req.discount!;
    const months = req.discountMonths ?? "forever";
    const duration = months === "forever" ? { duration: "forever" as const } : months === 1 ? { duration: "once" as const } : { duration: "repeating" as const, duration_in_months: months };
    const coupon = await this.stripe.coupons.create(
      { ...("percentOff" in d ? { percent_off: d.percentOff } : { amount_off: d.amountOffMinor, currency: req.currency.toLowerCase() }), ...duration, max_redemptions: 1, name: "MAIZ discount" },
      { idempotencyKey: `coupon-${req.orderId}` },
    );
    return coupon.id;
  }

  /** Ends the subscription at the end of the month already paid for. A checkout nobody finished is closed instead. */
  async cancelSubscription(ref: string): Promise<void> {
    try {
      if (ref.startsWith("sub_")) await this.stripe.subscriptions.update(ref, { cancel_at_period_end: true });
      else if (ref.startsWith("cs_")) await this.stripe.checkout.sessions.expire(ref);
    } catch (e) {
      // Already cancelled, already expired or completed: nothing left to stop.
      if (e instanceof Stripe.errors.StripeInvalidRequestError) return;
      throw e;
    }
  }

  async createPortalSession(customerRef: string, returnUrl: string): Promise<string> {
    const s = await this.stripe.billingPortal.sessions.create({
      customer: customerRef,
      return_url: returnUrl,
      ...(this.opts.portalConfiguration ? { configuration: this.opts.portalConfiguration } : {}),
    });
    return s.url;
  }

  parseWebhook(rawBody: string, headers: Record<string, string | undefined>): ProviderEvent | undefined {
    const signature = headers["stripe-signature"];
    let event: Stripe.Event;
    try {
      if (!signature) throw new Error("missing signature");
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.opts.webhookSecret);
    } catch {
      throw new WebhookSignatureError("bad webhook signature");
    }
    // A key and the events it receives must be the same mode; a test event can never fulfil a live order or the reverse.
    if (event.livemode !== this.opts.secretKey.includes("_live_")) return undefined;
    return this.translate(event);
  }

  private translate(event: Stripe.Event): ProviderEvent | undefined {
    const base = { eventId: event.id };
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object;
        // A delayed method (bank debit) completes the session before the money arrives: wait for the async event.
        if (s.payment_status === "unpaid") return undefined;
        return this.fromSession("payment.succeeded", s, base);
      }
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired":
        return this.fromSession("payment.failed", event.data.object, base);
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        return { ...base, type: "subscription.cancelled", providerRef: sub.id, subscriptionRef: sub.id, ...custom(sub.customer) };
      }
      case "invoice.payment_failed": {
        const inv = event.data.object;
        const subscriptionRef = subscriptionOfInvoice(inv);
        // A failed first payment shows on the Checkout page itself; only a failed renewal needs a person.
        if (!subscriptionRef || inv.billing_reason !== "subscription_cycle") return undefined;
        return { ...base, type: "payment.renewal_failed", providerRef: inv.id ?? subscriptionRef, subscriptionRef };
      }
      case "charge.dispute.created":
        return { ...base, type: "payment.attention", providerRef: event.data.object.id, detail: `A customer disputed a payment (${event.data.object.id}). Respond in the Stripe dashboard before the deadline.` };
      case "charge.refunded":
        return { ...base, type: "payment.attention", providerRef: event.data.object.id, detail: `A payment was refunded (${event.data.object.id}). Check the customer's plan still matches what they paid.` };
      case "radar.early_fraud_warning.created":
        return { ...base, type: "payment.attention", providerRef: event.data.object.id, detail: `Stripe raised an early fraud warning (${event.data.object.id}). Review the payment in the dashboard.` };
      default:
        return undefined;
    }
  }

  private fromSession(type: "payment.succeeded" | "payment.failed", s: Stripe.Checkout.Session, base: { eventId: string }): ProviderEvent | undefined {
    // The order id must be in both places we put it; a session made some other way (a Payment Link) cannot match.
    if (!s.client_reference_id || s.metadata?.orderId !== s.client_reference_id) return undefined;
    const subscriptionRef = idOf(s.subscription);
    return { ...base, type, orderId: s.client_reference_id, providerRef: s.id, ...(s.amount_total != null ? { amountMinor: s.amount_total } : {}), ...(s.currency ? { currency: s.currency } : {}), ...(subscriptionRef ? { subscriptionRef } : {}), ...custom(s.customer) };
  }
}

const custom = (c: unknown): { customerRef?: string } => {
  const id = idOf(c);
  return id ? { customerRef: id } : {};
};

/** The subscription an invoice belongs to. API versions before and after 2025 keep it in different places. */
function subscriptionOfInvoice(inv: Stripe.Invoice): string | undefined {
  const legacy = (inv as unknown as { subscription?: unknown }).subscription;
  return idOf(legacy) ?? idOf(inv.parent?.subscription_details?.subscription);
}
