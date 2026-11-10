import { createHmac, timingSafeEqual } from "node:crypto";
import { newId } from "../../core/ids.js";
import { WebhookSignatureError, type CheckoutRequest, type CheckoutSession, type PaymentProvider, type ProviderEvent } from "./types.js";

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

  constructor(private opts: { mode?: "auto" | "manual"; webhookSecret?: string } = {}) {}

  private get secret(): string {
    return this.opts.webhookSecret ?? "mock-webhook-secret";
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    this.requests.push(req);
    const providerRef = `mock_${newId("payment")}`;
    if (this.failNext) { this.failNext = false; return { providerRef, status: "failed" }; }
    if ((this.opts.mode ?? "auto") === "auto") return { providerRef, status: "paid" };
    return { providerRef, status: "requires_payment", url: `${req.successUrl}?mock=${providerRef}` };
  }

  async cancelSubscription(providerRef: string): Promise<void> {
    if (!this.cancelled.includes(providerRef)) this.cancelled.push(providerRef);
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
    if ((e.type !== "payment.succeeded" && e.type !== "payment.failed" && e.type !== "subscription.cancelled") || typeof e.orderId !== "string" || typeof e.providerRef !== "string") return undefined;
    return { type: e.type, orderId: e.orderId, providerRef: e.providerRef };
  }
}
