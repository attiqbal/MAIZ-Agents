import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { parseChange } from "../src/modules/pricing/index.js";

const OWNER = "atif@maiz.test";

function setup() {
  const clock = { d: new Date("2026-11-10T09:00:00Z") };
  const mail = new MemoryEmailSender();
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: mail, appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const owner = () => ({ authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(OWNER), e: OWNER }, 7 * 86400, clock.d.getTime())}` });
  const signUp = async (email: string, businessName: string) => {
    const r = await call("POST", "/api/signup", { email, businessName, sells: "Coffee", size: "2–10", country: "GB" });
    return { authorization: `Bearer ${(r.body as any).token}` };
  };
  return { platform, call, clock, mail, owner, signUp };
}

describe("prices and packages", () => {
  it("refuses unknown settings, bad numbers and empty changes", () => {
    expect(() => parseChange({ general: { trialDays: 2.5 } })).toThrow(/whole number/);
    expect(() => parseChange({ general: { nope: 1 } })).toThrow(/unknown setting/);
    expect(() => parseChange({ items: { "no-such-item": { priceGbp: 1 } } })).toThrow(/unknown store item/);
    expect(() => parseChange({ agents: { "finance-manager": -1 } })).toThrow(/from 0/);
    expect(() => parseChange({})).toThrow(/nothing to change/);
    expect(parseChange({ general: { addOnEmployeeMonthlyGbp: 14.999 } }).set.general?.addOnEmployeeMonthlyGbp).toBe(15);
  });

  it("lets only the platform owner change prices; the store and cart follow at once", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    expect((await s.call("GET", "/api/owner/prices", undefined, ann)).status).toBe(403);
    expect((await s.call("POST", "/api/owner/prices/changes", { general: { addOnEmployeeMonthlyGbp: 0 } }, ann)).status).toBe(403);

    const book = (await s.call("GET", "/api/owner/prices", undefined, s.owner())).body as any;
    const addOn = book.items.find((i: any) => i.kind === "employee");
    const pass = book.items.find((i: any) => i.kind === "consultant");
    expect(addOn.priceGbp).toBe(12);

    const r = await s.call("POST", "/api/owner/prices/changes", { general: { addOnEmployeeMonthlyGbp: 15 }, items: { [pass.key]: { priceGbp: 99, energy: 5000 } }, note: "Launch pricing" }, s.owner());
    expect(r.status).toBe(201);
    expect((r.body as any).change.from).toMatchObject({ "general.addOnEmployeeMonthlyGbp": 12, [`items.${pass.key}.priceGbp`]: pass.priceGbp });

    const store = (await s.call("GET", "/api/store")).body as any;
    expect(store.catalogue.find((i: any) => i.key === addOn.key).priceGbp).toBe(15);
    expect(store.catalogue.find((i: any) => i.key === pass.key)).toMatchObject({ priceGbp: 99, energy: 5000 });
    const q = (await s.call("POST", "/api/cart/quote", { lines: [{ key: addOn.key, qty: 2 }] })).body as any;
    expect(q.monthlyGbp).toBe(30);
  });

  it("schedules a change for a later date, shows it as upcoming, and can call it off before it starts", async () => {
    const s = setup();
    const r = await s.call("POST", "/api/owner/prices/changes", { general: { basicPackageMonthlyGbp: 49 }, effectiveFrom: "2026-12-01T00:00:00Z" }, s.owner());
    const id = (r.body as any).change.id;
    expect((r.body as any).general.basicPackageMonthlyGbp).toBe(100);
    expect((r.body as any).history[0]).toMatchObject({ id, upcoming: true });
    expect(((await s.call("GET", "/api/store")).body as any).prices.basicPackageMonthlyGbp).toBe(100);
    s.clock.d = new Date("2026-12-02T00:00:00Z");
    expect(((await s.call("GET", "/api/store")).body as any).prices.basicPackageMonthlyGbp).toBe(49);
    expect((await s.call("DELETE", `/api/owner/prices/changes/${id}`, undefined, s.owner())).status).toBe(400);

    const later = await s.call("POST", "/api/owner/prices/changes", { general: { basicPackageMonthlyGbp: 55 }, effectiveFrom: "2027-01-01T00:00:00Z" }, s.owner());
    expect((await s.call("DELETE", `/api/owner/prices/changes/${(later.body as any).change.id}`, undefined, s.owner())).status).toBe(200);
    s.clock.d = new Date("2027-01-02T00:00:00Z");
    expect(((await s.call("GET", "/api/store")).body as any).prices.basicPackageMonthlyGbp).toBe(49);
  });

  it("uses the owner's trial length and trial energy for new clients, and an agent's own daily cap inside the pool", async () => {
    const s = setup();
    await s.call("POST", "/api/owner/prices/changes", { general: { trialDays: 14, trialTeamEnergy: 4_000 }, agents: { "marketing-manager": 500 } }, s.owner());
    const r = await s.call("POST", "/api/signup", { email: "bob@bakery.co", businessName: "Bob's Bakery", sells: "Bread", size: "2–10", country: "GB" });
    expect((r.body as any).trialEndsAt).toBe("2026-11-24T09:00:00.000Z");
    const auth = { authorization: `Bearer ${(r.body as any).token}` };
    const org = (await s.call("GET", "/api/org", undefined, auth)).body as any;
    expect(org.teamEnergy).toMatchObject({ pool: 4_000, left: 4_000, leftToday: 4_000, refillsAt: null });
    const energy = Object.fromEntries(org.team.map((e: any) => [e.templateKey, e.energyLeft]));
    expect(energy["marketing-manager"]).toBe(500);
    expect(energy["finance-manager"]).toBe(4_000);
    await s.call("POST", "/api/owner/prices/changes", { agents: { "marketing-manager": null } }, s.owner());
    const again = (await s.call("GET", "/api/org", undefined, auth)).body as any;
    expect(again.team.find((e: any) => e.templateKey === "marketing-manager").energyLeft).toBe(4_000);
  });

  it("refuses the old per-agent default setting now that the team shares a pool", async () => {
    const s = setup();
    const r = await s.call("POST", "/api/owner/prices/changes", { general: { defaultDailyEnergyPerEmployee: 200 } }, s.owner());
    expect(r.status).toBe(400);
  });

  it("hides an item switched off from the store and the cart", async () => {
    const s = setup();
    const key = (((await s.call("GET", "/api/store")).body as any).catalogue[0]).key;
    await s.call("POST", "/api/owner/prices/changes", { items: { [key]: { available: false } } }, s.owner());
    expect(((await s.call("GET", "/api/store")).body as any).catalogue.some((i: any) => i.key === key)).toBe(false);
    expect(((await s.call("POST", "/api/cart/quote", { lines: [{ key, qty: 1 }] })).body as any).rejected[0].key).toBe(key);
  });
});

describe("custom specialists are reviewed by the platform owner", () => {
  const brief = { title: "Wholesale account coordinator", purpose: "Look after cafes that buy in bulk", duties: ["Prepare price lists", "Chase repeat orders"] };

  it("drafts for the client, waits for the owner, who can approve at a different price", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const made = await s.call("POST", "/api/specialists", brief, ann);
    expect(made.status).toBe(201);
    const req = (made.body as any).request;
    expect(req).toMatchObject({ status: "in_review", statusLabel: "With MAIZ for review", priceGbp: 19 });
    expect(s.platform.specialists.mayTrain(req.id)).toBe(false);
    await Promise.resolve();
    expect(s.mail.sent.find((m) => m.to === OWNER)?.subject).toBe("New specialist to review: Wholesale account coordinator for Kestrel Coffee");

    expect((await s.call("POST", `/api/owner/specialists/${req.id}/decide`, { decision: "approved" }, ann)).status).toBe(403);
    expect((await s.call("POST", `/api/owner/specialists/${req.id}/decide`, { decision: "declined" }, s.owner())).status).toBe(400);
    const ok = await s.call("POST", `/api/owner/specialists/${req.id}/decide`, { decision: "approved", priceGbp: 24 }, s.owner());
    expect(ok.status).toBe(200);
    expect(s.platform.specialists.mayTrain(req.id)).toBe(true);
    const mine = ((await s.call("GET", "/api/specialists", undefined, ann)).body as any).requests[0];
    expect(mine).toMatchObject({ status: "approved", priceGbp: 24 });
    const inbox = ((await s.call("GET", "/api/setup", undefined, ann)).body as any).messages;
    expect(inbox.at(-1).text).toContain("MAIZ approved your new specialist");
  });

  it("refuses a thin brief and sends change requests back to the client", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    expect((await s.call("POST", "/api/specialists", { title: "x", purpose: "", duties: [] }, ann)).status).toBe(400);
    const id = ((await s.call("POST", "/api/specialists", brief, ann)).body as any).request.id;
    await s.call("POST", `/api/owner/specialists/${id}/decide`, { decision: "changes_requested", message: "Add who the cafes are" }, s.owner());
    const mine = ((await s.call("GET", "/api/specialists", undefined, ann)).body as any).requests[0];
    expect(mine).toMatchObject({ status: "changes_requested", messageToClient: "Add who the cafes are" });
  });
});

describe("clients screen", () => {
  it("shows every client to the platform owner only, with trial, setup, energy and open reviews", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    await s.signUp("bob@bakery.co", "Bob's Bakery");
    await s.call("POST", "/api/reviews", { title: "Brand kit", employee: "Brand and content creator", days: 5, design: "x", brief: [{ label: "Who", value: "Everyone" }], plan: [{ title: "a", energy: 1 }] }, ann);
    expect((await s.call("GET", "/api/owner/clients", undefined, ann)).status).toBe(403);
    const list = ((await s.call("GET", "/api/owner/clients", undefined, s.owner())).body as any).clients;
    expect(list).toHaveLength(2);
    const kc = list.find((c: any) => c.name === "Kestrel Coffee");
    expect(kc).toMatchObject({ ownerEmail: "ann@kestrel.co", status: "trial", setup: "awaiting_form", employees: 6, openReviews: 1, energyToday: 0 });
    s.clock.d = new Date("2026-12-01T00:00:00Z");
    expect(((await s.call("GET", "/api/owner/clients", undefined, s.owner())).body as any).clients[0].status).toBe("trial_ended");
  });
});
