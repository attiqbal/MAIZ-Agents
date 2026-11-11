/**
 * The payment layer's contract. MAIZ code only ever talks to a PaymentProvider; a real provider (Stripe is the
 * likely first) is one class that implements this interface and is handed to createPlatform. Nothing in here
 * charges anyone: amounts are minor units (pence) in one currency, taken from the server's own price book.
 */
export type Currency = "GBP";

export interface CheckoutLine {
  key: string;
  title: string;
  qty: number;
  /** Price of one, in minor units. */
  unitMinor: number;
  billing: "monthly" | "once";
}

export interface CheckoutRequest {
  orderId: string;
  workspaceId: string;
  customerEmail?: string;
  currency: Currency;
  lines: CheckoutLine[];
  /** Taken today: one-off items plus the first month. */
  dueTodayMinor: number;
  /** Charged every month after today. */
  monthlyMinor: number;
  successUrl: string;
  cancelUrl: string;
}

export type CheckoutStatus = "requires_payment" | "paid" | "failed";

export interface CheckoutSession {
  /** The provider's id for this payment, kept to match webhooks and to cancel. */
  providerRef: string;
  status: CheckoutStatus;
  /** Where to send the customer to pay (hosted checkout). Absent when the payment already finished. */
  url?: string;
}

/** What a verified webhook tells us. The order id is the one we sent in the request. */
export interface ProviderEvent {
  type: "payment.succeeded" | "payment.failed" | "subscription.cancelled";
  orderId: string;
  providerRef: string;
}

export class WebhookSignatureError extends Error {}

export interface PaymentProvider {
  readonly name: string;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /** Stops future monthly charges for the order. Idempotent. */
  cancelSubscription(providerRef: string): Promise<void>;
  /**
   * Checks the webhook's signature against the exact bytes received and returns what happened, or undefined for an
   * event kind we do not care about. Throws WebhookSignatureError when the signature is wrong or missing.
   */
  parseWebhook(rawBody: string, headers: Record<string, string | undefined>): ProviderEvent | undefined;
}
