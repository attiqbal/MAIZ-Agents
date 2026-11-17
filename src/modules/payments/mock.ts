import { createHmac, timingSafeEqual } from "node:crypto";
import { newId } from "../../core/ids.js";
import { PaymentUncertainError, WebhookSignatureError, type AddPreview, type AddToSubscriptionRequest, type AddToSubscriptionResult, type CheckoutRequest, type CheckoutSession, type PaymentProvider, type ProviderEvent, type RemoveFromSubscriptionRequest } from "./types.js";

const EVENT_TYPES = new Set<string>(["payment.succeeded", "payment.failed", "subscription.cancelled", "invoice.paid", "invoice.voided", "subscription.update_expired"]);
const strings = (x: unknown): string[] | undefined => (Array.isArray(x) && x.every((v) => typeof v === "string") ? (x as string[]) : undefined);

/**
 * A stand-in provider for development and tests. It charges nobody. In "auto" mode every checkout is paid at once;
 * in "manual" mode it waits for a signed webhook, exactly the path a real provider takes. Its webhook signature is
 * HMAC-SHA256 of the raw body in the `x-mock-signature` header, the same shape as Stripe's, so the verification
 * code and tests carry over.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  readonly requests: CheckoutRequest[] = [];
  readonly cancelled: string[] = [];
  /** Set to make the next checkouts fail, to test the unhappy path. */
  failNext = false;
  /** Lines added to, and taken off, an existing subscription (one bill). */
  readonly added: AddToSubscriptionRequest[] = [];
  readonly removed: RemoveFromSubscriptionRequest[] = [];
  /** Makes the next add to a subscription fail: "error" before any charge, "uncertain" with no clear answer. */
  addFails?: "error" | "uncertain";
  /** The part-month figure a preview gives. Unset: the provider has no exact figure. */
  previewMinor?: number;

  constructor(private opts: { mode?: "auto" | "manual"; webhookSecret?: string } = {}) {}

  private get secret(): string {
    return this.opts.webhookSecret ?? "mock-webhook-secret";
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    this.requests.push(req);
    const providerRef = `mock_${newId("payment")}`;
    if (this.failNext) { this.failNext = false; return { providerRef, status: "failed" }; }
    // A cart with a monthly line opens a subscription, which a real provider names when the first payment completes.
    if ((this.opts.mode ?? "auto") === "auto") return { providerRef, status: "paid", ...(req.lines.some((l) => l.billing === "monthly") ? { subscriptionRef: `mock_sub_${newId("payment")}` } : {}) };
    return { providerRef, status: "requires_payment", url: `${req.successUrl}?mock=${providerRef}` };
  }

  async cancelSubscription(providerRef: string): Promise<void> {
    if (!this.cancelled.includes(providerRef)) this.cancelled.push(providerRef);
  }

  async addToSubscription(req: AddToSubscriptionRequest): Promise<AddToSubscriptionResult> {
    const fails = this.addFails;
    this.addFails = undefined;
    if (fails === "error") throw new Error("the subscription cannot take a new line");
    const itemRefs = req.lines.map(() => `price_mock_${newId("payment")}`);
    req.prepared?.(itemRefs);
    if (fails === "uncertain") throw new PaymentUncertainError("the provider did not answer");
    this.added.push(req);
    const providerRef = `in_mock_${newId("payment")}`;
    const amountMinor = this.previewMinor ?? Math.round(req.lines.reduce((n, l) => n + l.unitMinor * l.qty, 0) / 2);
    if ((this.opts.mode ?? "auto") === "auto") return { status: "paid", providerRef, amountMinor, itemRefs };
    return { status: "requires_payment", providerRef, amountMinor, itemRefs, url: `https://pay.mock.test/invoice/${providerRef}` };
  }

  async previewAddToSubscription(): Promise<AddPreview> {
    return { prorationDate: Math.floor(Date.now() / 1000), ...(this.previewMinor !== undefined ? { amountMinor: this.previewMinor } : {}) };
  }

  async removeFromSubscription(req: RemoveFromSubscriptionRequest): Promise<{ endsAt?: string }> {
    this.removed.push(req);
    return {};
  }

  /** What a test (or the provider's dashboard) sends to the webhook route. */
  signedWebhook(event: ProviderEvent): { rawBody: string; headers: Record<string, string> } {
    const rawBody = JSON.stringify(event);
    return { rawBody, headers: { "x-mock-signature": createHmac("sha256", this.secret).update(rawBody).digest("hex") } };
  }

  parseWebhook(rawBody: string, headers: Record<string, string | undefined>): ProviderEvent | undefined {
    const got = Buffer.from(headers["x-mock-signature"] ?? "", "utf8");
    const want = Buffer.from(createHmac("sha256", this.secret).update(rawBody).digest("hex"), "utf8");
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new WebhookSignatureError("bad webhook signature");
    let e: Partial<ProviderEvent>;
    try { e = JSON.parse(rawBody); } catch { throw new WebhookSignatureError("webhook body is not JSON"); }
    if (typeof e.type !== "string" || !EVENT_TYPES.has(e.type) || typeof e.providerRef !== "string") return undefined;
    const ref = { ...(typeof e.subscriptionRef === "string" && e.subscriptionRef ? { subscriptionRef: e.subscriptionRef } : {}), ...(e.customerRef ? { customerRef: e.customerRef } : {}), ...(e.eventId ? { eventId: e.eventId } : {}) };
    if (e.type === "invoice.paid" || e.type === "invoice.voided" || e.type === "subscription.update_expired") {
      // These know the subscription, never one of our order ids.
      if (!ref.subscriptionRef) return undefined;
      const itemRefs = strings(e.itemRefs);
      return { type: e.type, providerRef: e.providerRef, ...ref, ...(itemRefs ? { itemRefs } : {}), ...(typeof e.workspaceRef === "string" ? { workspaceRef: e.workspaceRef } : {}), ...(typeof e.amountMinor === "number" ? { amountMinor: e.amountMinor } : {}), ...(typeof e.currency === "string" ? { currency: e.currency } : {}) };
    }
    if (typeof e.orderId !== "string") return undefined;
    return { type: e.type, orderId: e.orderId, providerRef: e.providerRef, ...ref };
  }
}
