import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform, paidThrough } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { MockPaymentProvider } from "../src/modules/payments/index.js";
import { CATALOGUE, TEAM_PACKAGE_KEY, quote, quoteForPlan } from "../src/modules/store/cart.js";

const OWNER = "atif@maiz.test";
const ANN = "ann@kestrel.co";

function setup() {
  const clock = { d: new Date("2026-11-10T09:00:00Z") };
  const provider = new MockPaymentProvider();
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d, payments: provider });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const tokenFor = (email: string) => ({ authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(email), e: email }, 7 * 86400, clock.d.getTime())}` });
  const signUp = async () => {
    const r = await call("POST", "/api/signup", { email: ANN, businessName: "Kestrel Coffee", sells: "Coffee", size: "2–10", country: "GB" });
    return { ann: { authorization: `Bearer ${(r.body as any).token}` }, ws: (r.body as any).workspaceId as string };
  };
  const item = async (kind: string) => (((await call("GET", "/api/store")).body as any).catalogue as { key: string; kind: string; priceGbp: number }[]).find((i) => i.kind === kind)!;
  return { platform, provider, call, clock, tokenFor, signUp, item };
}

describe("pricing a cart for the client's plan", () => {
  it("adds the Team package to a trial client's first monthly order, once, and leaves a consultant pass alone", () => {
    const addOn = CATALOGUE.find((i) => i.kind === "employee")!;
    const pass = CATALOGUE.find((i) => i.kind === "consultant")!;

    const first = quoteForPlan([{ key: addOn.key, qty: 2 }], false);
    const passOnly = quoteForPlan([{ key: pass.key }], false);
    const twice = quote([{ key: TEAM_PACKAGE_KEY, qty: 3 }, { key: TEAM_PACKAGE_KEY }]);

    expect(first.lines.map((l) => l.key)).toEqual([TEAM_PACKAGE_KEY, addOn.key]);
    expect(first.monthlyGbp).toBe(150 + addOn.priceGbp * 2);
    expect(passOnly.lines.map((l) => l.key)).toEqual([pass.key]);
    expect(twice.lines).toEqual([expect.objectContaining({ key: TEAM_PACKAGE_KEY, qty: 1, totalGbp: 150 })]);
  });

  it("never sells the Team package twice, and prices add-ons on their own for a paying client", () => {
    const addOn = CATALOGUE.find((i) => i.kind === "employee")!;

    const q = quoteForPlan([{ key: TEAM_PACKAGE_KEY }, { key: addOn.key }], true);

    expect(q.lines.map((l) => l.key)).toEqual([addOn.key]);
    expect(q.rejected).toEqual([{ key: TEAM_PACKAGE_KEY, reason: "you already have the Team package" }]);
  });

  it("works out the end of the month that was paid for", () => {
    expect(paidThrough("2026-11-10T09:00:00Z", new Date("2026-11-20T00:00:00Z")).toISOString()).toBe("2026-12-10T09:00:00.000Z");
    expect(paidThrough("2026-11-10T09:00:00Z", new Date("2027-01-15T00:00:00Z")).toISOString()).toBe("2027-02-10T09:00:00.000Z");
  });

  it("ends a month paid for on the 31st on the last day of a shorter month, not some days into the next", () => {
    expect(paidThrough("2026-01-31T09:00:00Z", new Date("2026-02-10T00:00:00Z")).toISOString()).toBe("2026-02-28T09:00:00.000Z");
    expect(paidThrough("2026-01-31T09:00:00Z", new Date("2026-03-05T00:00:00Z")).toISOString()).toBe("2026-03-31T09:00:00.000Z");
  });
});

describe("buying the Team package", () => {
  it("ends the trial and starts the paid plan without hiring anyone new", async () => {
    const s = setup();
    const { ann, ws } = await s.signUp();
    const before = ((await s.call("GET", "/api/org", undefined, ann)).body as any).team.length;

    const r = await s.call("POST", "/api/checkout", { lines: [{ key: TEAM_PACKAGE_KEY }] }, ann);

    const org = (await s.call("GET", "/api/org", undefined, ann)).body as any;
    expect(r.status).toBe(201);
    expect((r.body as any).order).toMatchObject({ status: "paid", dueTodayMinor: 15_000, monthlyMinor: 15_000, employeeIds: [] });
    expect(org.team).toHaveLength(before);
    expect(org).toMatchObject({ hasTeamPackage: true, planEnded: false });
    expect(org.trialEndsAt).toBeUndefined();
    expect(s.platform.energy.onTrial(ws)).toBe(false);
  });

  it("is added to a trial client's first add-on order and shown in their quote before they pay", async () => {
    const s = setup();
    const { ann } = await s.signUp();
    const addOn = await s.item("employee");

    const mine = (await s.call("POST", "/api/cart/quote", { lines: [{ key: addOn.key }] }, ann)).body as any;
    const anyone = (await s.call("POST", "/api/cart/quote", { lines: [{ key: addOn.key }] })).body as any;
    const order = ((await s.call("POST", "/api/checkout", { lines: [{ key: addOn.key }] }, ann)).body as any).order;

    expect(mine).toMatchObject({ hasTeamPackage: false, dueTodayGbp: 150 + addOn.priceGbp });
    expect(mine.lines.map((l: any) => l.key)).toEqual([TEAM_PACKAGE_KEY, addOn.key]);
    expect(anyone.lines.map((l: any) => l.key)).toEqual([addOn.key]);
    expect(order.dueTodayMinor).toBe((150 + addOn.priceGbp) * 100);
    expect(order.employeeIds).toHaveLength(1);
  });

  it("cannot be bought twice, and a later add-on costs only its own price", async () => {
    const s = setup();
    const { ann } = await s.signUp();
    const addOn = await s.item("employee");
    await s.call("POST", "/api/checkout", { lines: [{ key: TEAM_PACKAGE_KEY }] }, ann);

    const again = await s.call("POST", "/api/checkout", { lines: [{ key: TEAM_PACKAGE_KEY }] }, ann);
    const later = ((await s.call("POST", "/api/checkout", { lines: [{ key: addOn.key }] }, ann)).body as any).order;

    expect(again.status).toBe(400);
    expect((again.body as any).error).toMatch(/already have the Team package/);
    expect(later.dueTodayMinor).toBe(addOn.priceGbp * 100);
  });

  it("is not needed for a consultant pass, which leaves the trial running", async () => {
    const s = setup();
    const { ann, ws } = await s.signUp();
    const pass = await s.item("consultant");

    const order = ((await s.call("POST", "/api/checkout", { lines: [{ key: pass.key }] }, ann)).body as any).order;

    expect(order.dueTodayMinor).toBe(pass.priceGbp * 100);
    expect(s.platform.energy.onTrial(ws)).toBe(true);
  });

  it("follows the price the platform owner sets for the basic package", async () => {
    const s = setup();
    const { ann } = await s.signUp();
    const owner = s.tokenFor(OWNER);
    const saved = await s.call("POST", "/api/owner/prices/changes", { general: { basicPackageMonthlyGbp: 120 } }, owner);

    const q = (await s.call("POST", "/api/cart/quote", { lines: [{ key: TEAM_PACKAGE_KEY }] }, ann)).body as any;

    expect(saved.status, JSON.stringify(saved.body)).toBeLessThan(300);
    expect(q.dueTodayGbp).toBe(120);
  });
});

describe("cancelling the Team package", () => {
  it("lets the team work to the end of the month paid for, then pauses, and buying it again restarts the plan", async () => {
    const s = setup();
    const { ann, ws } = await s.signUp();
    const order = ((await s.call("POST", "/api/checkout", { lines: [{ key: TEAM_PACKAGE_KEY }] }, ann)).body as any).order;
    s.platform.energy.addTopUp(ws, 500, 5, "test");
    s.clock.d = new Date("2026-11-12T09:00:00Z");

    const cancelled = await s.call("POST", `/api/orders/${order.id}/cancel`, {}, s.tokenFor(ANN));

    const org = (await s.call("GET", "/api/org", undefined, s.tokenFor(ANN))).body as any;
    expect(cancelled.status).toBe(200);
    expect(org).toMatchObject({ planEnded: true, trialEndsAt: "2026-12-10T09:00:00.000Z" });
    expect(s.platform.energy.onTrial(ws)).toBe(true);
    expect(s.platform.notices.list(userIdFor(ANN), ws).notices[0]!.title).toMatch(/Team package has been cancelled/);

    s.clock.d = new Date("2026-12-11T09:00:00Z");
    const later = s.tokenFor(ANN);
    // A plan that was paid for and then cancelled is not called a free trial.
    expect(s.platform.energy.check(ws, org.team[0].id)).toEqual({ allowed: false, reason: "plan_ended" });
    expect(((await s.call("POST", "/api/cart/quote", { lines: [{ key: TEAM_PACKAGE_KEY }] }, later)).body as any).hasTeamPackage).toBe(false);
    const again = await s.call("POST", "/api/checkout", { lines: [{ key: TEAM_PACKAGE_KEY }] }, later);
    expect(again.status).toBe(201);
    expect(s.platform.energy.onTrial(ws)).toBe(false);
    // Top-up energy the client bought before cancelling is still theirs.
    expect(s.platform.energy.topUpLeft(ws)).toBe(500);
  });
});

describe("two open checkouts for the Team package", () => {
  it("closes the older unpaid one, so the package can never be paid for twice", async () => {
    const clock = { d: new Date("2026-11-10T09:00:00Z") };
    const provider = new MockPaymentProvider({ mode: "manual" });
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d, payments: provider });
    const handle = createApp(platform);
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
    const signed = await call("POST", "/api/signup", { email: ANN, businessName: "Kestrel Coffee", sells: "Coffee", size: "2–10", country: "GB" });
    const ann = { authorization: `Bearer ${(signed.body as any).token}` };

    const first = ((await call("POST", "/api/checkout", { lines: [{ key: TEAM_PACKAGE_KEY }] }, ann)).body as any).order;
    const second = ((await call("POST", "/api/checkout", { lines: [{ key: TEAM_PACKAGE_KEY }] }, ann)).body as any).order;

    const orders = ((await call("GET", "/api/orders", undefined, ann)).body as any).orders as { id: string; status: string }[];
    expect(orders.find((o) => o.id === first.id)!.status).toBe("failed");
    expect(orders.find((o) => o.id === second.id)!.status).toBe("pending");
    expect(provider.cancelled).toContain(first.providerRef ?? platform.payments.all().find((o) => o.id === first.id)!.providerRef);
  });
});
