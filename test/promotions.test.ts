import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { AffiliateService, CouponService, applyDiscount, canonicalEmail, checkCommission, checkCouponValue, commissionFor, discountOf } from "../src/modules/promotions/index.js";

const OWNER = "atif@maiz.test";
const IN_A_YEAR = "2027-11-01T00:00:00Z";

function setup() {
  const clock = { d: new Date("2026-11-10T09:00:00Z") };
  const mail = new MemoryEmailSender();
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: mail, appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const bearer = (email: string) => ({ authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(email), e: email }, 7 * 86400, clock.d.getTime())}` });
  const owner = () => bearer(OWNER);
  const signUp = async (email: string, businessName: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const r = await call("POST", "/api/signup", { email, businessName, sells: "Coffee", size: "2–10", country: "GB", ...extra }, headers);
    return { res: r, auth: { authorization: `Bearer ${(r.body as any).token}` } };
  };
  const coupon = async (c: Record<string, unknown>) => (await call("POST", "/api/owner/coupons", { enabled: true, ...c }, owner()));
  return { platform, call, clock, mail, owner, bearer, signUp, coupon };
}

describe("promotion rules", () => {
  it("applies a discount only for the months it lasts", () => {
    const d = discountOf("percent_off", 20, { kind: "months", months: 3 })!;
    expect([0, 2, 3].map((i) => applyDiscount(d, 150, i))).toEqual([120, 120, 150]);
    expect(applyDiscount(discountOf("fixed_off", 10, { kind: "once" }), 150, 0)).toBe(140);
    expect(applyDiscount(discountOf("fixed_off", 10, { kind: "once" }), 150, 1)).toBe(150);
    expect(applyDiscount(discountOf("percent_off", 100, { kind: "forever" }), 150, 99)).toBe(0);
    expect(applyDiscount(discountOf("fixed_off", 500, { kind: "forever" }), 150, 5)).toBe(0);
    expect(applyDiscount(discountOf("free_months", 2, { kind: "once" }), 150, 1)).toBe(0);
    expect(applyDiscount(discountOf("free_months", 2, { kind: "once" }), 150, 2)).toBe(150);
    expect(discountOf("energy_credit", 500, { kind: "once" })).toBeUndefined();
  });

  it("refuses values that make no sense", () => {
    expect(() => checkCouponValue("percent_off", 101)).toThrow(/100/);
    expect(() => checkCouponValue("trial_days", 2.5)).toThrow(/whole number/);
    expect(() => checkCouponValue("energy_credit", 0)).toThrow(/above zero/);
    expect(() => checkCommission({ kind: "percent", value: 20, months: 0 })).toThrow(/months/);
    expect(commissionFor({ kind: "percent", value: 20, months: 12 }, 150)).toBe(30);
    expect(commissionFor({ kind: "fixed", value: 500, months: 1 }, 150)).toBe(150);
  });

  it("treats aliases of one address as the same person", () => {
    expect(canonicalEmail("Sam.Example+maiz@gmail.com")).toBe(canonicalEmail("samexample@googlemail.com"));
    expect(canonicalEmail("a+b@company.com")).toBe("a@company.com");
    expect(canonicalEmail("a.b@company.com")).toBe("a.b@company.com");
  });
});

describe("coupons", () => {
  it("is for the platform owner only", async () => {
    const s = setup();
    const { auth } = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    expect((await s.call("GET", "/api/owner/promotions", undefined, auth)).status).toBe(403);
    expect((await s.call("POST", "/api/owner/coupons", { code: "X1X1", kind: "trial_days", value: 5 }, auth)).status).toBe(403);
    expect((await s.call("POST", "/api/owner/affiliates", { name: "A", email: "a@b.co" }, auth)).status).toBe(403);
  });

  it("extends the trial from a code typed at signup, and says so", async () => {
    const s = setup();
    expect((await s.coupon({ code: "welcome-30", kind: "trial_days", value: 30 })).status).toBe(201);
    const { res } = await s.signUp("ann@kestrel.co", "Kestrel Coffee", { coupon: " welcome-30 " });
    const body = res.body as any;
    expect(body.coupon).toMatchObject({ ok: true });
    expect(body.coupon.message).toMatch(/30 more days of free trial/);
    expect(Date.parse(body.trialEndsAt) - s.clock.d.getTime()).toBeGreaterThan(36 * 86_400_000);
  });

  it("does not block signup on a bad code, and the message says what is wrong", async () => {
    const s = setup();
    const { res } = await s.signUp("ann@kestrel.co", "Kestrel Coffee", { coupon: "NOPE-NOPE" });
    expect(res.status).toBe(201);
    expect((res.body as any).coupon).toMatchObject({ ok: false });
    expect((res.body as any).coupon.message).toMatch(/isn't valid/);
  });

  it("adds free energy to the trial pool, and a paid plan keeps it as a roll-over top-up", async () => {
    const s = setup();
    await s.coupon({ code: "ENERGY-1000", kind: "energy_credit", value: 1000 });
    const { auth } = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const before = (await s.call("GET", "/api/energy", undefined, auth)).body as any;
    const r = await s.call("POST", "/api/coupons/redeem", { code: "energy-1000" }, auth);
    expect(r.status).toBe(200);
    expect((r.body as any).team.pool - before.team.pool).toBe(1000);
    expect((await s.call("POST", "/api/coupons/redeem", { code: "ENERGY-1000" }, auth)).body).toMatchObject({ error: expect.stringMatching(/already used/) });

    const bob = await s.signUp("bob@kestrel.co", "Bob's Bakery");
    const ws = s.platform.identity.workspacesFor(userIdFor("bob@kestrel.co"))[0]!.id;
    s.platform.energy.switchToPaid(ws, { dailyQuotaPerEmployee: 1_000, weeklyTeamEnergy: 8_000, dailyTeamCeiling: 3_000, monthlyOvertimeCap: 0, monthlyCostCapMicro: 50_000_000 }, "test");
    await s.call("POST", "/api/coupons/redeem", { code: "ENERGY-1000" }, bob.auth);
    expect(s.platform.energy.topUpLeft(ws)).toBe(1000);
  });

  it("gives clear reasons: unknown, disabled, expired, used up, wrong email, wrong plan", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const check = async (code: string) => (await s.call("POST", "/api/coupons/check", { code }, ann.auth)).body as any;
    expect((await check("")).error).toMatch(/Enter a code/);
    expect((await check("???")).error).toMatch(/doesn't look like a code/);
    expect((await check("NOT-REAL")).error).toMatch(/isn't valid/);

    const off = (await s.coupon({ code: "SWITCHED-OFF", kind: "trial_days", value: 5 })).body as any;
    await s.call("POST", `/api/owner/coupons/${off.coupon.id}/enabled`, { enabled: false }, s.owner());
    expect((await check("SWITCHED-OFF")).error).toMatch(/no longer active/);

    await s.coupon({ code: "SHORT-LIVED", kind: "trial_days", value: 5, expiresAt: "2026-11-20T00:00:00Z" });
    expect((await check("SHORT-LIVED")).summary).toMatch(/5 more days/);
    s.clock.d = new Date("2026-11-21T00:00:00Z");
    expect((await check("SHORT-LIVED")).error).toMatch(/expired on 20 November 2026/);
    s.clock.d = new Date("2026-11-10T09:00:00Z");

    await s.coupon({ code: "ONLY-ONE", kind: "energy_credit", value: 100, maxRedemptions: 1 });
    await s.call("POST", "/api/coupons/redeem", { code: "ONLY-ONE" }, ann.auth);
    const bob = await s.signUp("bob@kestrel.co", "Bob's Bakery");
    expect(((await s.call("POST", "/api/coupons/redeem", { code: "ONLY-ONE" }, bob.auth)).body as any).error).toMatch(/maximum number of times/);

    await s.coupon({ code: "JUST-FOR-CARL", kind: "energy_credit", value: 100, email: "carl@x.co" });
    expect(((await s.call("POST", "/api/coupons/redeem", { code: "JUST-FOR-CARL" }, bob.auth)).body as any).error).toMatch(/isn't valid/);

    await s.coupon({ code: "PAID-ONLY", kind: "energy_credit", value: 100, plan: "paid" });
    expect(((await s.call("POST", "/api/coupons/redeem", { code: "PAID-ONLY" }, bob.auth)).body as any).error).toMatch(/paying clients/);
  });

  it("rejects duplicate codes and nonsense settings when the owner creates one", async () => {
    const s = setup();
    expect((await s.coupon({ code: "SAME-CODE", kind: "trial_days", value: 5 })).status).toBe(201);
    expect(((await s.coupon({ code: "same-code", kind: "trial_days", value: 5 })).body as any).error).toMatch(/already exists/);
    expect(((await s.coupon({ code: "AB", kind: "percent_off", value: 5 })).body as any).error).toMatch(/3 to 32/);
    expect(((await s.coupon({ code: "PAST-ONE", kind: "trial_days", value: 5, expiresAt: "2020-01-01" })).body as any).error).toMatch(/future/);
    expect(((await s.coupon({ code: "BAD-PCT", kind: "percent_off", value: 150 })).body as any).error).toMatch(/100/);
    expect(((await s.coupon({ code: "TRIAL-PAID", kind: "trial_days", value: 5, plan: "paid" })).body as any).error).toMatch(/free trial/);
  });

  it("records a discount for billing, lets only one be active, and keeps the history", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const c = (await s.coupon({ code: "HALF-OFF", kind: "percent_off", value: 50, duration: { kind: "months", months: 3 } })).body as any;
    await s.coupon({ code: "TENNER", kind: "fixed_off", value: 10, duration: { kind: "forever" } });
    const r = await s.call("POST", "/api/coupons/redeem", { code: "HALF-OFF" }, ann.auth);
    expect((r.body as any).applied).toBe("50% off your monthly bill for 3 months");
    expect(((await s.call("POST", "/api/coupons/redeem", { code: "TENNER" }, ann.auth)).body as any).error).toMatch(/Only one discount/);
    const ws = s.platform.identity.workspacesFor(userIdFor("ann@kestrel.co"))[0]!.id;
    expect(s.platform.coupons.activeDiscount(ws)?.discount).toEqual({ type: "percent", value: 50, months: 3 });
    const hist = (await s.call("GET", `/api/owner/coupons/${c.coupon.id}/redemptions`, undefined, s.owner())).body as any;
    expect(hist.redemptions).toHaveLength(1);
    const list = ((await s.call("GET", "/api/owner/promotions", undefined, s.owner())).body as any).coupons;
    expect(list.find((x: any) => x.code === "HALF-OFF")).toMatchObject({ used: 1, status: "active" });
    expect(((await s.call("GET", "/api/coupons", undefined, ann.auth)).body as any).used[0].code).toBe("HALF-OFF");
  });

  it("stops code guessing after a few wrong tries", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    for (let i = 0; i < 8; i++) expect((await s.call("POST", "/api/coupons/redeem", { code: `GUESS-${i}` }, ann.auth)).status).toBe(400);
    expect((await s.call("POST", "/api/coupons/redeem", { code: "GUESS-9" }, ann.auth)).status).toBe(429);
    s.clock.d = new Date(s.clock.d.getTime() + 16 * 60_000);
    expect((await s.call("POST", "/api/coupons/redeem", { code: "GUESS-10" }, ann.auth)).status).toBe(400);
  });

  it("emails a code to someone when the owner asks", async () => {
    const s = setup();
    const c = (await s.coupon({ code: "FOR-FRIEND", kind: "trial_days", value: 14 })).body as any;
    expect((await s.call("POST", `/api/owner/coupons/${c.coupon.id}/send`, { to: "not-an-email" }, s.owner())).status).toBe(400);
    expect((await s.call("POST", `/api/owner/coupons/${c.coupon.id}/send`, { to: "friend@x.co" }, s.owner())).status).toBe(200);
    const sent = s.mail.sent.find((m) => m.to === "friend@x.co")!;
    expect(sent.text).toContain("FOR-FRIEND");
    expect(sent.text).toContain("14 more days of free trial");
  });

  it("saves and restores its records", () => {
    const saved: [string, string, unknown][] = [];
    const sink = { promo: (k: string, id: string, d: unknown) => saved.push([k, id, d]) } as never;
    const effects = { isTrial: () => true, extendTrial: () => undefined, grantEnergy: () => undefined };
    const a = new CouponService(() => true, effects);
    a.useSink(sink);
    const c = a.create("o", { code: "KEEP-ME", kind: "energy_credit", value: 10 });
    a.redeem("u", "ws1", "u@x.co", "keep-me");
    const b = new CouponService(() => true, effects);
    for (const [k, , d] of saved) (k === "coupon" ? b.restoreCoupon(d as never) : b.restoreRedemption(d as never));
    expect(b.list("o")[0]).toMatchObject({ id: c.id, used: 1 });
    expect(() => b.redeem("u", "ws1", "u@x.co", "KEEP-ME")).toThrow(/already used/);
  });
});

describe("affiliates", () => {
  const create = (s: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) =>
    s.call("POST", "/api/owner/affiliates", { name: "Sam Example", email: "sam@example.co", code: "sam", ...extra }, s.owner());

  it("creates an affiliate with the default commission and emails them their link", async () => {
    const s = setup();
    const r = await create(s);
    expect(r.status).toBe(201);
    const a = (r.body as any).affiliate;
    expect(a).toMatchObject({ code: "sam", commission: { kind: "percent", value: 20, months: 12 }, holdDays: 30 });
    const m = s.mail.sent.find((x) => x.to === "sam@example.co")!;
    expect(m.text).toContain("https://app.test/r/sam");
    expect(m.text).toContain("20% of each payment for the first 12 months");
    expect(((await create(s)).body as any).error).toMatch(/already taken/);
    expect(((await create(s, { code: "other", email: "Sam@Example.co" })).body as any).error).toMatch(/email already exists/);
  });

  it("counts a visit once per browser and remembers the affiliate in a cookie", async () => {
    const s = setup();
    await create(s);
    const first = await s.call("GET", "/r/SAM");
    expect(first.status).toBe(302);
    expect(first.headers?.["set-cookie"]).toMatch(/^__Host-maiz_ref=sam;.*HttpOnly.*Secure/);
    await s.call("GET", "/r/sam", undefined, { cookie: "__Host-maiz_ref=sam" });
    const unknown = await s.call("GET", "/r/nobody");
    expect(unknown.headers?.["set-cookie"]).toBeUndefined();
    expect(s.platform.affiliates.list(userIdFor(OWNER))[0]!.stats.clicks).toBe(1);
  });

  it("credits a signup that came through the link, but never the affiliate's own address or an alias", async () => {
    const s = setup();
    await create(s, { email: "sam.example@gmail.com" });
    const cookie = { cookie: "__Host-maiz_ref=sam" };
    await s.signUp("ann@kestrel.co", "Kestrel Coffee", {}, cookie);
    await s.signUp("samexample+shop@gmail.com", "Sam's Shop", {}, cookie);
    await s.signUp("bob@kestrel.co", "No Referral");
    const [a] = s.platform.affiliates.list(userIdFor(OWNER));
    expect(a!.stats.signups).toBe(1);
  });

  it("ignores a paused affiliate", async () => {
    const s = setup();
    const a = (await create(s)).body as any;
    await s.call("POST", `/api/owner/affiliates/${a.affiliate.id}/enabled`, { enabled: false }, s.owner());
    await s.signUp("ann@kestrel.co", "Kestrel Coffee", {}, { cookie: "__Host-maiz_ref=sam" });
    expect(s.platform.affiliates.list(userIdFor(OWNER))[0]!.stats.signups).toBe(0);
  });

  it("earns commission on the first N payments only, once per payment, then pays out after the hold", async () => {
    const s = setup();
    const a = (await create(s, { commission: { kind: "percent", value: 20, months: 2 } })).body as any;
    await s.signUp("ann@kestrel.co", "Kestrel Coffee", {}, { cookie: "__Host-maiz_ref=sam" });
    const ws = s.platform.identity.workspacesFor(userIdFor("ann@kestrel.co"))[0]!.id;
    const aff = s.platform.affiliates;
    expect(aff.recordPayment(ws, 150, "order-1")?.amountGbp).toBe(30);
    expect(aff.recordPayment(ws, 150, "order-1")).toBeUndefined();
    expect(aff.recordPayment(ws, 175, "order-2")?.amountGbp).toBe(35);
    expect(aff.recordPayment(ws, 150, "order-3")).toBeUndefined();
    expect(aff.recordPayment("some-other-ws", 150, "order-4")).toBeUndefined();

    const pay = () => s.call("POST", `/api/owner/affiliates/${a.affiliate.id}/payout`, { reference: "BACS 1 Dec" }, s.owner());
    expect(((await pay()).body as any).error).toMatch(/nothing is ready/);
    s.clock.d = new Date("2026-12-15T00:00:00Z");
    const paid = await pay();
    expect(paid.status).toBe(200);
    expect((paid.body as any).payout).toMatchObject({ amountGbp: 65, reference: "BACS 1 Dec" });
    expect(((await pay()).body as any).error).toMatch(/nothing is ready/);
    expect(s.mail.sent.some((m) => m.to === "sam@example.co" && m.text.includes("£65.00"))).toBe(true);
    const d = ((await s.call("GET", `/api/owner/affiliates/${a.affiliate.id}`, undefined, s.owner())).body as any).affiliate;
    expect(d.stats).toMatchObject({ signups: 1, paying: 1, earnedGbp: 65, paidGbp: 65, payableGbp: 0, pendingGbp: 0 });
  });

  it("shows an affiliate only their own numbers, without client names", async () => {
    const s = setup();
    await create(s);
    await create(s, { name: "Other Person", email: "other@example.co", code: "other" });
    await s.signUp("ann@kestrel.co", "Kestrel Coffee", {}, { cookie: "__Host-maiz_ref=sam" });
    const ws = s.platform.identity.workspacesFor(userIdFor("ann@kestrel.co"))[0]!.id;
    s.platform.affiliates.recordPayment(ws, 150, "order-1");
    const mine = ((await s.call("GET", "/api/affiliate/me", undefined, s.bearer("sam@example.co"))).body as any).affiliate;
    expect(mine).toMatchObject({ code: "sam", link: "https://app.test/r/sam", stats: { signups: 1, earnedGbp: 30, pendingGbp: 30 } });
    expect(JSON.stringify(mine)).not.toContain("Kestrel");
    expect(mine.commissions[0].status).toBe("pending");
    const other = ((await s.call("GET", "/api/affiliate/me", undefined, s.bearer("other@example.co"))).body as any).affiliate;
    expect(other.stats.signups).toBe(0);
    expect(((await s.call("GET", "/api/affiliate/me", undefined, s.bearer("ann@kestrel.co"))).body as any).affiliate).toBeNull();
  });

  it("saves and restores its records", () => {
    const saved: [string, unknown][] = [];
    const sink = { promo: (k: string, _id: string, d: unknown) => saved.push([k, d]) } as never;
    const a = new AffiliateService(() => true);
    a.useSink(sink);
    const aff = a.create("o", { name: "Sam", email: "sam@x.co", code: "sam" });
    a.attribute("ws1", "ann@x.co", "Ann Ltd", "sam");
    a.recordPayment("ws1", 100, "p1");
    const b = new AffiliateService(() => true);
    for (const [k, d] of saved) b.restore(k, d);
    expect(b.detailFor("o", aff.id).stats).toMatchObject({ signups: 1, earnedGbp: 20 });
  });
});
