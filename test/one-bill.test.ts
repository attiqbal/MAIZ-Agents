import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { MockPaymentProvider, type ProviderEvent } from "../src/modules/payments/index.js";
import { TEAM_PACKAGE_KEY } from "../src/modules/store/cart.js";

const OWNER = "atif@maiz.test";
const ANN = "ann@kestrel.co";
const BOB = "bob@northside.co";

function setup(mode: "auto" | "manual" = "auto") {
  const clock = { d: new Date("2026-11-10T09:00:00Z") };
  const provider = new MockPaymentProvider({ mode });
  const email = new MemoryEmailSender();
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email, appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d, payments: provider });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, rawBody?: string) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: rawBody ?? (body === undefined ? "" : JSON.stringify(body)) } as Req);
  const tokenFor = (who: string) => ({ authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(who), e: who }, 7 * 86400, clock.d.getTime())}` });
  const signUp = async (who = ANN, name = "Kestrel Coffee") => {
    const r = await call("POST", "/api/signup", { email: who, businessName: name, sells: "Coffee", size: "2–10", country: "GB" });
    return { auth: { authorization: `Bearer ${(r.body as any).token}` }, ws: (r.body as any).workspaceId as string };
  };
  const addOns = async () => (((await call("GET", "/api/store")).body as any).catalogue as { key: string; kind: string; title: string; priceGbp: number }[]).filter((i) => i.kind === "employee");
  const pass = async () => (((await call("GET", "/api/store")).body as any).catalogue as { key: string; kind: string; priceGbp: number }[]).find((i) => i.kind === "consultant")!;
  const hook = (event: ProviderEvent) => { const w = provider.signedWebhook(event); return call("POST", "/api/payments/webhook", undefined, w.headers, w.rawBody); };
  const buy = async (auth: Record<string, string>, lines: unknown[], extra: Record<string, unknown> = {}) => {
    const r = await call("POST", "/api/checkout", { lines, ...extra }, auth);
    return { status: r.status, body: r.body as any, order: (r.body as any).order as any };
  };
  const switchOn = () => call("POST", "/api/owner/prices/changes", { general: { oneMonthlyBill: 1 } }, tokenFor(OWNER));
  const order = (id: string) => platform.payments.all().find((o) => o.id === id)!;
  const team = async (auth: Record<string, string>) => ((await call("GET", "/api/org", undefined, auth)).body as any).team as { id: string; templateKey: string }[];
  const lines = async (auth: Record<string, string>) => ((await call("GET", "/api/billing/lines", undefined, auth)).body as any);
  const notices = (who: string, ws: string) => platform.notices.list(userIdFor(who), ws).notices;
  return { platform, provider, email, call, clock, tokenFor, signUp, addOns, pass, hook, buy, switchOn, order, team, lines, notices };
}

/** In manual mode an order is paid by the provider's signed event, which also names the subscription. */
async function payByHook(s: ReturnType<typeof setup>, orderId: string, subscriptionRef: string) {
  const o = s.order(orderId);
  return s.hook({ type: "payment.succeeded", orderId, providerRef: o.providerRef!, subscriptionRef, customerRef: "cus_1", eventId: `evt_pay_${orderId}` });
}

describe("cancelling the Team package", () => {
  it("also stops every extra at the end of its own paid month, and tells the client once", async () => {
    const s = setup();
    const { auth, ws } = await s.signUp();
    const [extra] = await s.addOns();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    s.clock.d = new Date("2026-11-15T09:00:00Z");
    const later = s.tokenFor(ANN);
    const added = (await s.buy(later, [{ key: extra!.key }])).order;
    s.clock.d = new Date("2026-11-20T09:00:00Z");
    const now = s.tokenFor(ANN);

    const cancelled = await s.call("POST", `/api/orders/${plan.id}/cancel`, {}, now);
    const again = await s.call("POST", `/api/orders/${plan.id}/cancel`, {}, now);

    expect(cancelled.status).toBe(200);
    expect(again.status).toBe(400);
    expect(s.order(added.id)).toMatchObject({ status: "cancelled", stops: { [extra!.key]: { by: "plan", endsAt: "2026-12-15T09:00:00.000Z" } } });
    expect(s.provider.cancelled).toEqual([s.order(plan.id).subscriptionRef, s.order(added.id).subscriptionRef]);
    const told = s.notices(ANN, ws).filter((n) => /Team package has been cancelled/.test(n.title));
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain(extra!.title);
    expect(told[0]!.body).toContain("15 December");
    // The extra keeps working for the month already paid for.
    expect((await s.team(now)).some((e) => e.id === added.employeeIds[0])).toBe(true);
  });

  it("does the same when the payment provider says the package subscription has ended, once however often it says so", async () => {
    const s = setup();
    const { auth, ws } = await s.signUp();
    const [extra] = await s.addOns();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    const added = (await s.buy(auth, [{ key: extra!.key }])).order;
    const sub = s.order(plan.id).subscriptionRef!;

    const first = await s.hook({ type: "subscription.cancelled", orderId: plan.id, providerRef: sub, subscriptionRef: sub, eventId: "evt_del_1" });
    const second = await s.hook({ type: "subscription.cancelled", orderId: plan.id, providerRef: sub, subscriptionRef: sub, eventId: "evt_del_2" });

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(s.order(added.id).status).toBe("cancelled");
    expect(s.provider.cancelled).toEqual([s.order(added.id).subscriptionRef]);
    expect(s.notices(ANN, ws).filter((n) => /Team package has been cancelled/.test(n.title))).toHaveLength(1);
    expect(s.platform.energy.planOf(ws).endedPaid).toBe(true);
  });

  it("keeps trying to stop an extra the payment provider could not be reached for, and tells the platform owner", async () => {
    const s = setup();
    const { auth } = await s.signUp();
    const [extra] = await s.addOns();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    const added = (await s.buy(auth, [{ key: extra!.key }])).order;
    const real = s.provider.cancelSubscription.bind(s.provider);
    let down = true;
    s.provider.cancelSubscription = async (ref) => { if (down && ref === s.order(added.id).subscriptionRef) throw new Error("no connection"); return real(ref); };

    await s.call("POST", `/api/orders/${plan.id}/cancel`, {}, auth);
    const before = s.order(added.id);
    down = false;
    s.clock.d = new Date("2026-11-10T10:00:00Z");
    await s.platform.payments.sweep();

    expect(before.status).toBe("paid");
    expect(before.stopWanted).toBeDefined();
    expect(s.email.sent.some((m) => /could not be stopped/i.test(m.subject))).toBe(true);
    expect(s.order(added.id)).toMatchObject({ status: "cancelled" });
    expect(s.order(added.id).stopWanted).toBeUndefined();
  });
});

describe("an extra employee whose monthly order has ended", () => {
  it("leaves the team with its weekly energy when the paid month is over, exactly once, and the client is told", async () => {
    const s = setup();
    const { auth, ws } = await s.signUp();
    const [extra] = await s.addOns();
    await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }]);
    const poolBefore = s.platform.energy.teamEnergy(userIdFor(ANN), ws)!.pool;
    const added = (await s.buy(auth, [{ key: extra!.key }])).order;
    const employeeId = added.employeeIds[0] as string;
    const poolWith = s.platform.energy.teamEnergy(userIdFor(ANN), ws)!.pool;

    const stopped = await s.call("POST", "/api/billing/lines/stop", { orderId: added.id, key: extra!.key }, auth);
    await s.platform.payments.sweep();
    const stillThere = (await s.team(auth)).some((e) => e.id === employeeId);
    s.clock.d = new Date("2026-12-10T09:00:01Z");
    const later = s.tokenFor(ANN);
    await s.platform.payments.sweep();
    await s.platform.payments.sweep();

    expect(stopped.status).toBe(200);
    expect(stillThere).toBe(true);
    expect(poolWith - poolBefore).toBe(s.platform.prices.general().addOnWeeklyEnergy);
    expect((await s.team(later)).some((e) => e.id === employeeId)).toBe(false);
    expect(s.platform.workforce.formerName(employeeId)).toBeDefined();
    expect(s.platform.audit.list(ws).filter((e) => e.action === "employee.removed")).toHaveLength(1);
    const told = s.notices(ANN, ws).filter((n) => /left your team/.test(n.title));
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain("2,000");
    expect(s.order(added.id).stops![extra!.key]!.releasedAt).toBeDefined();
  });

  it("leaves at once when the payment provider says its subscription is deleted, and a repeat changes nothing", async () => {
    const s = setup();
    const { auth, ws } = await s.signUp();
    const [extra] = await s.addOns();
    await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }]);
    const added = (await s.buy(auth, [{ key: extra!.key }])).order;
    const sub = s.order(added.id).subscriptionRef!;

    await s.hook({ type: "subscription.cancelled", orderId: added.id, providerRef: sub, subscriptionRef: sub, eventId: "evt_a" });
    await s.hook({ type: "subscription.cancelled", orderId: added.id, providerRef: sub, subscriptionRef: sub, eventId: "evt_b" });

    expect((await s.team(auth)).some((e) => e.id === added.employeeIds[0])).toBe(false);
    expect(s.platform.audit.list(ws).filter((e) => e.action === "employee.removed")).toHaveLength(1);
    expect(s.notices(ANN, ws).filter((n) => /left your team/.test(n.title))).toHaveLength(1);
    // The six employees every client has are untouched, and so is the plan.
    expect(await s.team(auth)).toHaveLength(6);
    expect(s.platform.energy.onTrial(ws)).toBe(false);
  });

  it("leaves after the paid month when the deleted event arrives before our own cancellation is recorded, or never arrives", async () => {
    const s = setup();
    const { auth } = await s.signUp();
    const [extra] = await s.addOns();
    await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }]);
    const added = (await s.buy(auth, [{ key: extra!.key }])).order;

    await s.call("POST", `/api/orders/${added.id}/cancel`, {}, auth);
    s.clock.d = new Date("2026-12-11T09:00:00Z");
    await s.platform.payments.sweep();

    expect(s.platform.workforce.templateOf(added.employeeIds[0])).toBeUndefined();
  });
});

describe("the monthly lines in Plan and billing", () => {
  it("lists every monthly line with its price and when it renews or ends, and lets the client stop one extra", async () => {
    const s = setup();
    const { auth } = await s.signUp();
    const [extra] = await s.addOns();
    const pass = await s.pass();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    const added = (await s.buy(auth, [{ key: extra!.key }, { key: pass.key }])).order;

    const before = await s.lines(auth);
    await s.call("POST", "/api/billing/lines/stop", { orderId: added.id, key: extra!.key }, auth);
    const after = await s.lines(auth);

    expect(before.lines).toEqual([
      { orderId: plan.id, key: TEAM_PACKAGE_KEY, title: expect.any(String), qty: 1, monthlyMinor: 15_000, plan: true, state: "active", renewsAt: "2026-12-10T09:00:00.000Z", canStop: false },
      { orderId: added.id, key: extra!.key, title: extra!.title, qty: 1, monthlyMinor: extra!.priceGbp * 100, plan: false, state: "active", renewsAt: "2026-12-10T09:00:00.000Z", canStop: true },
    ]);
    expect(before.monthlyMinor).toBe(15_000 + extra!.priceGbp * 100);
    expect(after.lines[1]).toMatchObject({ state: "stopping", endsAt: "2026-12-10T09:00:00.000Z", canStop: false });
    expect(after.monthlyMinor).toBe(15_000);
  });

  it("refuses to stop a line for someone without the right, for another client's order, and for a line that is not there", async () => {
    const s = setup();
    const ann = await s.signUp();
    const bob = await s.signUp(BOB, "Northside Bikes");
    const [extra] = await s.addOns();
    await s.buy(ann.auth, [{ key: TEAM_PACKAGE_KEY }]);
    const added = (await s.buy(ann.auth, [{ key: extra!.key }])).order;

    const theirs = await s.call("POST", "/api/billing/lines/stop", { orderId: added.id, key: extra!.key }, bob.auth);
    const missing = await s.call("POST", "/api/billing/lines/stop", { orderId: added.id, key: "nobody" }, ann.auth);
    const bad = await s.call("POST", "/api/billing/lines/stop", { orderId: 7 }, ann.auth);
    const anonymous = await s.call("POST", "/api/billing/lines/stop", { orderId: added.id, key: extra!.key });

    expect([theirs.status, missing.status, bad.status, anonymous.status]).toEqual([400, 400, 400, 401]);
    expect(s.order(added.id).status).toBe("paid");
    expect(s.provider.cancelled).toEqual([]);
  });

  it("takes one line off a subscription that holds several, leaving the rest of the bill alone", async () => {
    const s = setup();
    const { auth } = await s.signUp();
    const [extra] = await s.addOns();
    const first = (await s.buy(auth, [{ key: extra!.key }])).order;

    const r = await s.call("POST", "/api/billing/lines/stop", { orderId: first.id, key: extra!.key }, auth);

    expect(first.lines.map((l: any) => l.key)).toEqual([TEAM_PACKAGE_KEY, extra!.key]);
    expect(r.status).toBe(200);
    expect(s.provider.cancelled).toEqual([]);
    expect(s.provider.removed).toEqual([expect.objectContaining({ subscriptionRef: s.order(first.id).subscriptionRef, planOrderId: first.id, match: { title: extra!.title, unitMinor: extra!.priceGbp * 100, qty: 1 } })]);
    expect(s.order(first.id)).toMatchObject({ status: "paid", stops: { [extra!.key]: { by: "client" } } });
  });
});

describe("adding a monthly line to the bill the client already pays", () => {
  it("is off until the platform owner switches it on: a later extra opens its own checkout as before", async () => {
    const s = setup();
    const { auth } = await s.signUp();
    const [extra] = await s.addOns();
    await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }]);

    const preview = (await s.call("POST", "/api/billing/preview", { lines: [{ key: extra!.key }] }, auth)).body as any;
    const added = await s.buy(auth, [{ key: extra!.key }], { addToBill: true });

    expect(preview).toEqual({ addToBill: false });
    expect(added.order).toMatchObject({ status: "paid" });
    expect(added.body.addedToBill).toBeUndefined();
    expect(s.provider.added).toEqual([]);
    expect(s.provider.requests).toHaveLength(2);
    expect(s.order(added.order.id).subscriptionRef).not.toBe(s.platform.payments.all()[0]!.subscriptionRef);
  });

  it("needs the client to have asked for it, so an old page can never charge a saved card by surprise", async () => {
    const s = setup();
    const { auth } = await s.signUp();
    const [extra] = await s.addOns();
    await s.switchOn();
    await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }]);

    await s.buy(auth, [{ key: extra!.key }]);

    expect(s.provider.added).toEqual([]);
    expect(s.provider.requests).toHaveLength(2);
  });

  it("says before the client confirms what is charged today and what the new monthly total is", async () => {
    const s = setup();
    const { auth } = await s.signUp();
    const [extra] = await s.addOns();
    const pass = await s.pass();
    await s.switchOn();
    await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }]);
    s.provider.previewMinor = 1234;

    const exact = (await s.call("POST", "/api/billing/preview", { lines: [{ key: extra!.key, qty: 2 }, { key: pass.key }] }, auth)).body as any;
    s.provider.previewMinor = undefined;
    const unknown = (await s.call("POST", "/api/billing/preview", { lines: [{ key: extra!.key }] }, auth)).body as any;

    expect(exact).toEqual({ addToBill: true, addMinor: extra!.priceGbp * 200, monthlyNowMinor: 15_000, monthlyNewMinor: 15_000 + extra!.priceGbp * 200, renewsAt: "2026-12-10T09:00:00.000Z", partMonthMinor: 1234, onceMinor: pass.priceGbp * 100 });
    expect(unknown).not.toHaveProperty("partMonthMinor");
    expect(unknown).toMatchObject({ addToBill: true, onceMinor: 0 });
  });

  it("adds the line and the employee at once when the saved card is charged straight away", async () => {
    const s = setup();
    const { auth, ws } = await s.signUp();
    const [extra] = await s.addOns();
    const pass = await s.pass();
    await s.switchOn();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    s.provider.previewMinor = 1234;
    await s.call("POST", "/api/billing/preview", { lines: [{ key: extra!.key }, { key: pass.key }] }, auth);

    const added = await s.buy(auth, [{ key: extra!.key }, { key: pass.key }], { addToBill: true });

    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ addedToBill: true, remaining: [{ key: pass.key, qty: 1 }] });
    expect(added.body.url).toBeUndefined();
    expect(added.order).toMatchObject({ status: "paid", dueTodayMinor: 1234, monthlyMinor: extra!.priceGbp * 100 });
    expect(added.order.employeeIds).toHaveLength(1);
    expect(s.provider.requests).toHaveLength(1);
    expect(s.provider.added).toEqual([expect.objectContaining({ orderId: added.order.id, planOrderId: plan.id, subscriptionRef: s.order(plan.id).subscriptionRef, workspaceId: ws, prorationDate: expect.any(Number) })]);
    expect(s.provider.added[0]!.lines.map((l) => l.key)).toEqual([extra!.key]);
    expect(s.order(added.order.id)).toMatchObject({ addedTo: plan.id, subscriptionRef: s.order(plan.id).subscriptionRef });
    expect((await s.lines(auth)).lines.map((l: any) => l.key)).toEqual([TEAM_PACKAGE_KEY, extra!.key]);
    expect((await s.team(auth)).some((e) => e.id === added.order.employeeIds[0])).toBe(true);
  });

  it("sends the client to the provider's invoice page when their bank wants a check, and adds the employee only when the invoice is paid", async () => {
    const s = setup("manual");
    const { auth, ws } = await s.signUp();
    const [extra] = await s.addOns();
    await s.switchOn();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    await payByHook(s, plan.id, "sub_plan_ann");

    const added = await s.buy(auth, [{ key: extra!.key }], { addToBill: true });
    const waiting = s.order(added.order.id);
    const teamBefore = (await s.team(auth)).length;
    const paid: ProviderEvent = { type: "invoice.paid", providerRef: waiting.providerRef!, subscriptionRef: "sub_plan_ann", itemRefs: waiting.itemRefs, workspaceRef: ws, amountMinor: waiting.dueTodayMinor, currency: "gbp", eventId: "evt_inv_1" };
    const first = await s.hook(paid);
    const replay = await s.hook(paid);
    const resent = await s.hook({ ...paid, eventId: "evt_inv_2" });

    expect(added.status).toBe(201);
    expect(added.body.url).toMatch(/^https:\/\/pay\.mock\.test\/invoice\//);
    expect(added.order).toMatchObject({ status: "pending", employeeIds: [], payUrl: added.body.url });
    expect(teamBefore).toBe(6);
    expect([first.body, replay.body, resent.body]).toEqual([{ result: "ok" }, { result: "ok" }, { result: "ignored" }]);
    expect(s.order(added.order.id)).toMatchObject({ status: "paid" });
    expect(s.order(added.order.id).employeeIds).toHaveLength(1);
    expect(await s.team(auth)).toHaveLength(7);
    expect(s.platform.audit.list(ws).filter((e) => e.action === "employee.hired")).toHaveLength(7);
  });

  it("ignores a paid invoice for another client's subscription, another workspace, another invoice or too small an amount", async () => {
    const s = setup("manual");
    const ann = await s.signUp();
    const bob = await s.signUp(BOB, "Northside Bikes");
    const [extra] = await s.addOns();
    await s.switchOn();
    const annPlan = (await s.buy(ann.auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    const bobPlan = (await s.buy(bob.auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    await payByHook(s, annPlan.id, "sub_plan_ann");
    await payByHook(s, bobPlan.id, "sub_plan_bob");
    const added = await s.buy(ann.auth, [{ key: extra!.key }], { addToBill: true });
    const o = s.order(added.order.id);
    const good: ProviderEvent = { type: "invoice.paid", providerRef: o.providerRef!, subscriptionRef: "sub_plan_ann", itemRefs: o.itemRefs, workspaceRef: ann.ws, amountMinor: o.dueTodayMinor, currency: "gbp" };

    const results = [];
    for (const [i, e] of [
      { ...good, subscriptionRef: "sub_plan_bob", workspaceRef: bob.ws },
      { ...good, workspaceRef: bob.ws },
      { ...good, providerRef: "in_someone_else" },
      { ...good, amountMinor: o.dueTodayMinor - 1 },
      { ...good, currency: "usd" },
      { ...good, subscriptionRef: "sub_unknown" },
    ].entries()) results.push(((await s.hook({ ...e, eventId: `evt_bad_${i}` })).body as any).result);

    expect(results).toEqual(["ignored", "ignored", "ignored", "ignored", "ignored", "ignored"]);
    expect(s.order(added.order.id)).toMatchObject({ status: "pending", employeeIds: [] });
    expect(await s.team(ann.auth)).toHaveLength(6);
    expect(await s.team(bob.auth)).toHaveLength(6);
    expect(s.email.sent.filter((m) => /does not match/i.test(m.subject)).length).toBeGreaterThanOrEqual(3);
  });

  it("fails the order and adds nothing when the waiting change runs out or its invoice is voided", async () => {
    const s = setup("manual");
    const { auth } = await s.signUp();
    const [one, two] = await s.addOns();
    await s.switchOn();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    await payByHook(s, plan.id, "sub_plan_ann");

    const expired = await s.buy(auth, [{ key: one!.key }], { addToBill: true });
    await s.hook({ type: "subscription.update_expired", providerRef: "sub_plan_ann", subscriptionRef: "sub_plan_ann", itemRefs: ["price_of_the_plan"], eventId: "evt_exp" });
    const voided = await s.buy(auth, [{ key: two!.key }], { addToBill: true });
    await s.hook({ type: "invoice.voided", providerRef: s.order(voided.order.id).providerRef!, subscriptionRef: "sub_plan_ann", eventId: "evt_void" });
    const forgotten = await s.buy(auth, [{ key: one!.key }], { addToBill: true });
    s.clock.d = new Date("2026-11-11T10:30:00Z");
    await s.platform.payments.sweep();

    expect(s.order(expired.order.id)).toMatchObject({ status: "failed", employeeIds: [] });
    expect(s.order(voided.order.id)).toMatchObject({ status: "failed", employeeIds: [] });
    expect(s.order(forgotten.order.id)).toMatchObject({ status: "failed", employeeIds: [] });
    expect(await s.team(s.tokenFor(ANN))).toHaveLength(6);
  });

  it("closes an older addition that is still waiting when the client starts a new one", async () => {
    const s = setup("manual");
    const { auth } = await s.signUp();
    const [one] = await s.addOns();
    await s.switchOn();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    await payByHook(s, plan.id, "sub_plan_ann");

    const first = await s.buy(auth, [{ key: one!.key }], { addToBill: true });
    const second = await s.buy(auth, [{ key: one!.key }], { addToBill: true });

    expect(s.order(first.order.id).status).toBe("failed");
    expect(s.order(second.order.id).status).toBe("pending");
    expect(s.provider.cancelled).toContain(s.order(first.order.id).providerRef);
  });

  it("falls back to a normal checkout when the provider refuses before any money moves", async () => {
    const s = setup();
    const { auth } = await s.signUp();
    const [extra] = await s.addOns();
    await s.switchOn();
    await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }]);
    s.provider.addFails = "error";

    const added = await s.buy(auth, [{ key: extra!.key }], { addToBill: true });

    expect(added.status).toBe(201);
    expect(added.body.addedToBill).toBeUndefined();
    expect(added.order).toMatchObject({ status: "paid" });
    expect(added.order.employeeIds).toHaveLength(1);
    expect(s.provider.requests).toHaveLength(2);
    const failed = s.platform.payments.all().filter((o) => o.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ employeeIds: [] });
    expect(failed[0]!.addedTo).toBeDefined();
  });

  it("does not open a second way to pay when the provider gave no clear answer, and adds the employee if the invoice turns out paid", async () => {
    const s = setup();
    const { auth, ws } = await s.signUp();
    const [extra] = await s.addOns();
    await s.switchOn();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    s.provider.addFails = "uncertain";

    const added = await s.buy(auth, [{ key: extra!.key }], { addToBill: true });
    const o = s.platform.payments.all().find((x) => x.addedTo)!;
    const before = { status: o.status, team: (await s.team(auth)).length };
    await s.hook({ type: "invoice.paid", providerRef: "in_late_1", subscriptionRef: s.order(plan.id).subscriptionRef!, itemRefs: o.itemRefs, workspaceRef: ws, amountMinor: 700, currency: "gbp", eventId: "evt_late" });

    expect(added.status).toBe(400);
    expect(added.body.error).toMatch(/could not confirm/i);
    expect(s.provider.requests).toHaveLength(1);
    expect(before).toEqual({ status: "pending", team: 6 });
    expect(s.email.sent.some((m) => /no clear answer/i.test(m.subject))).toBe(true);
    expect(s.order(o.id)).toMatchObject({ status: "paid", dueTodayMinor: 700, providerRef: "in_late_1" });
    expect(await s.team(auth)).toHaveLength(7);
  });

  it("uses the normal checkout when the client holds a discount code or one is still running on the bill, so a code is applied exactly once", async () => {
    const s = setup();
    const { auth } = await s.signUp();
    const bob = await s.signUp(BOB, "Northside Bikes");
    const [one, two] = await s.addOns();
    await s.switchOn();
    await s.call("POST", "/api/owner/coupons", { code: "WELCOME20", kind: "percent_off", value: 20, duration: { kind: "months", months: 3 } }, s.tokenFor(OWNER));
    await s.call("POST", "/api/owner/coupons", { code: "EXTRA10", kind: "percent_off", value: 10, duration: { kind: "once" } }, s.tokenFor(OWNER));
    await s.call("POST", "/api/coupons/redeem", { code: "WELCOME20" }, auth);
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    await s.buy(bob.auth, [{ key: TEAM_PACKAGE_KEY }]);

    // Ann's code is still running on her bill. Bob redeems one after he started paying, so he is holding it.
    const running = (await s.call("POST", "/api/billing/preview", { lines: [{ key: one!.key }] }, auth)).body as any;
    const first = await s.buy(auth, [{ key: one!.key }], { addToBill: true });
    const redeemed = await s.call("POST", "/api/coupons/redeem", { code: "EXTRA10" }, bob.auth);
    const holding = (await s.call("POST", "/api/billing/preview", { lines: [{ key: two!.key }] }, bob.auth)).body as any;
    const second = await s.buy(bob.auth, [{ key: two!.key }], { addToBill: true });

    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200);
    expect(plan.discount).toMatchObject({ code: "WELCOME20" });
    expect(running).toEqual({ addToBill: false, reason: "discount" });
    expect(holding).toEqual({ addToBill: false, reason: "code" });
    expect(s.provider.added).toEqual([]);
    expect(first.order.discount).toBeUndefined();
    expect(first.order.dueTodayMinor).toBe(one!.priceGbp * 100);
    expect(second.order.discount).toMatchObject({ code: "EXTRA10", amountOffMinor: two!.priceGbp * 10 });
    expect(s.provider.requests).toHaveLength(4);
    expect(s.provider.requests[3]).toMatchObject({ discount: { amountOffMinor: two!.priceGbp * 10 }, discountMonths: 1 });
  });

  it("stops one line of the shared bill by taking that line off, and the employee leaves at the end of the paid month", async () => {
    const s = setup();
    const { auth } = await s.signUp();
    const [extra] = await s.addOns();
    await s.switchOn();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    s.clock.d = new Date("2026-11-20T09:00:00Z");
    const now = s.tokenFor(ANN);
    const added = (await s.buy(now, [{ key: extra!.key }], { addToBill: true })).order;

    const r = await s.call("POST", "/api/billing/lines/stop", { orderId: added.id, key: extra!.key }, now);
    s.clock.d = new Date("2026-12-09T09:00:00Z");
    await s.platform.payments.sweep();
    const during = s.platform.workforce.templateOf(added.employeeIds[0]);
    s.clock.d = new Date("2026-12-10T09:00:01Z");
    await s.platform.payments.sweep();

    expect(r.status).toBe(200);
    expect(s.provider.cancelled).toEqual([]);
    expect(s.provider.removed).toEqual([expect.objectContaining({ subscriptionRef: s.order(plan.id).subscriptionRef, planOrderId: plan.id, itemRef: s.order(added.id).itemRefs![0] })]);
    // The line shares the plan's billing month, so it ends on the plan's date, not a month after it was added.
    expect(s.order(added.id)).toMatchObject({ status: "cancelled", stops: { [extra!.key]: { endsAt: "2026-12-10T09:00:00.000Z" } } });
    expect(during).toBe(extra!.key);
    expect(s.platform.workforce.templateOf(added.employeeIds[0])).toBeUndefined();
    expect(s.order(plan.id).status).toBe("paid");
  });

  it("ends every line on the shared bill when the package is cancelled, with one call to the provider", async () => {
    const s = setup();
    const { auth, ws } = await s.signUp();
    const [extra] = await s.addOns();
    await s.switchOn();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    const added = (await s.buy(auth, [{ key: extra!.key }], { addToBill: true })).order;

    await s.call("POST", `/api/orders/${plan.id}/cancel`, {}, auth);
    s.clock.d = new Date("2026-12-10T09:00:01Z");
    await s.platform.payments.sweep();

    expect(s.provider.cancelled).toEqual([s.order(plan.id).subscriptionRef]);
    expect(s.order(added.id)).toMatchObject({ status: "cancelled", stops: { [extra!.key]: { by: "plan", endsAt: "2026-12-10T09:00:00.000Z" } } });
    expect(s.platform.workforce.templateOf(added.employeeIds[0])).toBeUndefined();
    expect(s.notices(ANN, ws).filter((n) => /Team package has been cancelled/.test(n.title))).toHaveLength(1);
  });

  it("never fulfils an addition that was cancelled before the money arrived", async () => {
    const s = setup("manual");
    const { auth, ws } = await s.signUp();
    const [extra] = await s.addOns();
    await s.switchOn();
    const plan = (await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }])).order;
    await payByHook(s, plan.id, "sub_plan_ann");
    const added = await s.buy(auth, [{ key: extra!.key }], { addToBill: true });
    const o = s.order(added.order.id);

    await s.call("POST", `/api/orders/${o.id}/cancel`, {}, auth);
    await s.hook({ type: "invoice.paid", providerRef: o.providerRef!, subscriptionRef: "sub_plan_ann", itemRefs: o.itemRefs, workspaceRef: ws, amountMinor: o.dueTodayMinor, currency: "gbp", eventId: "evt_after_cancel" });

    // Only the invoice was closed: the shared subscription itself was not touched.
    expect(s.provider.cancelled).toEqual([o.providerRef]);
    expect(s.order(o.id)).toMatchObject({ status: "cancelled", employeeIds: [] });
    expect(await s.team(auth)).toHaveLength(6);
    expect(s.email.sent.some((m) => /Paid a cancelled order/.test(m.subject))).toBe(true);
  });
});

describe("after a restart", () => {
  it("an employee who left stays off the team", async () => {
    const records: { ws: string; kind: string; id: string; data: any }[] = [];
    const s = setup();
    const store = new Proxy({}, { get: (_t, prop) => (prop === "record" ? (ws: string, kind: string, id: string, data: unknown) => { records.push({ ws, kind, id, data: JSON.parse(JSON.stringify(data)) }); } : prop === "healthy" ? true : () => {}) });
    for (const part of [s.platform.workforce, s.platform.payments]) part.useSink(store as any);
    const { auth } = await s.signUp();
    const [extra] = await s.addOns();
    await s.buy(auth, [{ key: TEAM_PACKAGE_KEY }]);
    const added = (await s.buy(auth, [{ key: extra!.key }])).order;
    const sub = s.order(added.id).subscriptionRef!;

    await s.hook({ type: "subscription.cancelled", orderId: added.id, providerRef: sub, subscriptionRef: sub });

    expect(records.filter((r) => r.kind === "employee_removed").map((r) => r.id)).toEqual([added.employeeIds[0]]);
    const last = records.filter((r) => r.kind === "order" && r.id === added.id).pop()!;
    expect(last.data.stops[extra!.key].releasedAt).toBeDefined();
  });
});
