import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { MockPaymentProvider, type Order, type ProviderEvent } from "../src/modules/payments/index.js";
import { TEAM_PACKAGE_KEY } from "../src/modules/store/cart.js";

const OWNER = "atif@maiz.test";
const ANN = "ann@kestrel.co";
const SHOP = "dropshipping-agent";

function setup(mode: "auto" | "manual" = "auto") {
  const clock = { d: new Date("2026-11-10T09:00:00Z") };
  const provider = new MockPaymentProvider({ mode });
  const email = new MemoryEmailSender();
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email, appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d, payments: provider });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, rawBody?: string) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: rawBody ?? (body === undefined ? "" : JSON.stringify(body)) } as Req);
  const tokenFor = (who: string) => ({ authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(who), e: who }, 7 * 86400, clock.d.getTime())}` });
  const signUp = async () => {
    const r = await call("POST", "/api/signup", { email: ANN, businessName: "Kestrel Coffee", sells: "Coffee", size: "2–10", country: "GB" });
    return { auth: { authorization: `Bearer ${(r.body as any).token}` }, ws: (r.body as any).workspaceId as string };
  };
  const addOn = async () => (((await call("GET", "/api/store")).body as any).catalogue as { key: string; kind: string; title: string }[]).find((i) => i.kind === "employee" && i.key !== SHOP)!;
  const hook = (event: ProviderEvent) => { const w = provider.signedWebhook(event); return call("POST", "/api/payments/webhook", undefined, w.headers, w.rawBody); };
  const buy = async (auth: Record<string, string>, lines: unknown[], extra: Record<string, unknown> = {}) => {
    const r = await call("POST", "/api/checkout", { lines, ...extra }, auth);
    return { status: r.status, body: r.body as any, order: (r.body as any).order as any };
  };
  const order = (id: string) => platform.payments.all().find((o) => o.id === id)!;
  const team = async (auth: Record<string, string>) => ((await call("GET", "/api/org", undefined, auth)).body as any).team as { id: string; templateKey: string }[];
  const switchOn = () => call("POST", "/api/owner/prices/changes", { general: { oneMonthlyBill: 1 } }, tokenFor(OWNER));
  /** In manual mode the provider's signed event pays an order and names its subscription. */
  const payByHook = (id: string, subscriptionRef: string) =>
    hook({ type: "payment.succeeded", orderId: id, providerRef: order(id).providerRef!, subscriptionRef, customerRef: "cus_1", eventId: `evt_pay_${id}` });
  const mails = (re: RegExp) => email.sent.filter((m) => re.test(m.subject));
  return { platform, provider, call, clock, signUp, addOn, hook, buy, order, team, switchOn, payByHook, mails };
}

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  let enter!: () => void;
  const entered = new Promise<void>((r) => { enter = r; });
  return { open, opened, enter, entered };
};

describe("a double press on 'add to my bill'", () => {
  it("charges and hires once: the second press is told to wait and the first order is not failed behind its back", async () => {
    const s = setup("auto");
    const { auth } = await s.signUp();
    const extra = await s.addOn();
    await s.switchOn();
    await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }]);
    const g = gate();
    const real = s.provider.addToSubscription.bind(s.provider);
    s.provider.addToSubscription = async (req) => { g.enter(); await g.opened; return real(req); };

    const first = s.buy(auth, [{ key: extra.key }], { addToBill: true });
    await g.entered;
    const second = await s.buy(auth, [{ key: extra.key }], { addToBill: true });
    g.open();
    const done = await first;

    expect(second.status).toBe(400);
    expect(second.body.error).toBe("Your last change is still going through. Give it a moment.");
    expect(done.status).toBe(201);
    expect(done.order).toMatchObject({ status: "paid" });
    expect(done.order.employeeIds).toHaveLength(1);
    expect(s.provider.added).toHaveLength(1);
    expect(s.platform.payments.all().filter((o) => o.status === "failed")).toEqual([]);
    expect(await s.team(auth)).toHaveLength(7);
  });

  it("lets the client buy again once the first has finished", async () => {
    const s = setup("auto");
    const { auth } = await s.signUp();
    const [a, b] = ((await s.call("GET", "/api/store")).body as any).catalogue.filter((i: any) => i.kind === "employee" && i.key !== SHOP) as { key: string }[];
    await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }]);

    const one = await s.buy(auth, [{ key: a!.key }]);
    const two = await s.buy(auth, [{ key: b!.key }]);

    expect([one.status, two.status]).toEqual([201, 201]);
  });

  it("leaves an addition alone while its provider call is still out, even when the plan is cancelled meanwhile", async () => {
    const s = setup("auto");
    const { auth } = await s.signUp();
    const extra = await s.addOn();
    await s.switchOn();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    const g = gate();
    const real = s.provider.addToSubscription.bind(s.provider);
    s.provider.addToSubscription = async (req) => { g.enter(); await g.opened; return real(req); };

    const pending = s.buy(auth, [{ key: extra.key }], { addToBill: true });
    await g.entered;
    const inFlight = s.platform.payments.all().find((o) => o.addedTo)!;
    await s.call("POST", `/api/orders/${plan.id}/cancel`, {}, auth);
    const during = s.order(inFlight.id).status;
    g.open();
    await pending;

    expect(during).toBe("pending");
  });

  it("never hires for a failed addition that is paid later, and tells the platform owner", async () => {
    const s = setup("manual");
    const { auth, ws } = await s.signUp();
    const extra = await s.addOn();
    await s.switchOn();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    await s.payByHook(plan.id, "sub_plan_ann");
    const added = await s.buy(auth, [{ key: extra.key }], { addToBill: true });
    const o = s.order(added.order.id);

    await s.hook({ type: "invoice.voided", providerRef: o.providerRef!, subscriptionRef: "sub_plan_ann", eventId: "evt_void" });
    await s.hook({ type: "invoice.paid", providerRef: o.providerRef!, subscriptionRef: "sub_plan_ann", itemRefs: o.itemRefs, workspaceRef: ws, amountMinor: o.dueTodayMinor, currency: "gbp", eventId: "evt_late" });

    expect(s.order(o.id)).toMatchObject({ status: "failed", employeeIds: [] });
    expect(s.order(o.id).paidAt).toBeUndefined();
    expect(await s.team(auth)).toHaveLength(6);
    expect(s.mails(/Paid a failed order/)).toHaveLength(1);
  });
});

describe("two open checkouts for a once-only shop employee", () => {
  it("closes the older unpaid one, so only the newer can be paid and the client pays monthly for one employee", async () => {
    const s = setup("manual");
    const { auth } = await s.signUp();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    await s.payByHook(plan.id, "sub_plan_ann");

    const first = (await s.buy(auth, [{ key: SHOP }])).order;
    const second = (await s.buy(auth, [{ key: SHOP }])).order;
    await s.payByHook(first.id, "sub_first");
    const stale = await s.team(auth);
    await s.payByHook(second.id, "sub_second");

    expect(s.order(first.id)).toMatchObject({ status: "failed", employeeIds: [] });
    expect(s.provider.cancelled).toContain(s.order(first.id).providerRef);
    expect(stale).toHaveLength(6);
    expect(s.mails(/Paid a failed order/)).toHaveLength(1);
    expect(s.order(second.id).employeeIds).toHaveLength(1);
    expect((await s.team(auth)).filter((e) => e.templateKey === SHOP)).toHaveLength(1);
  });

  it("also closes an addition to the bill that is still waiting for the same employee", async () => {
    const s = setup("manual");
    const { auth } = await s.signUp();
    await s.switchOn();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    await s.payByHook(plan.id, "sub_plan_ann");
    const waiting = (await s.buy(auth, [{ key: SHOP }], { addToBill: true })).order;

    const later = (await s.buy(auth, [{ key: SHOP }])).order;

    expect(s.order(waiting.id).addedTo).toBe(plan.id);
    expect(s.order(waiting.id).status).toBe("failed");
    expect(s.order(later.id).status).toBe("pending");
  });
});

describe("which employee a line hired", () => {
  it("is recorded per line when the order is paid", async () => {
    const s = setup("auto");
    const { auth } = await s.signUp();
    const extra = await s.addOn();

    const bought = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }, { key: extra.key, qty: 2 }])).order;

    const stored = s.order(bought.id);
    expect(stored.employeeIds).toHaveLength(2);
    expect(stored.hiredBy).toEqual({ [extra.key]: stored.employeeIds });
  });

  it("takes the right employee off the team when an earlier line hired nobody", async () => {
    const s = setup("auto");
    const { auth, ws } = await s.signUp();
    const extra = await s.addOn();
    const hired = await s.platform.workforce.hire(userIdFor(ANN), ws, extra.key);
    const stoppedAt = { at: "2026-10-01T00:00:00.000Z", endsAt: "2026-11-01T00:00:00.000Z", by: "client" as const };
    const line = (key: string) => ({ key, title: key, qty: 1, unitMinor: 1000, billing: "monthly" as const });
    // A shop line that was skipped (the client already had that employee), then a line that hired one.
    const restored: Order = {
      id: "order_restored", workspaceId: ws, userId: userIdFor(ANN), lines: [line(SHOP), line(extra.key)], monthlyMinor: 2000, dueTodayMinor: 2000, currency: "GBP",
      status: "cancelled", provider: "mock", createdAt: "2026-10-01T00:00:00.000Z", paidAt: "2026-10-01T00:00:00.000Z", fulfilledAt: "2026-10-01T00:00:00.000Z",
      employeeIds: [hired.id], hiredBy: { [SHOP]: [], [extra.key]: [hired.id] }, stops: { [SHOP]: stoppedAt, [extra.key]: stoppedAt },
    };
    s.platform.payments.restore(restored);

    await s.platform.payments.sweep();

    expect((await s.team(auth)).some((e) => e.id === hired.id)).toBe(false);
    expect(s.platform.payments.all().find((o) => o.id === restored.id)!.stops![extra.key]!.releasedAt).toBeDefined();
  });

  it("still works out an older order, which has no per-line record, by the order the lines were hired in", async () => {
    const s = setup("auto");
    const { auth, ws } = await s.signUp();
    const extra = await s.addOn();
    const hired = await s.platform.workforce.hire(userIdFor(ANN), ws, extra.key);
    const stoppedAt = { at: "2026-10-01T00:00:00.000Z", endsAt: "2026-11-01T00:00:00.000Z", by: "client" as const };
    const old: Order = {
      id: "order_old", workspaceId: ws, userId: userIdFor(ANN), lines: [{ key: TEAM_PACKAGE_KEY, title: "Team", qty: 1, unitMinor: 15000, billing: "monthly" }, { key: extra.key, title: extra.key, qty: 1, unitMinor: 1000, billing: "monthly" }],
      monthlyMinor: 16000, dueTodayMinor: 16000, currency: "GBP", status: "cancelled", provider: "mock", createdAt: "2026-10-01T00:00:00.000Z", paidAt: "2026-10-01T00:00:00.000Z", fulfilledAt: "2026-10-01T00:00:00.000Z",
      employeeIds: [hired.id], stops: { [extra.key]: stoppedAt },
    };
    s.platform.payments.restore(old);

    await s.platform.payments.sweep();

    expect((await s.team(auth)).some((e) => e.id === hired.id)).toBe(false);
  });
});

describe("a double press on Stop", () => {
  it("asks the provider once, raises no alert, and the second press just gets the current state", async () => {
    const s = setup("auto");
    const { auth } = await s.signUp();
    const extra = await s.addOn();
    await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }]);
    const added = (await s.buy(auth, [{ key: extra.key }])).order;
    const g = gate();
    let calls = 0;
    const real = s.provider.cancelSubscription.bind(s.provider);
    s.provider.cancelSubscription = async (ref) => { calls++; g.enter(); await g.opened; return real(ref); };
    const stop = () => s.call("POST", "/api/billing/lines/stop", { orderId: added.id, key: extra.key }, auth);

    const first = stop();
    await g.entered;
    const second = await stop();
    g.open();
    const done = await first;

    expect(second.status).toBe(200);
    expect(done.status).toBe(200);
    expect(calls).toBe(1);
    expect(s.mails(/could not be stopped/i)).toEqual([]);
    expect(s.order(added.id).stops?.[extra.key]).toMatchObject({ by: "client" });
  });
});

describe("stopping an order whose subscription was never learned", () => {
  /** A paid monthly order that only knows its checkout session. */
  async function withSessionOnly() {
    const s = setup("auto");
    const { auth, ws } = await s.signUp();
    const extra = await s.addOn();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    const only: Order = {
      id: "order_session_only", workspaceId: ws, userId: userIdFor(ANN), lines: [{ key: extra.key, title: extra.title, qty: 1, unitMinor: 2500, billing: "monthly" }], monthlyMinor: 2500, dueTodayMinor: 2500, currency: "GBP",
      status: "paid", provider: "mock", providerRef: "cs_test_only", createdAt: "2026-11-10T09:00:00.000Z", paidAt: "2026-11-10T09:00:00.000Z", fulfilledAt: "2026-11-10T09:00:00.000Z", employeeIds: [],
    };
    s.platform.payments.restore(only);
    return { s, auth, extra, plan, only };
  }

  it("refuses to stop the line, says why, and never pretends it was stopped", async () => {
    const { s, auth, extra, only } = await withSessionOnly();

    const r = await s.call("POST", "/api/billing/lines/stop", { orderId: only.id, key: extra.key }, auth);

    expect(r.status).toBe(400);
    expect((r.body as any).error).toMatch(/could not stop this/i);
    expect(s.order(only.id).status).toBe("paid");
    expect(s.order(only.id).stops).toBeUndefined();
    expect(s.provider.cancelled).not.toContain("cs_test_only");
    expect(s.mails(/cannot be stopped from here/)).toHaveLength(1);
  });

  it("refuses to cancel the order the same way", async () => {
    const { s, auth, only } = await withSessionOnly();

    const r = await s.call("POST", `/api/orders/${only.id}/cancel`, {}, auth);

    expect(r.status).toBe(400);
    expect(s.order(only.id).status).toBe("paid");
    expect(s.provider.cancelled).not.toContain("cs_test_only");
  });

  it("keeps it as still wanted when the Team package is cancelled, tells the owner once, and does not expire the session", async () => {
    const { s, auth, plan, only } = await withSessionOnly();

    await s.call("POST", `/api/orders/${plan.id}/cancel`, {}, auth);
    s.clock.d = new Date("2026-11-10T10:00:00Z");
    await s.platform.payments.sweep();

    expect(s.order(only.id)).toMatchObject({ status: "paid" });
    expect(s.order(only.id).stopWanted).toBeDefined();
    expect(s.provider.cancelled).not.toContain("cs_test_only");
    expect(s.mails(/cannot be stopped from here/)).toHaveLength(1);
  });
});
