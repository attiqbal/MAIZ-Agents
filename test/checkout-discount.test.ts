import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { MockPaymentProvider } from "../src/modules/payments/index.js";
import { billDiscount, discountOf } from "../src/modules/promotions/index.js";

const OWNER = "atif@maiz.test";

function setup(mode: "auto" | "manual" = "auto") {
  const clock = { d: new Date("2026-11-10T09:00:00Z") };
  const provider = new MockPaymentProvider({ mode });
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d, payments: provider });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, rawBody?: string) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: rawBody ?? (body === undefined ? "" : JSON.stringify(body)) } as Req);
  const owner = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(OWNER), e: OWNER }, 7 * 86400, clock.d.getTime())}` };
  const signUp = async (email: string, name: string) => {
    const r = await call("POST", "/api/signup", { email, businessName: name, sells: "Coffee", size: "2–10", country: "GB" });
    return { authorization: `Bearer ${(r.body as any).token}` };
  };
  const coupon = (c: Record<string, unknown>) => call("POST", "/api/owner/coupons", c, owner);
  const catalogue = async () => ((await call("GET", "/api/store")).body as any).catalogue as { key: string; priceGbp: number; billing: string }[];
  return { platform, provider, call, clock, owner, signUp, coupon, catalogue };
}

describe("what a discount takes off an order", () => {
  it("is worked out on the monthly part only, never the one-off part", () => {
    expect(billDiscount(discountOf("percent_off", 20, { kind: "months", months: 3 })!, 15_000)).toEqual({ amountOffMinor: 3_000, months: 3 });
    expect(billDiscount(discountOf("fixed_off", 10, { kind: "once" })!, 15_000)).toEqual({ amountOffMinor: 1_000, months: 1 });
    expect(billDiscount(discountOf("percent_off", 50, { kind: "forever" })!, 2_500)).toEqual({ amountOffMinor: 1_250, months: "forever" });
    expect(billDiscount(discountOf("free_months", 2, { kind: "once" })!, 15_000)).toEqual({ amountOffMinor: 15_000, months: 2 });
  });

  it("never takes off more than the monthly amount, and gives nothing on a cart with no monthly line", () => {
    expect(billDiscount(discountOf("fixed_off", 500, { kind: "forever" })!, 15_000)).toEqual({ amountOffMinor: 15_000, months: "forever" });
    expect(billDiscount(discountOf("percent_off", 20, { kind: "once" })!, 0)).toBeUndefined();
  });
});

describe("a discount code at checkout", () => {
  it("comes off the first payment, is sent to the payment provider and is shown on the order", async () => {
    const s = setup();
    await s.coupon({ code: "WELCOME20", kind: "percent_off", value: 20, duration: { kind: "months", months: 3 } });
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    expect((await s.call("POST", "/api/coupons/redeem", { code: "welcome20" }, ann)).status).toBe(200);
    const items = await s.catalogue();
    const monthly = items.find((i) => i.billing === "monthly")!;
    const pass = items.find((i) => i.billing === "once")!;

    const r = await s.call("POST", "/api/checkout", { lines: [{ key: monthly.key }, { key: pass.key }] }, ann);

    expect(r.status).toBe(201);
    const off = Math.round(monthly.priceGbp * 100 * 0.2);
    const order = (r.body as any).order;
    expect(order.dueTodayMinor).toBe(monthly.priceGbp * 100 + pass.priceGbp * 100 - off);
    expect(order.discount).toMatchObject({ code: "WELCOME20", amountOffMinor: off, months: 3 });
    expect(s.provider.requests[0]).toMatchObject({ discount: { amountOffMinor: off }, discountMonths: 3, dueTodayMinor: order.dueTodayMinor });
  });

  it("is used once: a later order pays full price while the first keeps its discount", async () => {
    const s = setup();
    await s.coupon({ code: "TENOFF", kind: "fixed_off", value: 10, duration: { kind: "forever" } });
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    await s.call("POST", "/api/coupons/redeem", { code: "TENOFF" }, ann);
    const monthly = (await s.catalogue()).find((i) => i.billing === "monthly")!;
    const addOn = (await s.catalogue()).find((i) => (i as any).kind === "employee")!;

    const first = (await s.call("POST", "/api/checkout", { lines: [{ key: monthly.key }] }, ann)).body as any;
    const second = (await s.call("POST", "/api/checkout", { lines: [{ key: addOn.key }] }, ann)).body as any;

    expect(first.order.discount.amountOffMinor).toBe(1_000);
    expect(second.order.discount).toBeUndefined();
    expect(second.order.dueTodayMinor).toBe(addOn.priceGbp * 100);
  });

  it("stays waiting when the cart has nothing monthly, and the quote says what it will take off", async () => {
    const s = setup();
    await s.coupon({ code: "HALF", kind: "percent_off", value: 50, duration: { kind: "once" } });
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    await s.call("POST", "/api/coupons/redeem", { code: "HALF" }, ann);
    const items = await s.catalogue();
    const monthly = items.find((i) => i.billing === "monthly")!;
    const pass = items.find((i) => i.billing === "once")!;

    const once = (await s.call("POST", "/api/checkout", { lines: [{ key: pass.key }] }, ann)).body as any;
    const q = (await s.call("POST", "/api/cart/quote", { lines: [{ key: monthly.key }] }, ann)).body as any;

    expect(once.order.discount).toBeUndefined();
    expect(q.discount).toMatchObject({ code: "HALF", amountOffGbp: monthly.priceGbp / 2, months: 1 });
    expect(q.dueTodayGbp).toBe(monthly.priceGbp / 2);
    // Someone not signed in gets the plain quote.
    expect(((await s.call("POST", "/api/cart/quote", { lines: [{ key: monthly.key }] })).body as any).discount).toBeUndefined();
  });

  it("closes an unpaid checkout that held the same discount, so one code cannot discount two subscriptions", async () => {
    const s = setup("manual");
    await s.coupon({ code: "WELCOME20", kind: "percent_off", value: 20, duration: { kind: "forever" } });
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    await s.call("POST", "/api/coupons/redeem", { code: "WELCOME20" }, ann);
    const monthly = (await s.catalogue()).find((i) => i.billing === "monthly")!;

    const first = (await s.call("POST", "/api/checkout", { lines: [{ key: monthly.key }] }, ann)).body as any;
    const second = (await s.call("POST", "/api/checkout", { lines: [{ key: monthly.key }] }, ann)).body as any;
    const orders = ((await s.call("GET", "/api/orders", undefined, ann)).body as any).orders as any[];

    expect(second.order.discount).toBeDefined();
    expect(orders.find((o) => o.id === first.order.id).status).toBe("failed");
    expect(s.provider.cancelled).toHaveLength(1);
  });

  it("refuses a second discount while one is running, and allows a new code once it has run out", async () => {
    const s = setup();
    await s.coupon({ code: "ONCE10", kind: "fixed_off", value: 10, duration: { kind: "once" } });
    await s.coupon({ code: "LATER5", kind: "fixed_off", value: 5, duration: { kind: "once" } });
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    await s.call("POST", "/api/coupons/redeem", { code: "ONCE10" }, ann);
    const monthly = (await s.catalogue()).find((i) => i.billing === "monthly")!;
    await s.call("POST", "/api/checkout", { lines: [{ key: monthly.key }] }, ann);

    // While the discounted month runs, a second discount is refused.
    expect((await s.call("POST", "/api/coupons/redeem", { code: "LATER5" }, ann)).status).toBe(400);
    s.clock.d = new Date("2026-12-20T09:00:00Z");
    const later = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor("ann@kestrel.co"), e: "ann@kestrel.co" }, 7 * 86400, s.clock.d.getTime())}` };
    expect((await s.call("POST", "/api/coupons/redeem", { code: "LATER5" }, later)).status).toBe(200);
  });
});
