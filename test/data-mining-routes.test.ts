import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import type { Snapshot } from "../src/core/persistence.js";
import { planSignup } from "../src/modules/onboarding/recommend.js";
import { STANDARD_TEAM } from "../src/modules/onboarding/index.js";
import { DATA_MINING_AGENT, FREE_SOURCE_ENERGY, MAX_DATASETS, MAX_RUNS_PER_HOUR, MAX_SOURCES_PER_RUN } from "../src/modules/data-mining/index.js";

const SECRET = "s3";

/** A pretend internet for the two sources that need no key: a forum search and a news index. */
function fakeWeb() {
  const calls: string[] = [];
  const http = (async (url: any) => {
    const u = String(url);
    calls.push(u);
    const host = new URL(u).host;
    if (host === "hn.algolia.com") return new Response(JSON.stringify({ hits: [{ objectID: "4242", title: "Ask HN: is a coffee cart worth it?", points: 31, num_comments: 12, created_at_i: 1_794_000_000, story_text: "We ran one for a year." }] }));
    if (host === "api.gdeltproject.org") return new Response(JSON.stringify({ articles: [{ title: "Coffee carts are booming", domain: "news.example", url: "https://news.example/coffee", seendate: "20261112T101500Z" }] }));
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  return { http, calls };
}

function setup() {
  const clock = { d: new Date("2026-11-16T09:00:00Z") };
  const web = fakeWeb();
  const platform = createPlatform({ sessionSecret: SECRET, allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", now: () => clock.d, http: web.http });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const tokenFor = (email: string) => ({ authorization: `Bearer ${makeToken(SECRET, { k: "session", u: userIdFor(email), e: email }, 7 * 86_400, clock.d.getTime())}` });
  /** Signs a business up. With `hire`, the Data mining agent is accepted as an add-on on the plan screen. */
  const signUp = async (email: string, name: string, hire = true) => {
    const r = await call("POST", "/api/signup", { email, businessName: name, sells: "Coffee", size: "2–10", country: "GB", ...(hire ? { needs: ["know-my-market"], addOns: [DATA_MINING_AGENT] } : {}) });
    expect(r.status).toBe(201);
    return { auth: { authorization: `Bearer ${(r.body as any).token}` }, ws: platform.identity.workspacesFor(userIdFor(email))[0]!.id, userId: userIdFor(email) };
  };
  const run = async (auth: Record<string, string>, body: Record<string, unknown>) => {
    const asked = await call("POST", "/api/mining/run", body, auth);
    if (asked.status !== 409) return asked;
    return call("POST", "/api/mining/run", { ...body, confirm: true, confirmEnergy: (asked.body as any).quote.total }, auth);
  };
  return { platform, call, clock, web, tokenFor, signUp, run };
}

/** A store that keeps what the routes need to come back after a restart: workspaces, people, employees, plans and records. */
function memoryStore() {
  const snap = { workspaces: [] as any[], memberships: [] as any[], employees: [] as any[], plans: [] as any[] };
  const records = new Map<string, any>();
  const empty = { profiles: [], training: [], accounts: [], entries: [], usage: [], audit: [], connections: [], links: [], adminOrgs: [], adminMessages: [], slackTokens: [] };
  return new Proxy({} as any, {
    get: (_t, prop) => {
      if (prop === "load") return async () => ({ ...empty, ...snap, records: [...records.values()] }) as unknown as Snapshot;
      if (prop === "flush") return async () => {};
      if (prop === "then") return undefined;
      if (prop === "workspace") return (w: unknown) => snap.workspaces.push(w);
      if (prop === "membership") return (workspaceId: string, userId: string, role: string) => snap.memberships.push({ workspaceId, userId, role });
      if (prop === "employee") return (e: unknown) => snap.employees.push(e);
      if (prop === "plan") return (workspaceId: string, plan: unknown) => snap.plans.push({ workspaceId, plan });
      if (prop === "record") return (workspaceId: string, kind: string, id: string, data: unknown) => records.set(`${kind}:${id}`, { workspaceId, kind, id, data: JSON.parse(JSON.stringify(data)) });
      return () => {};
    },
  });
}

describe("data mining routes: the page", () => {
  it("needs a signed-in person", async () => {
    const s = setup();

    expect((await s.call("GET", "/api/mining")).status).toBe(401);
    expect((await s.call("POST", "/api/mining/run", { topic: "coffee carts", sources: ["news"] })).status).toBe(401);
  });

  it("shows whether the agent is hired, every source with its energy, and who a dataset can be shared with", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");

    const r = await s.call("GET", "/api/mining", undefined, ann.auth);

    expect(r.status).toBe(200);
    const b = r.body as any;
    expect(b.hired).toBe(true);
    expect(b.datasets).toEqual([]);
    expect(b.sources.map((x: any) => x.id)).toEqual(["hackernews", "reddit", "youtube", "x", "news", "economy", "prices", "companies"]);
    expect(b.sources.find((x: any) => x.id === "news")).toEqual({ id: "news", label: "News coverage", gives: expect.any(String), paid: false, energy: FREE_SOURCE_ENERGY, available: true });
    // No keys are set on this server: the sources that need one say so instead of failing.
    expect(b.sources.find((x: any) => x.id === "x")).toMatchObject({ paid: true, energy: 100, available: false, reason: expect.stringMatching(/not available yet/) });
    expect(b.employees.map((e: any) => e.key).sort()).toEqual(["admin-manager", "business-consultant", "compliance-manager", "finance-manager", "hr-manager", "marketing-manager"]);
    expect(b.employees.find((e: any) => e.key === "finance-manager").title).toBe("Finance manager");
    expect(b.limits).toEqual({ maxSources: MAX_SOURCES_PER_RUN, runsPerHour: MAX_RUNS_PER_HOUR, maxDatasets: MAX_DATASETS, minTopic: 3, maxTopic: 200 });
  });

  it("tells a client without the agent to hire it, and gathers nothing", async () => {
    const s = setup();
    const bob = await s.signUp("bob@plumb.co", "Bob's Plumbing", false);

    const page = await s.call("GET", "/api/mining", undefined, bob.auth);
    const r = await s.call("POST", "/api/mining/run", { topic: "boilers", sources: ["news"], confirm: true, confirmEnergy: 5 }, bob.auth);

    expect((page.body as any).hired).toBe(false);
    expect(r.status).toBe(400);
    expect((r.body as any).error).toBe("Hire the Data mining agent from the store first.");
    expect(s.web.calls).toHaveLength(0);
  });
});

describe("data mining routes: quote, confirm, run", () => {
  it("answers 409 with the quote first, then 201 with the dataset once the total is confirmed", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const before = s.platform.energy.teamEnergyOf(ann.ws)!.left;

    const asked = await s.call("POST", "/api/mining/run", { topic: "coffee carts", sources: ["hackernews", "news", "reddit"] }, ann.auth);
    const done = await s.call("POST", "/api/mining/run", { topic: "coffee carts", sources: ["hackernews", "news", "reddit"], confirm: true, confirmEnergy: (asked.body as any).quote.total }, ann.auth);

    expect(asked.status).toBe(409);
    expect((asked.body as any).error).toMatch(/10 energy/);
    expect((asked.body as any).quote).toMatchObject({ topic: "coffee carts", total: 10, unavailable: ["reddit"] });
    expect((asked.body as any).quote.sources).toHaveLength(3);
    expect(done.status).toBe(201);
    const { dataset, team } = done.body as any;
    expect(dataset).toMatchObject({ topic: "coffee carts", createdAt: "2026-11-16T09:00:00.000Z", energyUsed: 10, sharedWith: [] });
    expect(dataset).not.toHaveProperty("workspaceId");
    expect(dataset.sources.map((x: any) => [x.id, x.status, x.items.length])).toEqual([["hackernews", "ok", 1], ["news", "ok", 1], ["reddit", "unavailable", 0]]);
    expect(dataset.sources[0].items[0]).toEqual({ title: "Ask HN: is a coffee cart worth it?", snippet: "We ran one for a year.", url: "https://news.ycombinator.com/item?id=4242", source: "Hacker News", at: "2026-11-06" });
    expect(dataset.summary).toMatch(/2 items from 2 of 3 sources/);
    expect(team.left).toBe(before - 10);
  });

  it("answers 400 for a bad topic or an unknown source", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");

    expect((await s.call("POST", "/api/mining/run", { topic: "ab", sources: ["news"] }, ann.auth)).status).toBe(400);
    expect((await s.call("POST", "/api/mining/run", { topic: "coffee carts", sources: ["the-dark-web"] }, ann.auth)).status).toBe(400);
    expect((await s.call("POST", "/api/mining/run", { topic: "coffee carts" }, ann.auth)).status).toBe(400);
    expect(s.web.calls).toHaveLength(0);
  });
});

describe("data mining routes: datasets", () => {
  it("lists datasets newest first without items, returns one in full, shares it and removes it", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const first = ((await s.run(ann.auth, { topic: "coffee carts", sources: ["news"] })).body as any).dataset;
    s.clock.d = new Date(s.clock.d.getTime() + 60_000);
    const second = ((await s.run(ann.auth, { topic: "oat milk", sources: ["hackernews"] })).body as any).dataset;

    const page = (await s.call("GET", "/api/mining", undefined, ann.auth)).body as any;
    const full = await s.call("GET", `/api/mining/datasets/${first.id}`, undefined, ann.auth);
    const shared = await s.call("POST", `/api/mining/datasets/${first.id}/share`, { employees: ["marketing-manager"] }, ann.auth);
    const refused = await s.call("POST", `/api/mining/datasets/${first.id}/share`, { employees: ["supply-chain-manager"] }, ann.auth);
    const removed = await s.call("POST", `/api/mining/datasets/${second.id}/remove`, undefined, ann.auth);

    expect(page.datasets.map((d: any) => d.id)).toEqual([second.id, first.id]);
    expect(page.datasets[0]).toEqual({ id: second.id, topic: "oat milk", createdAt: second.createdAt, summary: second.summary, energyUsed: 5, sharedWith: [], sources: [{ id: "hackernews", label: "Hacker News discussions", status: "ok", count: 1 }] });
    expect(full.status).toBe(200);
    expect((full.body as any).dataset).toEqual(first);
    expect(shared.status).toBe(200);
    expect((shared.body as any).dataset.sharedWith).toEqual(["marketing-manager"]);
    expect(refused.status).toBe(400);
    expect(removed.status).toBe(200);
    expect((removed.body as any).removed).toBe(true);
    expect((removed.body as any).datasets.map((d: any) => d.id)).toEqual([first.id]);
    expect((await s.call("GET", `/api/mining/datasets/${second.id}`, undefined, ann.auth)).status).toBe(404);
    expect((await s.call("GET", "/api/mining/nope", undefined, ann.auth)).status).toBe(404);
  });

  it("never lets one client see, share or remove another client's dataset", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const bob = await s.signUp("bob@plumb.co", "Bob's Plumbing");
    const annsDataset = ((await s.run(ann.auth, { topic: "coffee carts", sources: ["news"] })).body as any).dataset;

    expect((await s.call("GET", `/api/mining/datasets/${annsDataset.id}`, undefined, bob.auth)).status).toBe(404);
    expect((await s.call("POST", `/api/mining/datasets/${annsDataset.id}/share`, { employees: ["marketing-manager"] }, bob.auth)).status).toBe(404);
    expect((await s.call("POST", `/api/mining/datasets/${annsDataset.id}/remove`, undefined, bob.auth)).status).toBe(404);
    expect(((await s.call("GET", "/api/mining", undefined, bob.auth)).body as any).datasets).toEqual([]);
    expect(((await s.call("GET", "/api/mining", undefined, ann.auth)).body as any).datasets).toHaveLength(1);
  });

  it("lets a viewer read (task.read) but answers 403 when they try to run, share or remove (task.create)", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const ds = ((await s.run(ann.auth, { topic: "coffee carts", sources: ["news"] })).body as any).dataset;
    s.platform.identity.addMember(ann.userId, ann.ws, userIdFor("vera@kestrel.co"), "viewer");
    const vera = s.tokenFor("vera@kestrel.co");

    expect((await s.call("GET", "/api/mining", undefined, vera)).status).toBe(200);
    expect((await s.call("GET", `/api/mining/datasets/${ds.id}`, undefined, vera)).status).toBe(200);
    expect((await s.call("POST", "/api/mining/run", { topic: "coffee carts", sources: ["news"] }, vera)).status).toBe(403);
    expect((await s.call("POST", `/api/mining/datasets/${ds.id}/share`, { employees: [] }, vera)).status).toBe(403);
    expect((await s.call("POST", `/api/mining/datasets/${ds.id}/remove`, undefined, vera)).status).toBe(403);
  });

  it("keeps datasets through a restart when storage is on, and forgets a removed one", async () => {
    // Arrange: one server with a store, two datasets, one shared and one removed.
    const store = memoryStore();
    const a = setup();
    await a.platform.attachStore(store);
    const ann = await a.signUp("ann@kestrel.co", "Kestrel Coffee");
    const kept = ((await a.run(ann.auth, { topic: "coffee carts", sources: ["news"] })).body as any).dataset;
    await a.call("POST", `/api/mining/datasets/${kept.id}/share`, { employees: ["finance-manager"] }, ann.auth);
    a.clock.d = new Date(a.clock.d.getTime() + 60_000);
    const gone = ((await a.run(ann.auth, { topic: "oat milk", sources: ["news"] })).body as any).dataset;
    await a.call("POST", `/api/mining/datasets/${gone.id}/remove`, undefined, ann.auth);

    // Act: a new server loads the same store.
    const b = setup();
    await b.platform.attachStore(store);
    const page = (await b.call("GET", "/api/mining", undefined, b.tokenFor("ann@kestrel.co"))).body as any;

    // Assert
    expect(page.hired).toBe(true);
    expect(page.datasets.map((d: any) => [d.id, d.sharedWith])).toEqual([[kept.id, ["finance-manager"]]]);
    expect(((await b.call("GET", `/api/mining/datasets/${kept.id}`, undefined, b.tokenFor("ann@kestrel.co"))).body as any).dataset.sources).toEqual(kept.sources);
  });
});

describe("the Data mining agent at signup", () => {
  it("is offered when the owner wants to know their market, and is never added without their tap", () => {
    const answers = { businessName: "Kestrel Coffee", sector: "food-drink", country: "GB" };

    const offered = planSignup({ ...answers, needs: ["know-my-market"] });
    const accepted = planSignup({ ...answers, needs: ["know-my-market"], addOns: [DATA_MINING_AGENT] });

    expect(planSignup({ ...answers, needs: ["know-my-numbers"] }).addOns).toEqual([]);
    expect(offered.addOns).toEqual([{ key: DATA_MINING_AGENT, title: "Data mining agent", reason: expect.stringMatching(/public data/) }]);
    expect(offered.team.some((m) => m.key === DATA_MINING_AGENT)).toBe(false);
    expect(accepted.team.find((m) => m.key === DATA_MINING_AGENT)).toMatchObject({ title: "Data mining agent", focus: true, firstJob: expect.stringMatching(/market snapshot/i) });
    expect((STANDARD_TEAM as readonly string[]).includes(DATA_MINING_AGENT)).toBe(false);
  });
});
