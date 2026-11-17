import { describe, expect, it } from "vitest";
import { AuditLog, EnergyMeter, EventBus, IdentityService, ModelGateway, RoutingGateway, RoutingSettingsStore, SpendLedger, WorkforceService, defaultSettings } from "../src/index.js";
import { ProviderError, type CompletionRequest, type CompletionResult, type ModelAdapter } from "../src/modules/model-gateway/types.js";
import { PLANS } from "../src/modules/energy/index.js";
import {
  MAX_GUIDE_CHARS, ResourceRegistry, chooseResource, clientSummary, cheaperAlternatives, renderGuide, suggestionsForTask, usageTable, usedBy, worthSampling, type Resource, type ResourceSources,
} from "../src/modules/resources/index.js";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";

const res = (r: Partial<Resource> & { key: string }): Resource => ({
  kind: "app", name: r.key, goodFor: "x", gives: [], state: "ready", allowed: true, cost: { class: "known" }, needsApproval: false, ...r,
});

describe("the cost-aware choice rule", () => {
  const known = res({ key: "app:square", name: "Square", gives: ["sales"], cost: { class: "known" } });
  const energy = res({ key: "source:reddit", name: "Reddit", gives: ["public-opinion"], cost: { class: "energy", energy: 5 }, needsApproval: true });
  const paid = res({ key: "source:x", name: "X", gives: ["public-opinion"], cost: { class: "double_energy", energy: 100 }, needsApproval: true });
  const video = res({ key: "paid:creatomate", name: "Creatomate", gives: ["video"], cost: { class: "double_energy", energy: 200 }, needsApproval: true });

  it("uses what is already known before anything that costs energy", () => {
    const other = res({ key: "source:news", gives: ["sales"], cost: { class: "energy", energy: 5 } });
    expect(chooseResource({ tag: "sales" }, [other, known]).use?.key).toBe("app:square");
  });

  it("ranks known, then free, then energy, then double energy, whatever order they are listed in", () => {
    const free = res({ key: "a:free", gives: ["t"], cost: { class: "free" } });
    const e = res({ key: "b:energy", gives: ["t"], cost: { class: "energy", energy: 3 } });
    const d = res({ key: "c:double", gives: ["t"], cost: { class: "double_energy", energy: 9 } });
    const k = res({ key: "z:known", gives: ["t"], cost: { class: "known" } });
    const all = [d, e, free, k];
    expect(chooseResource({ tag: "t", essential: true }, all).use?.key).toBe("z:known");
    expect(chooseResource({ tag: "t", essential: true }, [...all].reverse()).use?.key).toBe("z:known");
    expect(chooseResource({ tag: "t", essential: true }, [d, e, free]).use?.key).toBe("a:free");
    expect(chooseResource({ tag: "t", essential: true }, [d, e]).use?.key).toBe("b:energy");
  });

  it("never uses a paid service to produce what a free source gives", () => {
    const c = chooseResource({ tag: "public-opinion", essential: true }, [paid, energy]);
    expect(c.use?.key).toBe("source:reddit");
    expect(c.askFirst).toBe(true);
    expect(c.skipped).toContainEqual({ key: "source:x", reason: "cheaper_exists" });
  });

  it("uses a paid service only when the task truly needs it, and then with the quote to show first", () => {
    expect(chooseResource({ tag: "video" }, [video]).use).toBeUndefined();
    expect(chooseResource({ tag: "video" }, [video]).skipped).toContainEqual({ key: "paid:creatomate", reason: "not_essential" });
    const c = chooseResource({ tag: "video", essential: true }, [video]);
    expect(c.use?.key).toBe("paid:creatomate");
    expect(c.askFirst).toBe(true);
    expect(c.quoteEnergy).toBe(200);
  });

  it("never picks money, never offers what the employee may not use, and names what would help once connected", () => {
    const hire = res({ key: "dataset:new", gives: ["news"], cost: { class: "money" } });
    expect(chooseResource({ tag: "news", essential: true }, [hire]).use).toBeUndefined();
    const off = res({ key: "app:xero", gives: ["books"], state: "not_connected" });
    const barred = res({ key: "app:payroll", gives: ["books"], state: "not_connected", allowed: false });
    const c = chooseResource({ tag: "books", essential: true }, [barred, off]);
    expect(c.use).toBeUndefined();
    expect(c.missing?.key).toBe("app:xero");
    expect(chooseResource({ tag: "books" }, [barred]).missing).toBeUndefined();
  });

  it("points a paid service at the cheaper one that gives the same thing", () => {
    expect(cheaperAlternatives([paid, energy]).get("source:x")?.key).toBe("source:reddit");
    expect(cheaperAlternatives([paid]).size).toBe(0);
  });

  it("skips a routine quality check only for a one-line answer with no figure, never for the strongest lane", () => {
    expect(worthSampling("Done.", "standard")).toBe(false);
    expect(worthSampling("Done: 3 posts.", "standard")).toBe(true);
    expect(worthSampling("x".repeat(200), "standard")).toBe(true);
    expect(worthSampling("Done.", "premium")).toBe(true);
  });
});

/** Fake modules, so the registry is tested without a platform. */
function sources(over: Partial<ResourceSources> = {}): ResourceSources {
  return {
    team: () => [{ templateKey: "marketing-manager" }, { templateKey: "finance-manager" }, { templateKey: "admin-manager" }, { templateKey: "data-mining-agent" }],
    hasProfile: () => true,
    apps: () => [
      { key: "square", name: "Square", category: "till", availability: "live", capabilities: ["sales.read"], connect: "oauth", defaultAccess: ["finance-manager", "marketing-manager"] },
      { key: "ga4", name: "Google Analytics", category: "marketing", availability: "live", capabilities: ["traffic.read"], connect: "oauth", defaultAccess: ["marketing-manager"] },
      { key: "payroll-x", name: "Payroll X", category: "payroll", availability: "partner", capabilities: ["payroll.read"], connect: "bridge", defaultAccess: ["finance-manager"] },
    ],
    connections: () => [],
    mining: () => ({ hired: false, sources: [], datasets: [] }),
    paid: () => [],
    records: () => [],
    now: () => new Date("2026-11-16T10:00:00Z"),
    ...over,
  };
}

describe("the resource registry", () => {
  it("lists a new app from the catalogue without any change here", () => {
    const r = new ResourceRegistry(sources({ apps: () => [{ key: "brand-new", name: "Brand New", category: "x", availability: "live", capabilities: ["sales.read"], connect: "oauth", defaultAccess: ["marketing-manager"] }] }));
    expect(r.forEmployee("u", "w", "marketing-manager").find((x) => x.key === "app:brand-new")).toMatchObject({ state: "not_connected", allowed: true });
  });

  it("marks an app ready only when connected, and follows the owner's access list", () => {
    const r = new ResourceRegistry(sources({ connections: () => [{ connectorKey: "square", status: "connected", access: ["finance-manager"], lastSyncAt: "2026-11-16T08:00:00Z" }] }));
    const marketing = r.forEmployee("u", "w", "marketing-manager").find((x) => x.key === "app:square")!;
    const finance = r.forEmployee("u", "w", "finance-manager").find((x) => x.key === "app:square")!;
    expect(finance).toMatchObject({ state: "ready", allowed: true, freshness: "read today" });
    expect(marketing.allowed).toBe(false);
  });

  it("never gives the Admin manager app data, even when the owner's list names it", () => {
    const r = new ResourceRegistry(sources({ connections: () => [{ connectorKey: "square", status: "connected", access: ["admin-manager"], lastSyncAt: "2026-11-16T08:00:00Z" }] }));
    expect(r.forEmployee("u", "w", "admin-manager").find((x) => x.key === "app:square")!.allowed).toBe(false);
  });

  it("says an app with no direct connection yet is waiting for MAIZ, not something the client can fix", () => {
    const x = new ResourceRegistry(sources()).forEmployee("u", "w", "finance-manager").find((r) => r.key === "app:payroll-x")!;
    expect(x.state).toBe("waiting_approval");
    expect(x.fix?.by).toBe("maiz");
  });

  it("refuses an employee that is not on the team, and a person who is not a member", () => {
    expect(() => new ResourceRegistry(sources()).forEmployee("u", "w", "hr-manager")).toThrow("employee not found");
    expect(() => new ResourceRegistry(sources({ team: () => { throw new Error("you don't have permission"); } })).forEmployee("stranger", "w", "marketing-manager")).toThrow("permission");
  });

  it("keeps working when one module fails: that module's resources are dropped, the rest stay", () => {
    const r = new ResourceRegistry(sources({ mining: () => { throw new Error("boom"); } })).forEmployee("u", "w", "marketing-manager");
    expect(r.some((x) => x.key === "app:square")).toBe(true);
    expect(r.some((x) => x.kind === "data-source")).toBe(false);
  });

  it("only the Data mining agent gathers; the rest see datasets shared with them, and are pointed to Market data", () => {
    const mining = { hired: true, sources: [{ id: "reddit", label: "Reddit conversations", gives: "What customers say.", energy: 5, paid: false, available: true }, { id: "x", label: "Posts on X", gives: "Public posts.", energy: 100, paid: true, available: true }], datasets: [{ topic: "coffee", createdAt: "2026-11-14T10:00:00Z", sharedWith: ["marketing-manager"], sources: [{ id: "reddit", status: "ok" }] }] };
    const r = new ResourceRegistry(sources({ mining: () => mining }));
    const marketing = r.forEmployee("u", "w", "marketing-manager");
    expect(marketing.find((x) => x.key === "known:datasets")).toMatchObject({ state: "ready", cost: { class: "known" }, freshness: "newest gathered 14 Nov" });
    expect(marketing.find((x) => x.key === "source:reddit")!.allowed).toBe(false);
    expect(r.forEmployee("u", "w", "finance-manager").some((x) => x.key === "known:datasets")).toBe(false);
    const miner = r.forEmployee("u", "w", "data-mining-agent");
    expect(miner.find((x) => x.key === "source:x")).toMatchObject({ allowed: true, state: "ready", cost: { class: "double_energy", energy: 100 }, cheaper: "Saved dataset on \"coffee\"" });
  });

  it("offers media rendering only to employees whose job is content", () => {
    const paid = [{ key: "creatomate", name: "Creatomate", kind: "api", summary: "Renders a video from a template.", connected: true, quote: { energy: 200 } }];
    const r = new ResourceRegistry(sources({ paid: () => paid }));
    expect(r.forEmployee("u", "w", "marketing-manager").find((x) => x.key === "paid:creatomate")).toMatchObject({ allowed: true, state: "ready", needsApproval: true, cost: { class: "double_energy", energy: 200 } });
    expect(r.forEmployee("u", "w", "finance-manager").find((x) => x.key === "paid:creatomate")!.allowed).toBe(false);
  });
});

describe("the employee's brief", () => {
  const nothing = () => new ResourceRegistry(sources()).forEmployee("u", "w", "marketing-manager");

  it("for an employee with nothing connected: says so, names what would help, and invents nothing", () => {
    const g = renderGuide(nothing(), "How are my website visits and sales doing?");
    expect(g).toContain("Business profile");
    expect(g).toContain("website visits");
    expect(g).toMatch(/connect Google Analytics on Apps and connections/);
    expect(g).toContain("connect X and I can do this");
    expect(g).not.toContain("Double energy");
    expect(g.length).toBeLessThanOrEqual(MAX_GUIDE_CHARS);
  });

  it("does not list what is not relevant to the task", () => {
    const g = renderGuide(nothing(), "Write a thank-you note to a customer");
    expect(g).not.toContain("Not connected");
    expect(g.length).toBeLessThan(450);
  });

  it("with several things connected: lists only what is ready, cheapest first, with freshness", () => {
    const r = new ResourceRegistry(sources({
      connections: () => [{ connectorKey: "square", status: "connected", access: ["marketing-manager"], lastSyncAt: "2026-11-15T08:00:00Z" }, { connectorKey: "ga4", status: "connected", access: ["marketing-manager"], lastSyncAt: "2026-11-16T08:00:00Z" }],
    })).forEmployee("u", "w", "marketing-manager");
    const g = renderGuide(r, "Plan next month using our sales");
    expect(g).toContain("Square (read yesterday)");
    expect(g).toContain("Google Analytics (read today)");
    expect(g.indexOf("Already here")).toBeLessThan(g.indexOf("Energy:"));
    expect(g).not.toContain("Payroll X");
    expect(g).not.toContain("connect Square");
  });

  it("with a paid service available: states the double cost, the quote, and the cheaper way", () => {
    const mining = { hired: true, sources: [{ id: "reddit", label: "Reddit conversations", gives: "x", energy: 5, paid: false, available: true }, { id: "x", label: "Posts on X", gives: "y", energy: 100, paid: true, available: true }], datasets: [] };
    const r = new ResourceRegistry(sources({ mining: () => mining, paid: () => [{ key: "creatomate", name: "Creatomate", kind: "api", summary: "Renders a video from a template.", connected: true, quote: { energy: 200 } }] }));
    const g = renderGuide(r.forEmployee("u", "w", "data-mining-agent"));
    expect(g).toContain("Reddit conversations (5)");
    expect(g).toMatch(/Double energy, only when the task truly needs it and the owner has seen the cost: Posts on X \(100\), but Reddit conversations gives the same for less/);
    const m = renderGuide(r.forEmployee("u", "w", "marketing-manager"));
    expect(m).toContain("Creatomate (200)");
  });

  it("stays under the size limit however many apps are connected, and never cuts a word in half", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ key: `app${i}`, name: `Application number ${i}`, category: "x", availability: "live", capabilities: ["sales.read"], connect: "oauth", defaultAccess: ["marketing-manager"] }));
    const conns = many.map((a) => ({ connectorKey: a.key, status: "connected", access: ["marketing-manager"], lastSyncAt: "2026-11-16T08:00:00Z" }));
    const g = renderGuide(new ResourceRegistry(sources({ apps: () => many, connections: () => conns })).forEmployee("u", "w", "marketing-manager"), "sales");
    expect(g.length).toBeLessThanOrEqual(MAX_GUIDE_CHARS);
    expect(g).toMatch(/and \d+ more/);
    expect(g.endsWith("Claim no other tools.")).toBe(true);
  });

  it("gives the web app a link, not a guess, when a task needs something that is not connected", () => {
    const s = suggestionsForTask(nothing(), "Show me my website visits this week", "Marketing manager");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: "resource-website-visits", action: { href: "#apps" } });
    expect(suggestionsForTask(nothing(), "Write a thank-you note", "Marketing manager")).toEqual([]);
  });

  it("gives the client a short list of what is ready, what is missing with where to add it, and what MAIZ is switching on", () => {
    const paid = [{ key: "creatomate", name: "Creatomate", kind: "api", summary: "Renders a video from a template.", connected: false }];
    const sum = clientSummary(new ResourceRegistry(sources({ paid: () => paid })).forEmployee("u", "w", "marketing-manager"));
    expect(sum.ready.map((x) => x.name)).toContain("Business profile");
    expect(sum.missing.find((m) => m.name.startsWith("Sales"))?.action.href).toBe("#apps");
    expect(sum.waiting).toEqual(["Creatomate"]);
  });

  it("measures the 'ready' keys the employee was handed", () => {
    const r = new ResourceRegistry(sources()).forEmployee("u", "w", "marketing-manager");
    expect(usedBy(r).sort()).toEqual(["known:profile", "model:open"]);
  });
});

describe("what the owner sees", () => {
  it("adds up what employees were given and what paid things took, paid things first", () => {
    const rows = usageTable({
      tasks: [{ used: ["known:profile", "app:square"], energy: 10, costMicro: 5 }, { used: ["known:profile"], energy: 4, costMicro: 2 }],
      providers: [{ provider: "paid:creatomate", energy: 400, costMicro: 200_000, uses: 2 }, { provider: "mine:reddit", energy: 10, costMicro: 0, uses: 2 }, { provider: "anthropic", energy: 1, costMicro: 1, uses: 1 }],
    });
    expect(rows[0]).toMatchObject({ key: "paid:creatomate", how: "charged", uses: 2, energy: 400 });
    expect(rows.find((r) => r.key === "source:reddit")?.how).toBe("charged");
    expect(rows.find((r) => r.key === "known:profile")).toMatchObject({ how: "given", uses: 2, energy: 14 });
    expect(rows.some((r) => r.key === "anthropic")).toBe(false);
  });
});

describe("every task: the guide replaces the hand-written tool list", () => {
  async function team(guideFails = false) {
    const audit = new AuditLog();
    const bus = new EventBus();
    const identity = new IdentityService(audit, bus);
    const clock = { d: new Date("2026-11-16T09:00:00Z") };
    const energy = new EnergyMeter(identity, audit, () => clock.d);
    const told: string[] = [];
    const gateway = new ModelGateway([{ name: "spy", tiers: ["standard", "premium"], complete: async (r: CompletionRequest) => { told.push(r.messages[0]!.content); return { text: "ok", provider: "spy", model: "m", inputTokens: 1, outputTokens: 1 }; } } as ModelAdapter]);
    const workforce = new WorkforceService(identity, audit, bus, gateway, energy);
    const registry = new ResourceRegistry(sources({ team: (u, w) => workforce.team(u, w) }));
    workforce.setResourceGuide((u, w, key, brief, name) => {
      if (guideFails) throw new Error("registry down");
      const r = registry.forEmployee(u, w, key);
      return { text: renderGuide(r, brief), used: usedBy(r), hints: suggestionsForTask(r, brief, name) };
    });
    const ws = (await identity.createWorkspace("ann", { name: "Kestrel" })).id;
    energy.setPlan("ann", ws, { ...PLANS.starter!, weeklyTeamEnergy: 8_000, dailyTeamCeiling: 3_000 });
    const marketing = await workforce.hire("ann", ws, "marketing-manager");
    return { workforce, told, ws, marketing };
  }

  it("puts the guide in the instructions, removes the old tool line, and records what was used", async () => {
    const t = await team();
    const task = await t.workforce.assign("ann", t.ws, t.marketing.id, "Show me my website visits", { urgent: true });
    const system = t.told.at(-1)!;
    expect(system).toContain("Resources, cheapest first.");
    expect(system).not.toContain("Tools you can use today");
    expect(system).toContain("connect X and I can do this");
    expect(task.used).toEqual(["known:profile", "model:open"]);
    expect(task.hints?.[0]?.action.href).toBe("#apps");
  });

  it("falls back to the job description's own tool list when the registry fails, and the work still runs", async () => {
    const t = await team(true);
    const task = await t.workforce.assign("ann", t.ws, t.marketing.id, "Plan the week", { urgent: true });
    expect(task.status).toBe("ready_for_review");
    expect(t.told.at(-1)).toContain("Tools you can use today");
    expect(task.used).toBeUndefined();
  });
});

/** The routing gateway with scripted providers, like test/routing.test.ts. */
class Script implements ModelAdapter {
  readonly tiers = ["standard", "premium"] as const;
  calls: CompletionRequest[] = [];
  constructor(readonly name: string, private steps: (string | ProviderError)[]) {}
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    const step = this.steps.length > 1 ? this.steps.shift()! : this.steps[0]!;
    if (step instanceof ProviderError) throw step;
    return { text: step, provider: this.name, model: req.model ?? "m", inputTokens: 500, outputTokens: 50 };
  }
}

describe("quality checks are not spent on trivial answers", () => {
  const clock = { t: Date.parse("2026-11-16T10:00:00Z") };
  const rig = (runpod: Script, claude: Script) => new RoutingGateway({ settings: new RoutingSettingsStore(defaultSettings()), ledger: new SpendLedger(() => new Date(clock.t)), runpod, claude, now: () => clock.t, random: () => 0, sleep: async () => {} });
  const ask = (gw: RoutingGateway, tier: "standard" | "premium") => gw.complete({ messages: [{ role: "system", content: "You are an employee." }, { role: "user", content: "Say ok" }], maxTokens: 100, workspaceId: "ws1", tier });

  it("skips the sampled check on a one-line answer with no figure", async () => {
    const claude = new Script("anthropic", ['{"score":9,"issues":[]}']);
    const r = await ask(rig(new Script("runpod", ["Done."]), claude), "standard");
    expect(claude.calls).toHaveLength(0);
    expect(r.routing?.reviewed).toBe(false);
  });

  it("still checks a real answer, and still checks a suspicious one", async () => {
    const claude = new Script("anthropic", ['{"score":9,"issues":[]}']);
    await ask(rig(new Script("runpod", ["A proper answer. ".repeat(10)]), claude), "standard");
    expect(claude.calls).toHaveLength(1);
    const claude2 = new Script("anthropic", ['{"score":9,"issues":[]}', "A redone answer that is long enough to be accepted by everything."]);
    const r2 = await ask(rig(new Script("runpod", [""]), claude2), "standard");
    expect(claude2.calls.length).toBeGreaterThan(0);
    expect(r2.routing?.escalated).toBe(true);
  });

  it("never skips the check for the strongest lane", async () => {
    const claude = new Script("anthropic", ['{"score":9,"issues":[]}']);
    await ask(rig(new Script("runpod", ["Done."]), claude), "premium");
    expect(claude.calls).toHaveLength(1);
  });
});

describe("on the real platform", () => {
  const SECRET = "s3";
  function setup() {
    const clock = { d: new Date("2026-11-16T09:00:00Z") };
    const platform = createPlatform({ sessionSecret: SECRET, allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", platformOwners: ["atif@maiz.test"], now: () => clock.d });
    const handle = createApp(platform);
    const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
      handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
    const signUp = async (email: string, name: string) => {
      const r = await call("POST", "/api/signup", {}, { email, businessName: name, sells: "Coffee", size: "2–10", country: "GB" });
      expect(r.status).toBe(201);
      return { auth: { authorization: `Bearer ${(r.body as any).token}` }, ws: platform.identity.workspacesFor(userIdFor(email))[0]!.id, userId: userIdFor(email) };
    };
    const owner = { authorization: `Bearer ${makeToken(SECRET, { k: "session", u: userIdFor("atif@maiz.test"), e: "atif@maiz.test" }, 7 * 86_400, clock.d.getTime())}` };
    return { platform, call, signUp, owner };
  }
  const TILL = `Date,Total,VAT,Tip,Processing Fee,Payment Method\n05/11/2026,"£1,200.00",200.00,5.00,18.00,Card\n06/11/2026,300,50,,4.50,Cash`;

  it("shows a connected app to the employees the owner allowed, in that workspace only", async () => {
    const { platform, signUp } = setup();
    const a = await signUp("ann@a.test", "A Coffee");
    const b = await signUp("bob@b.test", "B Coffee");
    platform.integrations.importFile(a.userId, a.ws, "till-file", TILL);
    const sales = (u: string, ws: string, key: string) => platform.resources.forEmployee(u, ws, key).find((r) => r.key === "app:till-file")!;
    expect(sales(a.userId, a.ws, "finance-manager")).toMatchObject({ state: "ready", allowed: true });
    expect(sales(b.userId, b.ws, "finance-manager").state).toBe("not_connected");
    // Another client's person cannot read this client's resources.
    expect(() => platform.resources.forEmployee(b.userId, a.ws, "finance-manager")).toThrow();
    // The owner narrows access to the finance manager only.
    const conn = platform.integrations.list(a.userId, a.ws).find((c) => c.connectorKey === "till-file")!;
    platform.integrations.setAccess(a.userId, a.ws, conn.id, ["finance-manager"]);
    expect(sales(a.userId, a.ws, "marketing-manager").allowed).toBe(false);
    expect(sales(a.userId, a.ws, "finance-manager").allowed).toBe(true);
    // Never for the Admin manager.
    expect(platform.resources.forEmployee(a.userId, a.ws, "admin-manager").find((r) => r.key === "app:till-file")!.allowed).toBe(false);
  });

  it("serves the client's list on the desk route and answers 404 for an employee they do not have", async () => {
    const { call, signUp } = setup();
    const a = await signUp("ann@a.test", "A Coffee");
    const ok = await call("GET", "/api/resources/employee/marketing-manager", a.auth);
    expect(ok.status).toBe(200);
    expect((ok.body as any).ready.map((x: any) => x.name)).toContain("Business profile");
    expect((ok.body as any).missing.length).toBeGreaterThan(0);
    expect((await call("GET", "/api/resources/employee/not-a-real-employee", a.auth)).status).toBe(404);
    expect((await call("GET", "/api/resources/employee/marketing-manager")).status).toBe(401);
  });

  it("keeps the owner's table to the owner, and records what a task was given", async () => {
    const { platform, call, signUp, owner } = setup();
    const a = await signUp("ann@a.test", "A Coffee");
    const marketing = platform.workforce.team(a.userId, a.ws).find((e) => e.templateKey === "marketing-manager")!;
    const ask = await call("POST", "/api/ask", a.auth, { text: "Write a short note on how our sales are going", employeeId: marketing.id, urgent: true });
    expect(ask.status).toBe(200);
    expect((ask.body as any).hints?.[0]?.action?.href).toBe("#apps");
    expect((await call("GET", "/api/owner/resources", a.auth)).status).toBe(403);
    const table = await call("GET", "/api/owner/resources", owner);
    expect(table.status).toBe(200);
    expect((table.body as any).rows.find((r: any) => r.key === "known:profile")?.uses).toBeGreaterThan(0);
  });
});
