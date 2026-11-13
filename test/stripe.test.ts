import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { StripePaymentProvider, WebhookSignatureError, type CheckoutRequest } from "../src/modules/payments/index.js";
import { checkEnv } from "../src/server/config.js";
import { createApp, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";

const SECRET = "whsec_test_secret";
const stripeLib = new Stripe("sk_test_x");
const sign = (payload: string) => stripeLib.webhooks.generateTestHeaderString({ payload, secret: SECRET });
const evt = (id: string, type: string, object: unknown, livemode = false) => JSON.stringify({ id, object: "event", type, livemode, data: { object } });

function fake() {
  const calls: any = { sessions: [] as any[], coupons: [] as any[], updates: [] as any[], expired: [] as string[], portal: [] as any[] };
  const client = Object.assign(new Stripe("sk_test_x"), {
    checkout: { sessions: { create: async (p: any) => { calls.sessions.push(p); return { id: "cs_test_1", url: "https://checkout.stripe.test/pay" }; }, expire: async (id: string) => { calls.expired.push(id); } } },
    coupons: { create: async (p: any) => { calls.coupons.push(p); return { id: "co_1" }; } },
    subscriptions: { update: async (id: string, p: any) => { calls.updates.push([id, p]); } },
    billingPortal: { sessions: { create: async (p: any) => { calls.portal.push(p); return { url: "https://billing.stripe.test/p" }; } } },
  }) as unknown as Stripe;
  return { calls, provider: new StripePaymentProvider({ secretKey: "sk_test_x", webhookSecret: SECRET, client }) };
}

const req = (lines: CheckoutRequest["lines"], extra: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
  orderId: "order_1", workspaceId: "ws_1", customerEmail: "a@b.co", currency: "GBP", lines, dueTodayMinor: 0, monthlyMinor: 0, successUrl: "https://x/ok", cancelUrl: "https://x/no", ...extra,
});
const monthly = { key: "ops", title: "Operations manager", qty: 2, unitMinor: 2500, billing: "monthly" as const };
const once = { key: "pass", title: "Consultant pass", qty: 1, unitMinor: 9900, billing: "once" as const };

describe("Stripe checkout", () => {
  it("opens a subscription session with GBP monthly lines, one-offs on the first invoice, and no payment_method_types", async () => {
    const { provider, calls } = fake();
    const s = await provider.createCheckout(req([monthly, once]));
    expect(s).toEqual({ providerRef: "cs_test_1", status: "requires_payment", url: "https://checkout.stripe.test/pay" });
    const p = calls.sessions[0];
    expect(p.mode).toBe("subscription");
    expect(p).not.toHaveProperty("payment_method_types");
    expect(p.client_reference_id).toBe("order_1");
    expect(p.allow_promotion_codes).toBe(true);
    expect(p.line_items[0].price_data).toMatchObject({ currency: "gbp", unit_amount: 2500, recurring: { interval: "month" } });
    expect(p.line_items[1].price_data.recurring).toBeUndefined();
    expect(p.integration_identifier).toMatch(/^maiz-checkout-[a-z]{8}$/);
    expect(p.automatic_tax).toBeUndefined();
  });

  it("uses payment mode with an invoice for a cart of one-offs only", async () => {
    const { provider, calls } = fake();
    await provider.createCheckout(req([once]));
    expect(calls.sessions[0]).toMatchObject({ mode: "payment", invoice_creation: { enabled: true } });
  });

  it("applies an agreed discount as a one-use Stripe coupon instead of open promotion codes", async () => {
    const { provider, calls } = fake();
    await provider.createCheckout(req([monthly], { discount: { percentOff: 20 }, discountMonths: 3 }));
    expect(calls.coupons[0]).toMatchObject({ percent_off: 20, duration: "repeating", duration_in_months: 3, max_redemptions: 1 });
    expect(calls.sessions[0].discounts).toEqual([{ coupon: "co_1" }]);
    expect(calls.sessions[0].allow_promotion_codes).toBeUndefined();
  });

  it("ends a subscription at the end of the paid month and closes an unfinished checkout", async () => {
    const { provider, calls } = fake();
    await provider.cancelSubscription("sub_9");
    await provider.cancelSubscription("cs_test_1");
    expect(calls.updates).toEqual([["sub_9", { cancel_at_period_end: true }]]);
    expect(calls.expired).toEqual(["cs_test_1"]);
  });

  it("opens the customer portal", async () => {
    const { provider, calls } = fake();
    expect(await provider.createPortalSession("cus_1", "https://x/back")).toBe("https://billing.stripe.test/p");
    expect(calls.portal[0]).toEqual({ customer: "cus_1", return_url: "https://x/back" });
  });
});

describe("Stripe webhooks", () => {
  const { provider } = fake();
  const parse = (body: string, sig = sign(body)) => provider.parseWebhook(body, { "stripe-signature": sig });

  it("rejects a missing, wrong or tampered signature", () => {
    const body = evt("evt_1", "checkout.session.completed", { id: "cs_1", payment_status: "paid", client_reference_id: "order_1", metadata: { orderId: "order_1" } });
    expect(() => provider.parseWebhook(body, {})).toThrow(WebhookSignatureError);
    expect(() => parse(body, "t=1,v1=00")).toThrow(WebhookSignatureError);
    expect(() => parse(body + " ", sign(body))).toThrow(WebhookSignatureError);
  });

  it("turns a paid session into a payment, carrying subscription and customer ids", () => {
    const body = evt("evt_1", "checkout.session.completed", { id: "cs_1", payment_status: "paid", client_reference_id: "order_1", metadata: { orderId: "order_1" }, subscription: "sub_1", customer: "cus_1" });
    expect(parse(body)).toEqual({ eventId: "evt_1", type: "payment.succeeded", orderId: "order_1", providerRef: "cs_1", subscriptionRef: "sub_1", customerRef: "cus_1" });
    expect(parse(evt("e1b", "checkout.session.completed", { id: "cs_1", payment_status: "paid", client_reference_id: "order_1" }))).toBeUndefined(); // no matching metadata: not ours
    expect(parse(evt("e1c", "checkout.session.completed", { id: "cs_1", payment_status: "paid", client_reference_id: "order_1", metadata: { orderId: "order_1" } }, true))).toBeUndefined(); // live event on a test key
  });

  it("waits for delayed payment methods, and fails an expired or failed session", () => {
    expect(parse(evt("e2", "checkout.session.completed", { id: "cs_1", payment_status: "unpaid", client_reference_id: "order_1", metadata: { orderId: "order_1" } }))).toBeUndefined();
    expect(parse(evt("e3", "checkout.session.async_payment_succeeded", { id: "cs_1", payment_status: "paid", client_reference_id: "order_1", metadata: { orderId: "order_1" } }))?.type).toBe("payment.succeeded");
    expect(parse(evt("e4", "checkout.session.async_payment_failed", { id: "cs_1", client_reference_id: "order_1", metadata: { orderId: "order_1" } }))?.type).toBe("payment.failed");
    expect(parse(evt("e5", "checkout.session.expired", { id: "cs_1", client_reference_id: "order_1", metadata: { orderId: "order_1" } }))?.type).toBe("payment.failed");
  });

  it("maps cancellation, failed renewals and risk events, and ignores the rest", () => {
    expect(parse(evt("e6", "customer.subscription.deleted", { id: "sub_1", customer: "cus_1" }))).toMatchObject({ type: "subscription.cancelled", subscriptionRef: "sub_1" });
    expect(parse(evt("e7", "invoice.payment_failed", { id: "in_1", billing_reason: "subscription_cycle", parent: { subscription_details: { subscription: "sub_1" } } }))).toMatchObject({ type: "payment.renewal_failed", subscriptionRef: "sub_1" });
    expect(parse(evt("e8", "invoice.payment_failed", { id: "in_2", billing_reason: "subscription_create", subscription: "sub_1" }))).toBeUndefined();
    expect(parse(evt("e9", "charge.dispute.created", { id: "dp_1" }))?.type).toBe("payment.attention");
    expect(parse(evt("e10", "charge.refunded", { id: "ch_1" }))?.type).toBe("payment.attention");
    expect(parse(evt("e11", "customer.created", { id: "cus_1" }))).toBeUndefined();
  });
});

describe("Stripe through the whole app", () => {
  function setup() {
    const { provider, calls } = fake();
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", platformOwners: ["atif@maiz.test"], payments: provider });
    const handle = createApp(platform);
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, rawBody?: string) =>
      handle({ method, path, query: new URLSearchParams(), headers, rawBody: rawBody ?? (body === undefined ? "" : JSON.stringify(body)) } as Req);
    return { platform, call, calls };
  }

  it("hires once on payment, survives replays, cancels on subscription end and opens the portal", async () => {
    const s = setup();
    const r = await s.call("POST", "/api/signup", { email: "ann@kestrel.co", businessName: "Kestrel", sells: "Coffee", size: "2–10", country: "GB" });
    const ann = { authorization: `Bearer ${(r.body as any).token}` };
    const item = ((await s.call("GET", "/api/store")).body as any).catalogue.find((i: any) => i.kind === "employee");
    const co = await s.call("POST", "/api/checkout", { lines: [{ key: item.key }] }, ann);
    expect((co.body as any).url).toBe("https://checkout.stripe.test/pay");
    const order = (co.body as any).order;
    expect(order.status).toBe("pending");
    expect((await s.call("POST", "/api/billing/portal", {}, ann)).status).toBe(400); // nothing paid yet

    const paid = evt("evt_a", "checkout.session.completed", { id: "cs_test_1", payment_status: "paid", client_reference_id: order.id, metadata: { orderId: order.id }, amount_total: order.dueTodayMinor, currency: "gbp", subscription: "sub_1", customer: "cus_1" });
    expect((await s.call("POST", "/api/payments/webhook", undefined, { "stripe-signature": sign(paid) }, paid)).status).toBe(200);
    expect((await s.call("POST", "/api/payments/webhook", undefined, { "stripe-signature": sign(paid) }, paid)).status).toBe(200);
    const orders = ((await s.call("GET", "/api/orders", undefined, ann)).body as any).orders;
    expect(orders[0]).toMatchObject({ status: "paid" });
    expect(orders[0].employeeIds).toHaveLength(1);

    expect(((await s.call("POST", "/api/billing/portal", {}, ann)).body as any).url).toBe("https://billing.stripe.test/p");
    expect(s.calls.portal[0].customer).toBe("cus_1");

    // A signed payment for a different session, or for less than is due, changes nothing.
    const other = setup();
    const r2 = await other.call("POST", "/api/signup", { email: "bob@x.co", businessName: "Bob", sells: "Bikes", size: "2–10", country: "GB" });
    const bob = { authorization: `Bearer ${(r2.body as any).token}` };
    const co2 = (await other.call("POST", "/api/checkout", { lines: [{ key: item.key }] }, bob)).body as any;
    for (const [i, extra] of [{ id: "cs_other" }, { amount_total: 1 }, { currency: "usd" }].entries()) {
      const bad2 = evt(`evt_bad${i}`, "checkout.session.completed", { id: "cs_test_1", payment_status: "paid", client_reference_id: co2.order.id, metadata: { orderId: co2.order.id }, amount_total: co2.order.dueTodayMinor, currency: "gbp", customer: "cus_x", ...extra });
      await other.call("POST", "/api/payments/webhook", undefined, { "stripe-signature": sign(bad2) }, bad2);
    }
    expect(((await other.call("GET", "/api/orders", undefined, bob)).body as any).orders[0]).toMatchObject({ status: "pending", employeeIds: [] });

    const gone = evt("evt_b", "customer.subscription.deleted", { id: "sub_1", customer: "cus_1" });
    await s.call("POST", "/api/payments/webhook", undefined, { "stripe-signature": sign(gone) }, gone);
    expect(((await s.call("GET", "/api/orders", undefined, ann)).body as any).orders[0].status).toBe("cancelled");

    const bad = await s.call("POST", "/api/payments/webhook", undefined, { "stripe-signature": "t=1,v1=00" }, paid);
    expect(bad.status).toBe(400);
  });
});

describe("Stripe configuration checks", () => {
  const base = { PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_abc123", STRIPE_WEBHOOK_SECRET: "whsec_abc123" };
  it("accepts test keys outside production", () => expect(checkEnv(base)).toEqual([]));
  it("needs both secrets", () => expect(checkEnv({ PAYMENTS_PROVIDER: "stripe" }).length).toBe(2));
  it("refuses live keys without an explicit opt-in", () => {
    expect(checkEnv({ ...base, STRIPE_SECRET_KEY: "rk_live_abc123" }).join()).toMatch(/live Stripe key/);
    expect(checkEnv({ ...base, STRIPE_SECRET_KEY: "rk_live_abc123", STRIPE_ALLOW_LIVE: "1" })).toEqual([]);
  });
  it("refuses test keys in production without an explicit opt-in", () => {
    const prod = { NODE_ENV: "production" } as Record<string, string>;
    expect(checkEnv({ ...prod, ...base }).join()).toMatch(/test Stripe key in production/);
  });
});
