import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { MockPaymentProvider } from "../src/modules/payments/index.js";
import { CATALOGUE, ONE_PER_BUSINESS, TEAM_PACKAGE_KEY, getItem, isCoreRole, quote, quoteForPlan } from "../src/modules/store/cart.js";
import { DEFAULT_GENERAL, PriceBook } from "../src/modules/pricing/index.js";
import { EMPLOYEE_TEMPLATES, getTemplate } from "../src/modules/workforce/templates.js";
import { getJobDescription, renderJobDescription } from "../src/modules/workforce/job-descriptions.js";
import { skillFiles } from "../src/modules/workforce/skill-files.js";
import { specialistHires } from "../src/modules/workforce/blueprints.js";
import { NEEDS, SECTORS } from "../src/modules/onboarding/sectors.js";
import { guessSector, planSignup } from "../src/modules/onboarding/recommend.js";
import { PERSONAS } from "../src/modules/onboarding/people.js";
import { formFor } from "../src/modules/admin-manager/form.js";
import { SHOP_EMPLOYEE_KEYS, SHOP_RULES } from "../src/modules/ecommerce/rules.js";
import { AuditLog } from "../src/modules/audit/index.js";
import { EventBus } from "../src/core/events.js";
import { IdentityService } from "../src/modules/identity/index.js";
import { ModelGateway } from "../src/modules/model-gateway/gateway.js";
import { WorkforceService } from "../src/modules/workforce/index.js";
import { defaultRegistry } from "../src/modules/integrations/catalogue.js";
import { defaultAccessFor } from "../src/modules/integrations/access.js";
import { summariseArea } from "../src/modules/integrations/areas.js";
import { printful, printify } from "../src/modules/integrations/connectors/dropship-suppliers.js";
import { IntegrationError, type ConnectorContext } from "../src/modules/integrations/types.js";

const KEYS = [...SHOP_EMPLOYEE_KEYS];
const TITLES: Record<string, string> = { "online-shop-manager": "E-commerce manager", "dropshipping-agent": "Dropshipping agent", "marketplace-manager": "Marketplace manager", "shop-care-agent": "Shop customer care agent" };

describe("the online-shop employees exist", () => {
  it("are ready-made add-on employees with plain titles, capabilities and a first job", () => {
    for (const key of KEYS) {
      const t = getTemplate(key)!;
      expect(t.title, key).toBe(TITLES[key]);
      expect(t.kind).toBe("employee");
      expect(EMPLOYEE_TEMPLATES.some((e) => e.key === key)).toBe(true);
      expect(t.capabilities.length).toBeGreaterThanOrEqual(3);
      expect(t.firstJob.length).toBeGreaterThan(10);
      expect(PERSONAS.some((p) => p.key === key), key).toBe(true);
    }
  });

  it("keep the six core employees as they were", () => {
    const core = EMPLOYEE_TEMPLATES.filter((t) => !KEYS.includes(t.key)).map((t) => t.key).sort();
    expect(core).toEqual(["business-consultant", "compliance-manager", "data-mining-agent", "finance-manager", "hr-manager", "marketing-manager", "supply-chain-manager"]);
  });

  it("are not specialist hires, so the twelve specialist hires stay twelve", () => {
    expect(specialistHires()).toHaveLength(12);
    expect(CATALOGUE.filter((i) => i.kind === "specialist")).toHaveLength(12);
  });

  it("have a job description and a skill folder that is up to date", () => {
    const files = skillFiles().map((f) => f.path);
    for (const key of KEYS) {
      const jd = getJobDescription(key)!;
      expect(jd.jobTitle).toBe(TITLES[key]);
      expect(files).toContain(`skills/${key}/SKILL.md`);
      expect(readFileSync(new URL(`../skills/${key}/SKILL.md`, import.meta.url), "utf8")).toContain(`# ${TITLES[key]}`);
    }
  });

  it("get their own setup questions only when hired", () => {
    const base = formFor(["finance-manager"]).map((f) => f.key);
    expect(base).not.toContain("deliveryTerms");
    const withShop = formFor(["finance-manager", ...KEYS]).map((f) => f.key);
    for (const k of ["shopPlatform", "deliveryTerms", "marketplaces", "supplierCountries", "returnsPolicy"]) expect(withShop).toContain(k);
  });
});

describe("the store and the price", () => {
  it("lists each one as a monthly add-on employee at the add-on price, and never as a core role", () => {
    for (const key of KEYS) {
      const item = getItem(key)!;
      expect(item, key).toMatchObject({ kind: "employee", billing: "monthly", priceGbp: 25, title: TITLES[key] });
      expect(isCoreRole(key)).toBe(false);
    }
  });

  it("follow the add-on price and the add-on weekly energy the platform owner sets", () => {
    const book = new PriceBook(() => false);
    for (const key of KEYS) {
      expect(book.weeklyEnergyFor(key), key).toBe(DEFAULT_GENERAL.addOnWeeklyEnergy);
      expect(book.catalogue().find((i) => i.key === key)?.priceGbp).toBe(DEFAULT_GENERAL.addOnEmployeeMonthlyGbp);
    }
  });

  it("are sold once: a cart never holds two, and one already on the team is left out with a plain reason", () => {
    for (const key of KEYS) {
      expect(ONE_PER_BUSINESS.has(key)).toBe(true);
      const q = quote([{ key, qty: 4 }, { key, qty: 2 }]);
      expect(q.lines).toEqual([expect.objectContaining({ key, qty: 1, totalGbp: 25 })]);
      const owned = quoteForPlan([{ key }, { key: "supply-chain-manager" }], true, CATALOGUE, [key]);
      expect(owned.lines.map((l) => l.key)).toEqual(["supply-chain-manager"]);
      expect(owned.rejected).toEqual([{ key, reason: "you already have this employee" }]);
    }
  });

  it("do not change how other add-ons are bought", () => {
    expect(quote([{ key: "supply-chain-manager", qty: 3 }]).lines[0]!.qty).toBe(3);
  });
});

const OWNER = "atif@maiz.test";
function platformSetup() {
  const clock = { d: new Date("2026-11-10T09:00:00Z") };
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d, payments: new MockPaymentProvider() });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  void makeToken; void userIdFor;
  return { platform, call };
}

describe("buying one", () => {
  it("hires it once, adds the add-on energy, and refuses a second purchase", async () => {
    const { platform, call } = platformSetup();
    const r = await call("POST", "/api/signup", { email: "ann@shop.co", businessName: "Kestrel Candles", sells: "Candles online", size: "2–10", country: "GB" });
    const ws = (r.body as any).workspaceId as string;
    const ann = { authorization: `Bearer ${(r.body as any).token}` };

    const first = await call("POST", "/api/checkout", { lines: [{ key: "dropshipping-agent", qty: 3 }] }, ann);
    const hired = (platform.workforce.templatesIn(ws) as string[]).filter((k) => k === "dropshipping-agent");
    const pool = platform.energy.teamEnergyOf(ws)!.pool;
    const again = await call("POST", "/api/checkout", { lines: [{ key: "dropshipping-agent" }] }, ann);

    expect(first.status).toBe(201);
    expect((first.body as any).order.employeeIds).toHaveLength(1);
    expect(hired).toHaveLength(1);
    expect(pool).toBe(DEFAULT_GENERAL.weeklyTeamEnergy + DEFAULT_GENERAL.addOnWeeklyEnergy);
    expect(again.status).toBe(400);
    expect((again.body as any).error).toMatch(/already have this employee/);
    expect((platform.workforce.templatesIn(ws) as string[]).filter((k) => k === "dropshipping-agent")).toHaveLength(1);
  });

  it("shows the paid price in the quote, with the Team package added for a trial client", async () => {
    const { call } = platformSetup();
    const r = await call("POST", "/api/signup", { email: "bo@shop.co", businessName: "Bo Prints", sells: "Mugs", size: "Just me", country: "GB" });
    const bo = { authorization: `Bearer ${(r.body as any).token}` };
    const q = (await call("POST", "/api/cart/quote", { lines: [{ key: "marketplace-manager" }] }, bo)).body as any;
    expect(q.dueTodayGbp).toBe(150 + 25);
  });
});

describe("who is offered them at signup", () => {
  const base = { businessName: "Kestrel Candles", country: "GB" };
  it("suggests the E-commerce manager and the shop care agent to an online store, as offers and never added silently", () => {
    const plan = planSignup({ ...base, sector: "online-store" });
    expect(plan.addOns.map((a) => a.key).sort()).toEqual(["online-shop-manager", "shop-care-agent"]);
    expect(plan.team.some((m) => KEYS.includes(m.key))).toBe(false);
  });
  it("suggests the Dropshipping agent to a dropshipping business", () => {
    expect(planSignup({ ...base, sector: "dropshipping" }).addOns.map((a) => a.key)).toContain("dropshipping-agent");
  });
  it("suggests the Marketplace manager to a marketplace seller", () => {
    expect(planSignup({ ...base, sector: "marketplace-seller" }).addOns.map((a) => a.key)).toContain("marketplace-manager");
  });
  it("puts an accepted one on the team, led by the job it was asked for, with the employee's own title", () => {
    const plan = planSignup({ ...base, sector: "dropshipping", addOns: ["dropshipping-agent"] });
    const m = plan.team.find((t) => t.key === "dropshipping-agent")!;
    expect(m).toMatchObject({ focus: true, title: "Dropshipping agent" });
    expect(m.firstJob).toMatch(/margin and supplier check/);
  });
  it("does not offer them to a café", () => {
    expect(planSignup({ ...base, sector: "food-drink" }).addOns).toEqual([]);
  });
  it("recognises online sellers from a few words", () => {
    expect(guessSector("I dropship phone cases from a Shopify store")).toBe("dropshipping");
    expect(guessSector("Handmade candles on Etsy")).toBe("marketplace-seller");
    expect(guessSector("I run a Shopify store for pet food")).toBe("online-store");
    expect(guessSector("Print on demand t-shirts")).toBe("dropshipping");
  });
  it("gives every new sector three needs that exist, and every new need a lead who exists", () => {
    const needKeys = new Set(NEEDS.map((n) => n.key));
    for (const key of ["online-store", "dropshipping", "marketplace-seller"]) {
      const s = SECTORS.find((x) => x.key === key)!;
      expect(s.needs).toHaveLength(3);
      for (const n of s.needs) expect(needKeys.has(n), `${key}:${n}`).toBe(true);
    }
    for (const n of NEEDS.filter((x) => KEYS.includes(x.lead))) expect(getTemplate(n.lead)).toBeDefined();
  });
});

describe("honesty and consumer-law rules", () => {
  it("are in every employee's instructions, word for word", () => {
    for (const key of KEYS) for (const rule of SHOP_RULES) expect(getTemplate(key)!.instructions, key).toContain(rule);
  });

  it("are in every job description as things it never does, and every one needs approval before acting", () => {
    for (const key of KEYS) {
      const jd = getJobDescription(key)!;
      const never = jd.authority.never.join(" | ").toLowerCase();
      expect(never, key).toContain("fake review");
      expect(never, key).toContain("fake countdown");
      expect(never, key).toContain("invent");
      expect(never, key).toContain("certified");
      expect(jd.authority.needsApproval.length, key).toBeGreaterThan(0);
      expect(jd.legal.join(" ").toLowerCase(), key).toMatch(/14 day|14 days/);
      expect(jd.escalate.join(" "), key).toMatch(/Compliance manager/);
    }
  });

  it("state delivery times as honestly as the supplier does, and never promise profit", () => {
    const d = getTemplate("dropshipping-agent")!.instructions;
    expect(d).toMatch(/range/);
    expect(d).toMatch(/never promise profit/);
    expect(getJobDescription("dropshipping-agent")!.authority.never.join(" ")).toMatch(/Promise the owner a profit/);
  });

  it("tell the client to check local rules and never give legal advice", () => {
    for (const key of KEYS) {
      const text = getTemplate(key)!.instructions;
      expect(text).toMatch(/differ by country/);
      expect(text).toMatch(/do not give legal advice/);
    }
  });

  it("are shown to the model on every task, and a draft that slips gets a plain warning under it", async () => {
    const audit = new AuditLog();
    const bus = new EventBus();
    const identity = new IdentityService(audit, bus);
    const seen: string[] = [];
    const gateway = new ModelGateway([{ name: "spy", tiers: ["standard", "premium"], complete: async (r: any) => { seen.push(r.messages[0].content); return { text: "Only 3 left! Selling fast. No returns.", provider: "spy", inputTokens: 1, outputTokens: 1 }; } } as any]);
    const workforce = new WorkforceService(identity, audit, bus, gateway);
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    const e = await workforce.hire("owner", ws.id, "online-shop-manager");
    const task = await workforce.assign("owner", ws.id, e.id, "Write a product page for my candle");
    expect(seen[0]).toContain("Your job description: E-commerce manager");
    expect(seen[0]).toContain("Never use a fake countdown");
    expect(task.deliverable).toContain("Only 3 left!");
    expect(task.deliverable).toMatch(/Check before you use this/);
    expect(task.deliverable).toMatch(/14 days/);

    const other = await workforce.hire("owner", ws.id, "marketing-manager");
    const plain = await workforce.assign("owner", ws.id, other.id, "Write a post");
    expect(plain.deliverable).toBe("Only 3 left! Selling fast. No returns.");
  });

  it("render in the job description the employee works to", () => {
    const text = renderJobDescription(getJobDescription("shop-care-agent")!);
    expect(text).toContain("Issue or promise a refund");
  });
});

describe("what each reads from connected apps", () => {
  it("lets the shop employees see shop figures, and only the right ones see supplier figures", () => {
    expect(defaultAccessFor(["sales.read"])).toEqual(expect.arrayContaining(["online-shop-manager", "marketplace-manager", "dropshipping-agent", "shop-care-agent"]));
    expect(defaultAccessFor(["suppliers.read"])).toEqual(["dropshipping-agent", "online-shop-manager", "business-consultant"]);
    expect(defaultAccessFor(["suppliers.read"])).not.toContain("marketing-manager");
  });
  it("lists Printful and Printify as connecting directly, CJ Dropshipping as planned, and the marketplaces as waiting for approval", () => {
    const r = defaultRegistry();
    expect(r.get("printful")).toMatchObject({ availability: "live", capabilities: ["suppliers.read"] });
    expect(r.get("printify")).toMatchObject({ availability: "live" });
    expect(r.get("cj-dropshipping")).toMatchObject({ availability: "planned" });
    for (const k of ["etsy", "amazon-seller", "ebay"]) expect(r.get(k)?.availability).toBe("approval");
  });
});

// ---------- supplier connectors, against fake servers in the shape the providers document ----------

type Route = [RegExp, (url: URL) => unknown];
function ctxFor(routes: Route[], values: Record<string, string>) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const http = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> });
    for (const [re, fn] of routes) if (re.test(String(url))) return new Response(JSON.stringify(fn(new URL(String(url)))), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const ctx: ConnectorContext = { credentials: { kind: "api_key", values }, http, now: () => new Date("2026-11-10T12:00:00Z"), currency: "GBP" };
  return { ctx, seen };
}
const RANGE = { from: "2026-10-12", to: "2026-11-10" };
const unix = (d: string) => Math.floor(Date.parse(`${d}T10:00:00Z`) / 1000);

describe("Printful (fake server, not the real service)", () => {
  const routes: Route[] = [
    [/orders\?status=pending/, () => ({ paging: { total: 2 }, result: [] })],
    [/orders\?status=inprocess/, () => ({ paging: { total: 3 }, result: [] })],
    [/orders\?status=partial/, () => ({ paging: { total: 0 }, result: [] })],
    [/orders\?status=failed/, () => ({ paging: { total: 9 }, result: [{ id: 1, created: unix("2026-11-02") }, { id: 2, created: unix("2025-01-02") }] })],
    [/orders\?status=onhold/, () => ({ paging: { total: 1 }, result: [{ id: 3, created: unix("2026-11-05") }] })],
    [/orders\?status=fulfilled/, () => ({ paging: { total: 50 }, result: [{ id: 4, created: unix("2026-11-03") }, { id: 5, created: unix("2026-11-03") }, { id: 6, created: unix("2024-03-03") }] })],
    [/store\/products\?status=out_of_stock/, () => ({ paging: { total: 4 }, result: [] })],
    [/store\/products\?status=discontinued/, () => ({ paging: { total: 1 }, result: [] })],
  ];

  it("sends the token as a Bearer header to Printful only, and turns the answers into counts", async () => {
    const { ctx, seen } = ctxFor(routes, { token: "pf_tok_abcdefghijklmnopqrstuvwx" });
    const out = await printful.read!(ctx, RANGE);
    expect(seen.every((s) => s.url.startsWith("https://api.printful.com/"))).toBe(true);
    expect(seen.every((s) => s.headers.authorization === "Bearer pf_tok_abcdefghijklmnopqrstuvwx")).toBe(true);
    const figures = Object.assign({}, ...out.activity!.map((d) => d.figures));
    expect(figures).toMatchObject({ ordersOpen: 5, ordersProblem: 2, ordersFulfilled: 2, outOfStock: 5 });
    expect(out.activity!.every((d) => d.area === "supply")).toBe(true);
  });

  it("reads as plain words for the employee, with no shopper details anywhere", async () => {
    const { ctx } = ctxFor(routes, { token: "pf_tok_abcdefghijklmnopqrstuvwx" });
    const out = await printful.read!(ctx, RANGE);
    const line = summariseArea("Printful", out.activity!, "2026-11-10")!;
    expect(line).toContain("5 supplier orders still being made or sent");
    expect(line).toContain("2 supplier orders with a problem or on hold");
    expect(line).toContain("5 products out of stock or unavailable");
  });

  it("says plainly when Printful refuses the token", async () => {
    const http = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(printful.read!({ credentials: { kind: "api_key", values: { token: "x".repeat(30) } }, http, now: () => new Date(), currency: "GBP" }, RANGE)).rejects.toThrow(IntegrationError);
  });

  it("rejects a token with spaces or a pasted sentence", () => {
    expect(printful.validate!({ token: "my token is here" })).toMatch(/single code/);
    expect(printful.validate!({ token: "a".repeat(40) })).toBeUndefined();
  });
});

describe("Printify (fake server, not the real service)", () => {
  const routes: Route[] = [
    [/shops\.json$/, () => [{ id: 77, title: "My shop" }]],
    [/shops\/77\/orders\.json/, () => ({ current_page: 1, last_page: 1, data: [
      { id: "a", status: "fulfilled", created_at: "2026-11-02T10:00:00Z", line_items: [{ status: "fulfilled" }] },
      { id: "b", status: "in-production", created_at: "2026-11-08T10:00:00Z", line_items: [{ status_details: "out_of_stock" }] },
      { id: "c", status: "pending", created_at: "2026-11-09T10:00:00Z", line_items: [{}] },
      { id: "d", status: "canceled", created_at: "2026-11-09T10:00:00Z", line_items: [{}] },
      { id: "e", status: "fulfilled", created_at: "2024-01-01T10:00:00Z", line_items: [{}] },
    ] })],
    [/shops\/77\/products\.json/, () => ({ current_page: 1, last_page: 1, data: [
      { id: "p1", variants: [{ is_enabled: true, is_available: true }] },
      { id: "p2", variants: [{ is_enabled: true, is_available: false }, { is_enabled: true, is_available: true }] },
      { id: "p3", variants: [{ is_enabled: false, is_available: false }] },
    ] })],
  ];

  it("names itself, sends the token as a Bearer header to Printify only, and counts orders and unavailable products", async () => {
    const { ctx, seen } = ctxFor(routes, { token: "eyJ" + "a".repeat(900) });
    const out = await printify.read!(ctx, RANGE);
    expect(seen.every((s) => s.url.startsWith("https://api.printify.com/v1/"))).toBe(true);
    expect(seen.every((s) => s.headers["user-agent"] === "MAIZ-Agents" && s.headers.authorization?.startsWith("Bearer eyJ"))).toBe(true);
    const figures = Object.assign({}, ...out.activity!.map((d) => d.figures));
    expect(figures).toMatchObject({ ordersOpen: 2, ordersProblem: 1, ordersFulfilled: 1, outOfStock: 1 });
  });

  it("accepts a very long token and fits the key box for it", () => {
    expect(printify.validate!({ token: "eyJ" + "a".repeat(1200) })).toBeUndefined();
    const field = (printify.auth as unknown as { fields: { maxLength?: number }[] }).fields[0]!;
    expect(field.maxLength).toBeGreaterThanOrEqual(1500);
  });

  it("tells the client when the token shows no shop", async () => {
    const { ctx } = ctxFor([[/shops\.json$/, () => []]], { token: "t".repeat(40) });
    await expect(printify.read!(ctx, RANGE)).rejects.toThrow(/no shop/);
  });
});

describe("the apps the plan offers", () => {
  it("only ever name a connector that exists", () => {
    const r = defaultRegistry();
    const apps = SECTORS.flatMap((s) => s.apps);
    for (const k of apps.filter((a) => a !== "slack")) expect(r.get(k), k).toBeDefined();
  });
  it("keeps the team package out of the one-per-employee rule", () => {
    expect(ONE_PER_BUSINESS.has(TEAM_PACKAGE_KEY)).toBe(false);
  });
});
