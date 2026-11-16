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
  /** An agreed discount (a coupon from the promotions module). Without one, the provider may let the buyer enter a code. */
  discount?: { percentOff: number } | { amountOffMinor: number };
  discountMonths?: number | "forever";
}

export type CheckoutStatus = "requires_payment" | "paid" | "failed";

export interface CheckoutSession {
  /** The provider's id for this payment, kept to match webhooks and to cancel. */
  providerRef: string;
  status: CheckoutStatus;
  /** Where to send the customer to pay (hosted checkout). Absent when the payment already finished. */
  url?: string;
  /** The recurring subscription, when the provider already knows it. Usually learned later from the payment event. */
  subscriptionRef?: string;
}

/** What a verified webhook tells us. The order id is the one we sent in the request. */
export interface ProviderEvent {
  type: "payment.succeeded" | "payment.failed" | "payment.renewal_failed" | "payment.attention" | "subscription.cancelled"
    /** An invoice on a subscription was paid, was voided, or a change waiting for payment ran out of time (one bill, docs/ONE-BILL.md). */
    | "invoice.paid" | "invoice.voided" | "subscription.update_expired";
  /** The id we sent in the request. Absent on events that only know the provider's subscription. */
  orderId?: string;
  providerRef: string;
  /** The provider's id for the recurring subscription and the customer, kept to match later events and open the portal. */
  subscriptionRef?: string;
  customerRef?: string;
  /** The provider's id for this delivery, so a replay is recognised and ignored. */
  eventId?: string;
  /** What the customer actually paid, so an event is only accepted for an order it fully covers. */
  amountMinor?: number;
  currency?: string;
  /** Words for the platform owner on `payment.attention` (a dispute, a refund, a fraud warning). */
  detail?: string;
  /** The provider's ids of the prices on an invoice, or on a subscription and its waiting change. */
  itemRefs?: string[];
  /** The workspace the provider's subscription carries, to check an invoice against the order it is matched to. */
  workspaceRef?: string;
}

export class WebhookSignatureError extends Error {}

/**
 * Thrown when a call that can move money ended without a clear answer (the connection dropped, the provider had a
 * fault). The caller must not try another way to pay: the first one may still have gone through.
 */
export class PaymentUncertainError extends Error {
  /** The provider's id for the invoice, when the answer got that far. */
  constructor(message: string, readonly providerRef?: string) { super(message); }
}

/** Adds monthly lines to a subscription the client already pays, instead of opening a new checkout. */
export interface AddToSubscriptionRequest {
  orderId: string;
  workspaceId: string;
  /** The order that opened the subscription. The provider checks the subscription really carries it and this workspace. */
  planOrderId: string;
  subscriptionRef: string;
  currency: Currency;
  /** Monthly lines only. */
  lines: CheckoutLine[];
  /** The moment a preview priced the part month at (seconds), so the charge is the amount that was shown. */
  prorationDate?: number;
  /** Called with the provider's ids for the new lines before any money can move, so a later event can be matched even if this call never returns. */
  prepared?: (itemRefs: string[]) => void;
}

export interface AddToSubscriptionResult {
  /** "paid" only when the provider confirms the part-month invoice is paid and the lines are on the subscription. */
  status: "paid" | "requires_payment";
  /** The provider's id for the part-month invoice. */
  providerRef: string;
  /** The provider's own page where the customer finishes paying. Present when the status is "requires_payment". */
  url?: string;
  /** What the part-month invoice comes to. */
  amountMinor?: number;
  itemRefs: string[];
  /** When the waiting change runs out if it is not paid. */
  payBy?: string;
}

export interface AddPreview {
  /** The part-month charge, only when the provider gave an exact figure. */
  amountMinor?: number;
  prorationDate?: number;
  /** When the subscription next renews. */
  renewsAt?: string;
}

export interface RemoveFromSubscriptionRequest {
  subscriptionRef: string;
  workspaceId: string;
  /** The order that opened the subscription, checked against what the subscription carries. */
  planOrderId: string;
  /** The provider's price id of the line, when we know it (a line added to the bill). */
  itemRef?: string;
  /** Otherwise the line as it was sold. It must match exactly one line on the subscription. */
  match: { title: string; unitMinor: number; qty: number };
}

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
  /** A page where the customer manages their own card, invoices and cancellation. Optional: not every provider has one. */
  createPortalSession?(customerRef: string, returnUrl: string): Promise<string>;
  /**
   * Adds monthly lines to an existing subscription and charges the saved card for the part month. Throws a plain
   * error when nothing was charged (the caller may open a normal checkout instead) and PaymentUncertainError when
   * the outcome is not known.
   */
  addToSubscription?(req: AddToSubscriptionRequest): Promise<AddToSubscriptionResult>;
  /** Prices adding these lines today. Nothing is created or charged. */
  previewAddToSubscription?(req: Omit<AddToSubscriptionRequest, "orderId" | "prepared">): Promise<AddPreview>;
  /** Takes one line off a subscription so it is not charged again. Nothing is refunded. Returns the end of the time already paid for. */
  removeFromSubscription?(req: RemoveFromSubscriptionRequest): Promise<{ endsAt?: string }>;
}
