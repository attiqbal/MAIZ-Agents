import { describe, expect, it } from "vitest";
import { AuditLog, EnergyMeter, EventBus, IdentityService } from "../src/index.js";
import { PLANS, type EnergyPlan } from "../src/modules/energy/index.js";
import { DEFAULT_GENERAL, PricingError, parseChange } from "../src/modules/pricing/index.js";
import { PAID_SERVICES, PaidServiceError, PaidServices, RenderError, cleanRender, paidService, quoteFor, MAX_PAID_USES_PER_DAY } from "../src/modules/paid-services/index.js";
import { defaultRegistry } from "../src/modules/integrations/catalogue.js";
import { BUSINESS_APPS } from "../src/modules/integrations/business-apps.js";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";

const TEAM: EnergyPlan = { ...PLANS.starter!, weeklyTeamEnergy: 8_000, dailyTeamCeiling: 3_000 };
const KEY = "creatomate-key-0123456789abcdef";
const TEMPLATE = "tmpl-1234-abcd";

interface Call { url: string; headers: Record<string, string>; body: string }
function fakeVendor(answer: (c: Call) => { status?: number; json?: unknown } = () => ({ json: [{ id: "render-1", status: "planned" }] })) {
  const calls: Call[] = [];
  const http = (async (url: any, init: any = {}) => {
    const c = { url: String(url), headers: init.headers ?? {}, body: String(init.body ?? "") };
    calls.push(c);
    const a = answer(c);
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { http, calls };
}

async function desk(opts: { keys?: { creatomate?: string; shotstack?: string }; plan?: EnergyPlan; multiplier?: () => number; answer?: Parameters<typeof fakeVendor>[0] } = {}) {
  const audit = new AuditLog();
  const identity = new IdentityService(audit, new EventBus());
  const clock = { d: new Date("2026-11-17T10:00:00Z") };
  const energy = new EnergyMeter(identity, audit, () => clock.d);
  const ws = (await identity.createWorkspace("owner", { name: "Acme" })).id;
  energy.setPlan("owner", ws, opts.plan ?? TEAM);
  const vendor = fakeVendor(opts.answer);
  const paid = new PaidServices({ meter: energy, multiplier: opts.multiplier ?? (() => 2), keys: () => opts.keys ?? {}, http: vendor.http, now: () => clock.d });
  const payer = { kind: "client" as const, workspaceId: ws, employeeId: "emp-1" };
  return { paid, energy, ws, payer, ...vendor, clock };
}
const input = { templateId: TEMPLATE, fields: { Text: "Hello" } };

describe("paid services: the double-energy rule", () => {
  it("doubles the plain cost by default and follows the owner's one setting", () => {
    const c = paidService("creatomate")!;
    expect(DEFAULT_GENERAL.paidServiceMultiplier).toBe(2);
    expect(quoteFor(c, 2)).toEqual({ service: "creatomate", baseEnergy: 100, multiplier: 2, energy: 200 });
    expect(quoteFor(c, 1).energy).toBe(100);
    expect(quoteFor(c, 2.5).energy).toBe(250);
    // A nonsense multiplier falls back to double rather than making paid work free.
    expect(quoteFor(c, 0).energy).toBe(200);
    expect(quoteFor(c, Number.NaN).energy).toBe(200);
  });

  it("lets the owner change the multiplier from 1 to 10 and nothing else", () => {
    expect(parseChange({ general: { paidServiceMultiplier: 3 } }).set.general).toEqual({ paidServiceMultiplier: 3 });
    expect(parseChange({ general: { paidServiceMultiplier: 1.5 } }).set.general).toEqual({ paidServiceMultiplier: 1.5 });
    expect(() => parseChange({ general: { paidServiceMultiplier: 0.5 } })).toThrow(PricingError);
    expect(() => parseChange({ general: { paidServiceMultiplier: 11 } })).toThrow(PricingError);
  });

  it("refuses to run until the exact cost has been sent back, and says the cost", async () => {
    const { paid, payer, calls, energy, ws } = await desk({ keys: { creatomate: KEY } });
    const refused = await paid.render(payer, "creatomate", input, undefined).catch((e) => e);
    expect(refused).toBeInstanceOf(PaidServiceError);
    expect(refused.quote).toMatchObject({ energy: 200, baseEnergy: 100, multiplier: 2 });
    expect(refused.message).toMatch(/200 energy/);
    // A stale figure (the owner changed the rule since the person looked) is refused too.
    await expect(paid.render(payer, "creatomate", input, 100)).rejects.toBeInstanceOf(PaidServiceError);
    expect(calls).toHaveLength(0);
    expect(energy.teamEnergyOf(ws)!.used).toBe(0);
  });

  it("charges the multiplied energy to the team pool once the service accepts the job, and keeps the real cost", async () => {
    const { paid, payer, calls, energy, ws } = await desk({ keys: { creatomate: KEY } });
    const use = await paid.render(payer, "creatomate", input, 200);
    expect(use).toMatchObject({ energy: 200, simulated: false, render: { id: "render-1", status: "pending" } });
    expect(calls[0]!.url).toBe("https://api.creatomate.com/v1/renders");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0]!.body)).toEqual({ template_id: TEMPLATE, modifications: { Text: "Hello" } });
    expect(energy.teamEnergyOf(ws)!.used).toBe(200);
    // The hidden cost cap counts what it really cost us (100,000 micro-dollars), not the doubled figure.
    expect(energy.usageOf(ws)).toMatchObject({ energyMonth: 200, costMicroMonth: 100_000 });
    expect(JSON.stringify(use)).not.toContain(KEY);
  });

  it("uses the owner's new multiplier on the very next quote", async () => {
    let m = 2;
    const { paid, payer, energy, ws } = await desk({ keys: { shotstack: KEY }, multiplier: () => m, answer: () => ({ json: { success: true, response: { id: "shot-1" } } }) });
    expect(paid.quote("shotstack").energy).toBe(400);
    m = 3;
    expect(paid.quote("shotstack").energy).toBe(600);
    await expect(paid.render(payer, "shotstack", input, 400)).rejects.toMatchObject({ quote: { energy: 600 } });
    await paid.render(payer, "shotstack", input, 600);
    expect(energy.teamEnergyOf(ws)!.used).toBe(600);
  });

  it("runs a practice render with no key: nothing is called and nothing is charged", async () => {
    const { paid, payer, calls, energy, ws } = await desk();
    expect(paid.quote("creatomate")).toMatchObject({ simulated: true, energy: 200 });
    const use = await paid.render(payer, "creatomate", input, 200);
    expect(use).toMatchObject({ simulated: true, energy: 0, render: { status: "done" } });
    expect(calls).toHaveLength(0);
    expect(energy.teamEnergyOf(ws)!.used).toBe(0);
  });

  it("does not start when the pool cannot cover the whole cost, and charges nothing when the service refuses", async () => {
    const poor = await desk({ keys: { creatomate: KEY }, plan: { ...TEAM, weeklyTeamEnergy: 150 } });
    await expect(poor.paid.render(poor.payer, "creatomate", input, 200)).rejects.toThrow(/not enough energy left this week/);
    expect(poor.calls).toHaveLength(0);

    const refused = await desk({ keys: { creatomate: KEY }, answer: () => ({ status: 401 }) });
    await expect(refused.paid.render(refused.payer, "creatomate", input, 200)).rejects.toBeInstanceOf(RenderError);
    expect(refused.energy.teamEnergyOf(refused.ws)!.used).toBe(0);
  });

  it("takes what the pool has first and the rest from bought top-ups", async () => {
    const d = await desk({ keys: { creatomate: KEY }, plan: { ...TEAM, weeklyTeamEnergy: 150, topUpEnergyBought: 500 } });
    await d.paid.render(d.payer, "creatomate", input, 200);
    const team = d.energy.teamEnergyOf(d.ws)!;
    expect(team.left).toBe(0);
    expect(team.topUpLeft).toBe(450);
  });

  it("stops a runaway at the daily safety limit", async () => {
    const d = await desk();
    for (let i = 0; i < MAX_PAID_USES_PER_DAY; i++) await d.paid.render(d.payer, "creatomate", input, 200);
    await expect(d.paid.render(d.payer, "creatomate", input, 200)).rejects.toThrow(/daily safety limit/);
  });

  it("checks a started render without charging again, and only for the payer who asked", async () => {
    const d = await desk({ keys: { creatomate: KEY }, answer: (c) => (c.url.endsWith("/renders") ? { json: [{ id: "render-1", status: "planned" }] } : { json: { id: "render-1", status: "succeeded", url: "https://cdn.creatomate.com/renders/render-1.mp4" } }) });
    const use = await d.paid.render(d.payer, "creatomate", input, 200);
    const done = await d.paid.status(d.payer, use.id);
    expect(done.render).toMatchObject({ status: "done", url: "https://cdn.creatomate.com/renders/render-1.mp4" });
    expect(d.energy.teamEnergyOf(d.ws)!.used).toBe(200);
    await expect(d.paid.status({ kind: "client", workspaceId: "someone-else", employeeId: "x" }, use.id)).rejects.toThrow(/not found/);
  });

  it("cleans what goes to a paid service", () => {
    expect(cleanRender({ templateId: ` ${TEMPLATE} `, fields: { Text: " Hi ", Picture: "https://example.com/a.png" } })).toEqual({ templateId: TEMPLATE, fields: { Text: "Hi", Picture: "https://example.com/a.png" } });
    expect(() => cleanRender({ templateId: "../etc", fields: {} })).toThrow(RenderError);
    expect(() => cleanRender({ templateId: TEMPLATE, fields: { Picture: "http://10.0.0.1/a.png" } })).toThrow(/https/);
    expect(() => cleanRender({ templateId: TEMPLATE, fields: { Picture: "file:///etc/passwd" } })).toThrow(/https/);
    expect(() => cleanRender({ templateId: TEMPLATE, fields: { "bad{slot}": "x" } })).toThrow(RenderError);
    expect(() => cleanRender({ templateId: TEMPLATE, fields: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`s${i}`, "x"])) })).toThrow(/at most/);
  });

  it("lists all nine video services honestly and never shows what they cost us", async () => {
    const { paid } = await desk();
    const list = paid.list();
    expect(list.map((s) => s.key)).toEqual(["creatomate", "shotstack", "canva", "adobe-express", "veed", "kapwing", "invideo", "envato", "motion-array"]);
    expect(list.filter((s) => s.kind === "api").map((s) => s.key)).toEqual(["creatomate", "shotstack"]);
    expect(list.every((s) => s.estCostMicro === undefined)).toBe(true);
    expect(() => paid.quote("canva")).toThrow(PaidServiceError);
    for (const s of PAID_SERVICES.filter((x) => x.kind !== "api")) expect(s.note).toMatch(/Not built|never downloads/);
  });
});

describe("paid services through the site", () => {
  const OWNER = "atif@maiz.test";
  const now = new Date("2026-11-20T09:00:00Z");
  function site(answer?: Parameters<typeof fakeVendor>[0]) {
    const vendor = fakeVendor(answer);
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, platformOwners: [OWNER], appUrl: "https://maizagents.com", now: () => now, http: vendor.http });
    const app = createApp(platform);
    const owner = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(OWNER), e: OWNER }, 86400, now.getTime())}` };
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = owner) =>
      app({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
    return { call, platform, ...vendor };
  }

  it("the promotion agent makes a video only from an approved draft, after the cost is confirmed", async () => {
    const { call, calls } = site();
    const d = (await call("POST", "/api/owner/promoter/drafts", { site: "maizagents", channel: "social", brief: "Launch week" })).body as any;
    const id = d.draft.id;
    const body = { service: "creatomate", templateId: TEMPLATE };
    // Not approved yet: refused whatever is confirmed.
    expect((await call("POST", `/api/owner/promoter/drafts/${id}/video`, { ...body, confirmEnergy: 200 })).status).toBe(400);
    await call("POST", `/api/owner/promoter/drafts/${id}/approve`, {});
    // Approved but the cost has not been seen: 409 with the figure.
    const ask = await call("POST", `/api/owner/promoter/drafts/${id}/video`, body);
    expect(ask.status).toBe(409);
    expect((ask.body as any).quote).toMatchObject({ energy: 200, multiplier: 2 });
    const made = await call("POST", `/api/owner/promoter/drafts/${id}/video`, { ...body, confirmEnergy: 200 });
    expect(made.status).toBe(200);
    const draft = (made.body as any).drafts.find((x: any) => x.id === id);
    // No key was saved, so this was a practice render and no vendor was called.
    expect(draft.video).toMatchObject({ service: "creatomate", simulated: true, energy: 0, status: "done" });
    expect(draft.status).toBe("approved");
    expect(calls.filter((c) => c.url.includes("creatomate"))).toHaveLength(0);
  });

  it("goes live when the owner saves a key on the Connections page, and never sends the key back", async () => {
    const { call, calls } = site((c) => (c.url.includes("/templates") ? { json: [] } : { json: [{ id: "render-9", status: "planned" }] }));
    const saved = await call("PUT", "/api/owner/connections/creatomate", { fields: { apiKey: KEY } });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(KEY);
    const tested = await call("POST", "/api/owner/connections/creatomate/test", {});
    expect(JSON.stringify(tested.body)).toMatch(/accepted the key/);
    const services = (await call("GET", "/api/owner/promoter/video-services")).body as any;
    expect(services.services.find((s: any) => s.key === "creatomate")).toMatchObject({ connected: true, quote: { energy: 200, simulated: false } });
    const id = ((await call("POST", "/api/owner/promoter/drafts", { site: "examutor", channel: "social", brief: "Mock exams" })).body as any).draft.id;
    await call("POST", `/api/owner/promoter/drafts/${id}/approve`, {});
    const made = await call("POST", `/api/owner/promoter/drafts/${id}/video`, { service: "creatomate", templateId: TEMPLATE, textSlot: "Headline", confirmEnergy: 200 });
    expect(made.status).toBe(200);
    const sent = calls.find((c) => c.url === "https://api.creatomate.com/v1/renders")!;
    expect(Object.keys(JSON.parse(sent.body).modifications)).toEqual(["Headline"]);
    expect((made.body as any).drafts.find((x: any) => x.id === id).video).toMatchObject({ simulated: false, energy: 200, status: "pending" });
    expect(JSON.stringify(made.body)).not.toContain(KEY);
  });

  it("shows the owner's multiplier on the Prices page and applies a change to the next quote", async () => {
    const { call } = site();
    const book = (await call("GET", "/api/owner/prices")).body as any;
    expect(book.general.paidServiceMultiplier).toBe(2);
    expect((await call("POST", "/api/owner/prices/changes", { general: { paidServiceMultiplier: 3 } })).status).toBeLessThan(300);
    const services = (await call("GET", "/api/owner/promoter/video-services")).body as any;
    expect(services.services.find((s: any) => s.key === "creatomate").quote).toMatchObject({ energy: 300, multiplier: 3 });
  });

  it("keeps the video services away from people who are not the owner", async () => {
    const { call } = site();
    const other = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor("x@y.test"), e: "x@y.test" }, 86400, now.getTime())}` };
    expect((await call("GET", "/api/owner/promoter/video-services", undefined, other)).status).toBe(403);
    expect((await call("PUT", "/api/owner/connections/creatomate", { fields: { apiKey: KEY } }, other)).status).toBe(403);
  });
});

describe("the wider business app list", () => {
  it("adds every app once, honestly marked as not built, with the Zapier or Make route", () => {
    const registry = defaultRegistry();
    expect(BUSINESS_APPS.length).toBeGreaterThan(150);
    expect(new Set(registry.list().map((c) => c.key)).size).toBe(registry.list().length);
    for (const c of BUSINESS_APPS) {
      expect(registry.get(c.key)).toBe(c);
      expect(c.auth.kind).toBe("bridge");
      expect(["planned", "partner"]).toContain(c.availability);
      expect(c.read).toBeUndefined();
      expect(c.note).toMatch(/not built yet/i);
      expect(c.note).toMatch(/Zapier or Make/);
      expect(c.summary.length).toBeGreaterThan(15);
    }
  });
});
