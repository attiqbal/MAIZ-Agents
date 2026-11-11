import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { MockPaymentProvider } from "../src/modules/payments/index.js";
import { checkEnv } from "../src/server/config.js";

function setup(provider?: MockPaymentProvider, dev = true) {
  const clock = { d: new Date("2026-11-10T09:00:00Z") };
  const mail = new MemoryEmailSender();
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: dev, email: mail, appUrl: "https://app.test", platformOwners: ["atif@maiz.test"], now: () => clock.d, payments: provider });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, rawBody?: string) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: rawBody ?? (body === undefined ? "" : JSON.stringify(body)) } as Req);
  const signUp = async (email: string, name: string) => {
    const r = await call("POST", "/api/signup", { email, businessName: name, sells: "Coffee", size: "2–10", country: "GB" });
    return { authorization: `Bearer ${(r.body as any).token}` };
  };
  return { platform, call, signUp, mail, clock };
}

const CART = [{ key: "operations-manager", qty: 1 }];

describe("checkout with a mock provider", () => {
  it("prices on the server, takes payment, hires what was bought, and keeps a record", async () => {
    const provider = new MockPaymentProvider();
    const s = setup(provider);
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const item = ((await s.call("GET", "/api/store")).body as any).catalogue.find((i: any) => i.kind === "employee");
    const before = ((await s.call("GET", "/api/org", undefined, ann)).body as any).team.length;
    // A price in the request is ignored: only keys and quantities count.
    const r = await s.call("POST", "/api/checkout", { lines: [{ key: item.key, qty: 2, priceGbp: 0 }] }, ann);
    expect(r.status).toBe(201);
    const order = (r.body as any).order;
    expect(order).toMatchObject({ status: "paid", dueTodayMinor: item.priceGbp * 200, monthlyMinor: item.priceGbp * 200 });
    expect(order.employeeIds).toHaveLength(2);
    expect(JSON.stringify(order)).not.toContain("mock_");
    expect(provider.requests[0]).toMatchObject({ currency: "GBP", dueTodayMinor: item.priceGbp * 200 });
    expect(((await s.call("GET", "/api/org", undefined, ann)).body as any).team.length).toBe(before + 2);
    expect(((await s.call("GET", "/api/orders", undefined, ann)).body as any).orders).toHaveLength(1);
  });

  it("refuses empty carts, unknown items, core roles and other clients' orders", async () => {
    const s = setup(new MockPaymentProvider());
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const bob = await s.signUp("bob@northside.co", "Northside Bikes");
    expect((await s.call("POST", "/api/checkout", { lines: [] }, ann)).status).toBe(400);
    expect((await s.call("POST", "/api/checkout", { lines: [{ key: "no-such-thing" }] }, ann)).status).toBe(400);
    expect((await s.call("POST", "/api/checkout", { lines: [{ key: "admin-manager" }] }, ann)).status).toBe(400);
    expect((await s.call("POST", "/api/checkout", { lines: CART }, undefined as any)).status).toBe(401);
    const item = ((await s.call("GET", "/api/store")).body as any).catalogue[0];
    const id = ((await s.call("POST", "/api/checkout", { lines: [{ key: item.key }] }, ann)).body as any).order.id;
    expect((await s.call("POST", `/api/orders/${id}/cancel`, undefined, bob)).status).toBe(400);
    expect(((await s.call("GET", "/api/orders", undefined, bob)).body as any).orders).toHaveLength(0);
  });

  it("is switched off with no provider: nothing can be bought", async () => {
    const s = setup(undefined, false);
    expect(s.platform.payments.enabled).toBe(false);
    const uid = userIdFor("ann@kestrel.co");
    const org = await s.platform.onboarding.signUp(uid, { ownerEmail: "ann@kestrel.co", businessName: "Kestrel", businessType: "cafe", description: "Coffee", country: "GB", teamSize: "2-10", addOns: [], contact: "dashboard" });
    await expect(s.platform.payments.checkout(uid, org.workspaceId, [{ key: "x" }])).rejects.toThrow(/not switched on/);
    expect((await s.call("POST", "/api/payments/webhook", undefined, {}, "{}")).status).toBe(503);
  });
});

describe("a payment that finishes later, by webhook", () => {
  it("waits for a correctly signed webhook, hires once, and ignores replays and forgeries", async () => {
    const provider = new MockPaymentProvider({ mode: "manual" });
    const s = setup(provider);
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const item = ((await s.call("GET", "/api/store")).body as any).catalogue.find((i: any) => i.kind === "employee");
    const before = ((await s.call("GET", "/api/org", undefined, ann)).body as any).team.length;
    const r = await s.call("POST", "/api/checkout", { lines: [{ key: item.key }] }, ann);
    const order = (r.body as any).order;
    expect(order.status).toBe("pending");
    expect((r.body as any).url).toContain("https://app.test/");
    const ref = provider.requests[0]!.orderId;
    expect(ref).toBe(order.id);

    const forged = await s.call("POST", "/api/payments/webhook", undefined, { "x-mock-signature": "00" }, JSON.stringify({ type: "payment.succeeded", orderId: order.id, providerRef: "x" }));
    expect(forged.status).toBe(400);
    expect(((await s.call("GET", "/api/orders", undefined, ann)).body as any).orders[0].status).toBe("pending");

    const hook = provider.signedWebhook({ type: "payment.succeeded", orderId: order.id, providerRef: "x" });
    expect((await s.call("POST", "/api/payments/webhook", undefined, hook.headers, hook.rawBody)).status).toBe(200);
    expect((await s.call("POST", "/api/payments/webhook", undefined, hook.headers, hook.rawBody)).status).toBe(200); // replay
    expect(((await s.call("GET", "/api/orders", undefined, ann)).body as any).orders[0]).toMatchObject({ status: "paid" });
    expect(((await s.call("GET", "/api/org", undefined, ann)).body as any).team.length).toBe(before + 1);
  });

  it("marks a declined payment failed and hires nothing; a cancelled order tells the provider", async () => {
    const provider = new MockPaymentProvider();
    const s = setup(provider);
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const item = ((await s.call("GET", "/api/store")).body as any).catalogue.find((i: any) => i.kind === "employee");
    provider.failNext = true;
    const failed = await s.call("POST", "/api/checkout", { lines: [{ key: item.key }] }, ann);
    expect((failed.body as any).order).toMatchObject({ status: "failed", employeeIds: [] });
    const paid = (await s.call("POST", "/api/checkout", { lines: [{ key: item.key }] }, ann)).body as any;
    const cancelled = await s.call("POST", `/api/orders/${paid.order.id}/cancel`, undefined, ann);
    expect((cancelled.body as any).order.status).toBe("cancelled");
    expect(provider.cancelled).toHaveLength(1);
  });

  it("tells the platform owner when a paid order cannot be fulfilled", async () => {
    const provider = new MockPaymentProvider();
    const s = setup(provider);
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const ws = s.platform.identity.workspacesFor(userIdFor("ann@kestrel.co"))[0]!;
    const orig = s.platform.workforce.hire.bind(s.platform.workforce);
    s.platform.workforce.hire = async () => { throw new Error("boom"); };
    const item = ((await s.call("GET", "/api/store")).body as any).catalogue.find((i: any) => i.kind === "employee");
    const r = await s.call("POST", "/api/checkout", { lines: [{ key: item.key }] }, ann);
    s.platform.workforce.hire = orig;
    expect((r.body as any).order.problem).toContain("MAIZ has been alerted");
    expect(s.mail.sent.some((m) => m.to === "atif@maiz.test" && m.subject.startsWith("Paid order needs you"))).toBe(true);
    expect(ws).toBeTruthy();
  });
});

describe("start-up checks", () => {
  it("rejects the mock provider in production and unknown providers anywhere", () => {
    expect(checkEnv({ PAYMENTS_PROVIDER: "mock" })).toEqual([]);
    expect(checkEnv({ PAYMENTS_PROVIDER: "stripe" }).join()).toContain("not built yet");
    expect(checkEnv({ NODE_ENV: "production", PAYMENTS_PROVIDER: "mock" }).join()).toContain("must not be used in production");
  });
});
