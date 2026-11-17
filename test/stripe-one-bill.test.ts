import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { PaymentUncertainError, StripePaymentProvider, type AddToSubscriptionRequest } from "../src/modules/payments/index.js";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { TEAM_PACKAGE_KEY } from "../src/modules/store/cart.js";

const SECRET = "whsec_test_secret";
const OWNER = "atif@maiz.test";
const stripeLib = new Stripe("sk_test_x");
const sign = (payload: string) => stripeLib.webhooks.generateTestHeaderString({ payload, secret: SECRET });
const evt = (id: string, type: string, object: unknown, livemode = false) => JSON.stringify({ id, object: "event", type, livemode, data: { object } });

const SUB = "sub_plan";
const PERIOD_END = 1_796_894_400;
const PERIOD_END_ISO = new Date(PERIOD_END * 1000).toISOString();
const EXPIRES = 1_790_086_400;
const item = (id: string, priceId: string, amount: number, qty: number, name: string) => ({ id, quantity: qty, current_period_end: PERIOD_END, price: { id: priceId, unit_amount: amount, product: { id: `prod_${id}`, name } } });
const baseSub = (over: Record<string, unknown> = {}) => ({
  id: SUB, status: "active", cancel_at_period_end: false, cancel_at: null, pending_update: null, collection_method: "charge_automatically", currency: "gbp",
  metadata: { orderId: "order_plan", workspaceId: "ws_1" },
  items: { data: [item("si_plan", "price_plan", 15000, 1, "Team package"), item("si_extra", "price_extra", 2500, 1, "Supply chain manager")] },
  ...over,
});
const invoice = (over: Record<string, unknown> = {}) => ({ id: "in_1", status: "paid", amount_paid: 1250, amount_due: 1250, currency: "gbp", hosted_invoice_url: "https://invoice.stripe.test/i/1", lines: { data: [{ pricing: { price_details: { price: "price_new_0" } } }] }, ...over });

function fake(over: { sub?: unknown; updated?: unknown; updateError?: unknown; preview?: unknown } = {}) {
  const calls = { prices: [] as any[], updates: [] as any[], keys: [] as any[], voided: [] as string[], previews: [] as any[], retrieved: 0 };
  const client = Object.assign(new Stripe("sk_test_x"), {
    subscriptions: {
      retrieve: async () => { calls.retrieved++; return over.sub ?? baseSub(); },
      update: async (id: string, p: any, o: any) => { calls.updates.push([id, p]); calls.keys.push(o?.idempotencyKey); if (over.updateError) throw over.updateError; return over.updated ?? baseSub({ latest_invoice: invoice() }); },
    },
    prices: { create: async (p: any, o: any) => { calls.prices.push([p, o?.idempotencyKey]); return { id: `price_new_${calls.prices.length - 1}` }; } },
    checkout: { sessions: { create: async () => ({ id: "cs_test_1", url: "https://checkout.stripe.test/pay" }), expire: async () => undefined } },
    invoices: { createPreview: async (p: any) => { calls.previews.push(p); return over.preview; }, voidInvoice: async (id: string) => { calls.voided.push(id); }, retrieve: async () => invoice() },
  }) as unknown as Stripe;
  return { calls, provider: new StripePaymentProvider({ secretKey: "sk_test_x", webhookSecret: SECRET, client }) };
}

const line = { key: "supply-chain-manager", title: "Supply chain manager", qty: 1, unitMinor: 2500, billing: "monthly" as const };
const req = (extra: Partial<AddToSubscriptionRequest> = {}): AddToSubscriptionRequest => ({ orderId: "order_add", workspaceId: "ws_1", planOrderId: "order_plan", subscriptionRef: SUB, currency: "GBP", lines: [line], ...extra });

describe("adding a line to the subscription", () => {
  it("creates a price, saves it before any money moves, and asks Stripe to add it only if the part-month invoice is paid", async () => {
    const { provider, calls } = fake();
    const order: string[] = [];
    const r = await provider.addToSubscription!(req({ prorationDate: 1_790_000_000, prepared: (ids) => order.push(`prepared:${ids.join(",")}:updates=${calls.updates.length}`) }));

    expect(r).toEqual({ status: "paid", providerRef: "in_1", amountMinor: 1250, itemRefs: ["price_new_0"] });
    expect(order).toEqual(["prepared:price_new_0:updates=0"]);
    expect(calls.prices[0]).toEqual([{ currency: "gbp", unit_amount: 2500, recurring: { interval: "month" }, product_data: { name: "Supply chain manager" }, metadata: { orderId: "order_add", workspaceId: "ws_1", key: "supply-chain-manager" } }, "addprice-order_add-0"]);
    expect(calls.updates[0]).toEqual([SUB, { items: [{ price: "price_new_0", quantity: 1 }], proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete", proration_date: 1_790_000_000, expand: ["latest_invoice"] }]);
    expect(calls.keys).toEqual(["addline-order_add"]);
  });

  it("sends the client to Stripe's invoice page when the invoice is open, and says when the waiting change runs out", async () => {
    const { provider } = fake({ updated: baseSub({ pending_update: { expires_at: EXPIRES, subscription_items: [] }, latest_invoice: invoice({ status: "open" }) }) });

    const r = await provider.addToSubscription!(req());

    expect(r).toEqual({ status: "requires_payment", providerRef: "in_1", url: "https://invoice.stripe.test/i/1", amountMinor: 1250, itemRefs: ["price_new_0"], payBy: new Date(EXPIRES * 1000).toISOString() });
  });

  it("never reports paid when the invoice is not ours or is in an odd state: the answer is unclear and no other way to pay is opened", async () => {
    const notOurs = fake({ updated: baseSub({ latest_invoice: invoice({ lines: { data: [{ pricing: { price_details: { price: "price_other" } } }] } }) }) });
    const noPage = fake({ updated: baseSub({ latest_invoice: invoice({ status: "open", hosted_invoice_url: null }) }) });
    const draft = fake({ updated: baseSub({ latest_invoice: invoice({ status: "draft" }) }) });
    const none = fake({ updated: baseSub({ latest_invoice: null }) });

    for (const f of [notOurs, noPage, draft, none]) await expect(f.provider.addToSubscription!(req())).rejects.toBeInstanceOf(PaymentUncertainError);
  });

  it("falls back (plain error) when Stripe refuses or the card is declined, and reports no clear answer when the connection fails", async () => {
    const invalid = fake({ updateError: new Stripe.errors.StripeInvalidRequestError({ message: "no such price", type: "invalid_request_error" }) });
    const card = fake({ updateError: new Stripe.errors.StripeCardError({ message: "declined", type: "card_error" }) });
    const dropped = fake({ updateError: new Stripe.errors.StripeConnectionError({ message: "socket hang up", type: "api_error" }) });
    const server = fake({ updateError: new Stripe.errors.StripeAPIError({ message: "boom", type: "api_error" }) });

    for (const f of [invalid, card]) await expect(f.provider.addToSubscription!(req())).rejects.not.toBeInstanceOf(PaymentUncertainError);
    for (const f of [dropped, server]) await expect(f.provider.addToSubscription!(req())).rejects.toBeInstanceOf(PaymentUncertainError);
  });

  it("refuses, before creating anything, a subscription that is not this client's plan or cannot take a line", async () => {
    const cases = [
      baseSub({ metadata: { orderId: "order_plan", workspaceId: "ws_other" } }),
      baseSub({ metadata: { orderId: "order_other", workspaceId: "ws_1" } }),
      baseSub({ status: "past_due" }),
      baseSub({ cancel_at_period_end: true }),
      baseSub({ pending_update: { expires_at: 1, subscription_items: [] } }),
      baseSub({ collection_method: "send_invoice" }),
      baseSub({ currency: "usd" }),
    ];
    for (const sub of cases) {
      const { provider, calls } = fake({ sub });
      await expect(provider.addToSubscription!(req())).rejects.toThrow();
      expect(calls.prices).toEqual([]);
      expect(calls.updates).toEqual([]);
    }
  });
});

describe("pricing the part month", () => {
  const prorationLine = (amount: number) => ({ amount, parent: { subscription_item_details: { proration: true } } });

  it("gives the exact figure only when the preview is nothing but prorations with no tax or discount in it", async () => {
    const exact = fake({ preview: { lines: { data: [prorationLine(1250)] }, total: 1250, subtotal: 1250 } });
    const withNext = fake({ preview: { lines: { data: [prorationLine(1250), { amount: 2500, parent: { subscription_item_details: { proration: false } } }] }, total: 3750, subtotal: 3750 } });
    const taxed = fake({ preview: { lines: { data: [prorationLine(1250)] }, total: 1500, subtotal: 1250 } });

    const a = await exact.provider.previewAddToSubscription!(req());
    const b = await withNext.provider.previewAddToSubscription!(req());
    const c = await taxed.provider.previewAddToSubscription!(req());

    expect(a).toMatchObject({ amountMinor: 1250, renewsAt: PERIOD_END_ISO });
    expect(a.prorationDate).toEqual(expect.any(Number));
    expect(b).not.toHaveProperty("amountMinor");
    expect(c).not.toHaveProperty("amountMinor");
    expect(exact.calls.previews[0]).toMatchObject({ subscription: SUB, subscription_details: { proration_behavior: "always_invoice", proration_date: a.prorationDate, items: [{ quantity: 1, price_data: { currency: "gbp", product: "prod_si_plan", unit_amount: 2500, recurring: { interval: "month" } } }] } });
  });
});

describe("taking a line off the subscription", () => {
  const remove = (extra: Record<string, unknown> = {}) => ({ subscriptionRef: SUB, workspaceId: "ws_1", planOrderId: "order_plan", match: { title: "Supply chain manager", unitMinor: 2500, qty: 1 }, ...extra });

  it("deletes the one item by its price id, without charging or refunding, and says when the paid month ends", async () => {
    const { provider, calls } = fake();

    const r = await provider.removeFromSubscription!(remove({ itemRef: "price_extra" }));

    expect(r).toEqual({ endsAt: PERIOD_END_ISO });
    expect(calls.updates).toEqual([[SUB, { items: [{ id: "si_extra", deleted: true }], proration_behavior: "none" }]]);
  });

  it("finds a line sold at checkout by its name, price and quantity, and refuses when it is not exactly one line", async () => {
    const twice = baseSub({ items: { data: [item("si_plan", "price_plan", 15000, 1, "Team package"), item("si_a", "price_a", 2500, 1, "Supply chain manager"), item("si_b", "price_b", 2500, 1, "Supply chain manager")] } });
    const only = baseSub({ items: { data: [item("si_plan", "price_plan", 15000, 1, "Team package")] } });
    const ok = fake();
    const ambiguous = fake({ sub: twice });
    const missing = fake();
    const alone = fake({ sub: only });

    await ok.provider.removeFromSubscription!(remove());
    await expect(ambiguous.provider.removeFromSubscription!(remove())).rejects.toThrow(/found 2/);
    await expect(missing.provider.removeFromSubscription!(remove({ match: { title: "Other", unitMinor: 2500, qty: 1 } }))).rejects.toThrow(/found 0/);
    await expect(alone.provider.removeFromSubscription!(remove())).rejects.toThrow(/only line/);

    expect(ok.calls.updates[0]![1].items).toEqual([{ id: "si_extra", deleted: true }]);
    for (const f of [ambiguous, missing, alone]) expect(f.calls.updates).toEqual([]);
  });

  it("will not touch a subscription that is not the plan's", async () => {
    const { provider, calls } = fake({ sub: baseSub({ metadata: { orderId: "order_plan", workspaceId: "ws_other" } }) });

    await expect(provider.removeFromSubscription!(remove({ itemRef: "price_extra" }))).rejects.toThrow();
    expect(calls.updates).toEqual([]);
  });

  it("closes an unpaid part-month invoice by voiding it", async () => {
    const { provider, calls } = fake();
    await provider.cancelSubscription("in_1");
    expect(calls.voided).toEqual(["in_1"]);
  });
});

describe("what Stripe's events say", () => {
  const send = (provider: StripePaymentProvider, id: string, type: string, object: unknown, livemode = false) => { const raw = evt(id, type, object, livemode); return provider.parseWebhook(raw, { "stripe-signature": sign(raw) }); };
  const paid = { id: "in_1", amount_paid: 1250, currency: "gbp", customer: "cus_1", lines: { data: [{ pricing: { price_details: { price: "price_new_0" } } }] }, parent: { type: "subscription_details", subscription_details: { subscription: SUB, metadata: { orderId: "order_plan", workspaceId: "ws_1" } } } };

  it("turns a paid invoice into what the order must match: invoice, subscription, workspace, prices, amount", () => {
    const { provider } = fake();
    expect(send(provider, "evt_1", "invoice.paid", paid)).toEqual({ eventId: "evt_1", type: "invoice.paid", providerRef: "in_1", subscriptionRef: SUB, itemRefs: ["price_new_0"], amountMinor: 1250, currency: "gbp", workspaceRef: "ws_1", customerRef: "cus_1" });
  });

  it("knows a voided invoice, and a waiting change that ran out with what the subscription carries now", () => {
    const { provider } = fake();
    expect(send(provider, "evt_2", "invoice.voided", paid)).toEqual({ eventId: "evt_2", type: "invoice.voided", providerRef: "in_1", subscriptionRef: SUB });
    expect(send(provider, "evt_3", "customer.subscription.pending_update_expired", baseSub())).toEqual({ eventId: "evt_3", type: "subscription.update_expired", providerRef: SUB, subscriptionRef: SUB, itemRefs: ["price_plan", "price_extra"] });
  });

  it("ignores an invoice that belongs to no subscription, an event of the wrong mode, and a forged signature", () => {
    const { provider } = fake();
    expect(send(provider, "evt_4", "invoice.paid", { ...paid, parent: null })).toBeUndefined();
    expect(send(provider, "evt_5", "invoice.paid", paid, true)).toBeUndefined();
    expect(() => provider.parseWebhook(evt("evt_6", "invoice.paid", paid), { "stripe-signature": "t=1,v1=bad" })).toThrow();
  });
});

describe("one bill through the whole app on Stripe", () => {
  async function app(updated: unknown) {
    const clock = { d: new Date("2026-11-10T09:00:00Z") };
    const f = fake({ updated });
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d, payments: f.provider });
    const handle = createApp(platform);
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, raw?: string) => handle({ method, path, query: new URLSearchParams(), headers, rawBody: raw ?? (body === undefined ? "" : JSON.stringify(body)) } as Req);
    const signed = await call("POST", "/api/signup", { email: "ann@kestrel.co", businessName: "Kestrel Coffee", sells: "Coffee", size: "2–10", country: "GB" });
    const ann = { authorization: `Bearer ${(signed.body as any).token}` };
    const ws = (signed.body as any).workspaceId as string;
    const owner = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(OWNER), e: OWNER }, 7 * 86400, clock.d.getTime())}` };
    await call("POST", "/api/owner/prices/changes", { general: { oneMonthlyBill: 1 } }, owner);
    // The plan is bought at Stripe Checkout and the signed completed event names the subscription.
    const plan = ((await call("POST", "/api/checkout", { lines: [{ key: TEAM_PACKAGE_KEY }] }, ann)).body as any).order;
    const ref = platform.payments.all().find((o) => o.id === plan.id)!.providerRef!;
    const done = evt("evt_done", "checkout.session.completed", { id: ref, client_reference_id: plan.id, metadata: { orderId: plan.id }, payment_status: "paid", amount_total: 15000, currency: "gbp", subscription: SUB, customer: "cus_1" });
    await call("POST", "/api/payments/webhook", undefined, { "stripe-signature": sign(done) }, done);
    const hook = (id: string, type: string, object: unknown) => { const raw = evt(id, type, object); return call("POST", "/api/payments/webhook", undefined, { "stripe-signature": sign(raw) }, raw); };
    const team = async () => ((await call("GET", "/api/org", undefined, ann)).body as any).team.length as number;
    const addOn = (((await call("GET", "/api/store")).body as any).catalogue as { key: string; kind: string }[]).find((i) => i.kind === "employee")!;
    return { ...f, call, ann, ws, plan, platform, hook, team, addOn };
  }
  const waiting = () => baseSub({ metadata: { orderId: "order_plan", workspaceId: "ws_1" }, pending_update: { expires_at: 1_790_086_400, subscription_items: [] }, latest_invoice: invoice({ status: "open" }) });

  it("adds the employee only when Stripe's signed paid-invoice event arrives, and a repeat or a stranger's event changes nothing", async () => {
    const s = await app(waiting());
    // The fake knows the plan under the real ids of this run.
    (s.provider as any).stripe.subscriptions.retrieve = async () => baseSub({ metadata: { orderId: s.plan.id, workspaceId: s.ws } });
    const r = await s.call("POST", "/api/checkout", { lines: [{ key: s.addOn.key }], addToBill: true }, s.ann);
    const order = (r.body as any).order;
    const inv = { id: "in_1", amount_paid: 1250, currency: "gbp", customer: "cus_1", lines: { data: [{ pricing: { price_details: { price: "price_new_0" } } }] }, parent: { type: "subscription_details", subscription_details: { subscription: SUB, metadata: { workspaceId: s.ws } } } };
    const stranger = { ...inv, id: "in_stranger", parent: { type: "subscription_details", subscription_details: { subscription: "sub_somebody_else", metadata: { workspaceId: "ws_other" } } } };

    const before = await s.team();
    const ignored = await s.hook("evt_s", "invoice.paid", stranger);
    const first = await s.hook("evt_p1", "invoice.paid", inv);
    const again = await s.hook("evt_p2", "invoice.paid", inv);

    expect(r.status).toBe(201);
    expect((r.body as any).url).toBe("https://invoice.stripe.test/i/1");
    expect(order).toMatchObject({ status: "pending", addedToBill: true });
    expect(s.calls.updates).toHaveLength(1);
    expect(before).toBe(6);
    expect((ignored.body as any).result).toBe("ignored");
    expect((first.body as any).result).toBe("ok");
    expect((again.body as any).result).toBe("ignored");
    expect(await s.team()).toBe(7);
  });

  it("opens an ordinary Checkout when Stripe refuses the change, so the client can always buy", async () => {
    const s = await app(waiting());
    (s.provider as any).stripe.subscriptions.retrieve = async () => baseSub({ metadata: { orderId: s.plan.id, workspaceId: s.ws }, status: "past_due" });

    const r = await s.call("POST", "/api/checkout", { lines: [{ key: s.addOn.key }], addToBill: true }, s.ann);

    expect(r.status).toBe(201);
    expect((r.body as any).url).toBe("https://checkout.stripe.test/pay");
    expect((r.body as any).addedToBill).toBeUndefined();
    expect(s.calls.updates).toEqual([]);
  });
});
