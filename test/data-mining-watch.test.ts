import { describe, expect, it } from "vitest";
import { AuditLog, EnergyMeter, EventBus, IdentityService, MockAdapter, ModelGateway, PermissionError, WorkforceService } from "../src/index.js";
import { PLANS, type EnergyPlan } from "../src/modules/energy/index.js";
import type { Sink } from "../src/core/persistence.js";
import {
  DATA_MINING_AGENT, DataMiningService, DatasetNotFound, FREE_SOURCE_ENERGY, MAX_CHECKS, MAX_WATCHES, MiningError, WATCH_QUIET_HOUR, X_BASE_ENERGY,
  changeSummary, compareSources, nextSlot, type DatasetSource, type MiningKeys,
} from "../src/modules/data-mining/index.js";

const TEAM: EnergyPlan = { ...PLANS.starter!, weeklyTeamEnergy: 8_000, dailyTeamCeiling: 3_000 };
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const START = "2026-11-16T09:00:00Z";

/**
 * A pretend internet (the build machine cannot reach the real sources): a news index, a forum search, a video search
 * and the World Bank, each answering from a list the test can change between weekly checks.
 */
function fakeWeb() {
  const calls: string[] = [];
  const state = {
    articles: [{ title: "Oat milk prices rise again", url: "https://news.example/oat-1" }, { title: "Why oat milk costs more", url: "https://news.example/oat-2" }],
    threads: [{ id: "1001", title: "Oat milk margins" }],
    inflation: 3.4,
    down: new Set<string>(),
  };
  const http = (async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    const host = new URL(u).host;
    if (state.down.has(host)) return new Response("{}", { status: 500 });
    if (host === "api.gdeltproject.org") return new Response(JSON.stringify({ articles: state.articles.map((a) => ({ ...a, domain: "news.example", seendate: "20261112T101500Z" })) }));
    if (host === "hn.algolia.com") return new Response(JSON.stringify({ hits: state.threads.map((t) => ({ objectID: t.id, title: t.title, points: 3, num_comments: 1, created_at_i: 1_794_000_000, story_text: "text" })) }));
    if (host === "www.googleapis.com") return new Response(JSON.stringify(u.includes("/search?") ? { items: [{ id: { videoId: "abcdefghijk" }, snippet: { title: "Oat milk at home", channelTitle: "Kitchen", description: "How to.", publishedAt: "2026-11-01T10:00:00Z" } }] } : { items: [{ id: "abcdefghijk", statistics: { viewCount: "10", commentCount: "1" } }] }));
    // Only the inflation indicator moves; growth and unemployment stay where they were.
    if (host === "api.worldbank.org") return new Response(JSON.stringify([{}, [{ indicator: { value: "Indicator" }, country: { value: "United Kingdom" }, value: u.includes("FP.CPI.TOTL.ZG") ? state.inflation : 1.1, date: "2025" }]]));
    if (host === "api.x.com") return new Response(JSON.stringify({ data: [{ id: "1900000000000000001", author_id: "7", text: "Oat milk is dear now", created_at: "2026-11-15T08:00:00.000Z" }], includes: { users: [{ id: "7", username: "p" }] } }));
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  return { http, calls, state, to: (host: string) => calls.filter((c) => new URL(c).host === host).length };
}

/** A sink that remembers the latest stored copy of each record, as storage would hand it back. */
function memorySink() {
  const records = new Map<string, { kind: string; data: unknown }>();
  const sink = new Proxy({}, { get: (_t, k) => (k === "record" ? (_ws: string, kind: string, id: string, data: unknown) => { records.set(`${kind}:${id}`, { kind, data: JSON.parse(JSON.stringify(data)) }); } : () => undefined) }) as unknown as Sink;
  return { sink, datasets: () => [...records.values()].filter((r) => r.kind === "dataset").map((r) => r.data) };
}

interface DeskOptions { keys?: MiningKeys; plan?: EnergyPlan; timezone?: string; sink?: Sink; multiplier?: () => number }

async function desk(opts: DeskOptions = {}) {
  const audit = new AuditLog();
  const bus = new EventBus();
  const identity = new IdentityService(audit, bus);
  const clock = { d: new Date(START) };
  const energy = new EnergyMeter(identity, audit, () => clock.d);
  const workforce = new WorkforceService(identity, audit, bus, new ModelGateway([new MockAdapter()]), energy);
  const ws = (await identity.createWorkspace("owner", { name: "Kestrel Coffee" })).id;
  energy.setPlan("owner", ws, opts.plan ?? TEAM);
  await workforce.hire("owner", ws, "marketing-manager");
  const agent = await workforce.hire("owner", ws, DATA_MINING_AGENT);
  const web = fakeWeb();
  const bell: { ws: string; title: string; body: string; link: string }[] = [];
  const team = { agentGone: false };
  const make = (sink?: Sink) => {
    const mining = new DataMiningService({
      identity, meter: energy, audit, http: web.http, now: () => clock.d,
      team: (userId, w) => (team.agentGone ? workforce.team(userId, w).filter((e) => e.templateKey !== DATA_MINING_AGENT) : workforce.team(userId, w)),
      titleOf: (key, w) => workforce.templateFor(key, w)?.title, countryOf: () => "GB",
      multiplier: opts.multiplier ?? (() => 2), keys: () => opts.keys ?? {},
      agentIn: (w) => (team.agentGone ? undefined : workforce.employeeIn(w, DATA_MINING_AGENT)),
      timezone: () => opts.timezone,
      notify: (w, n) => { bell.push({ ws: w, ...n }); },
    });
    if (sink) mining.useSink(sink);
    return mining;
  };
  const mining = make(opts.sink);
  const used = () => energy.teamEnergyOf(ws)!.used;
  /** Runs a first search the way the screen does: quote, then confirm that exact total. */
  const search = async (sources: string[], topic = "oat milk prices") => {
    const quote = mining.quote("owner", ws, { topic, sources });
    return mining.run("owner", ws, { topic, sources, confirm: true, confirmEnergy: quote.total });
  };
  /** Switches the weekly check on the way the screen does: see the weekly figure, then confirm it. */
  const watchOn = async (datasetId: string, sources?: string[]) => {
    const asked = await Promise.resolve().then(() => mining.watch("owner", ws, datasetId, { on: true, ...(sources ? { sources } : {}) })).catch((e) => e);
    return mining.watch("owner", ws, datasetId, { on: true, ...(sources ? { sources } : {}), confirm: true, confirmEnergy: asked.quote.total });
  };
  const after = (ms: number) => { clock.d = new Date(clock.d.getTime() + ms); };
  return { mining, make, energy, identity, workforce, audit, ws, web, clock, agent, used, bell, team, search, watchOn, after };
}

const source = (id: "news" | "economy", items: { title: string; url: string }[], figures: { label: string; value: string; date?: string }[] = []): DatasetSource =>
  ({ id, label: id === "news" ? "News coverage" : "Economy figures for your country", status: "ok", items: items.map((i) => ({ ...i, snippet: "", source: "news.example" })), ...(figures.length ? { figures } : {}) });

describe("weekly watch: what changed between two checks", () => {
  it("finds items whose address was not there last time and ignores items that disappeared", () => {
    const before = [source("news", [{ title: "A", url: "https://n.example/a" }, { title: "B", url: "https://n.example/b" }])];
    const now = [source("news", [{ title: "B", url: "https://n.example/b" }, { title: "C", url: "https://n.example/c" }, { title: "D", url: "https://n.example/d" }])];

    const change = compareSources(before, now);

    expect(change.newItems.map((i) => i.url)).toEqual(["https://n.example/c", "https://n.example/d"]);
    expect(change.newItems[0]).toMatchObject({ sourceId: "news", title: "C" });
    expect(change.figures).toEqual([]);
  });

  it("reports a figure whose latest value moved, by its label", () => {
    const label = "Inflation, consumer prices (% a year)";
    const before = [source("economy", [], [{ label, value: "3.4", date: "2025" }, { label, value: "2.5", date: "2024" }])];
    const now = [source("economy", [], [{ label, value: "3.6", date: "2026" }, { label, value: "3.4", date: "2025" }])];

    expect(compareSources(before, now).figures).toEqual([{ label, from: "3.4", to: "3.6" }]);
    // The same latest value is not a change.
    expect(compareSources(before, before)).toEqual({ newItems: [], figures: [] });
  });

  it("ignores a source that could not be read this week instead of calling everything gone or new", () => {
    const before = [source("news", [{ title: "A", url: "https://n.example/a" }])];
    const failed: DatasetSource[] = [{ id: "news", label: "News coverage", status: "failed", items: [], note: "could not be read" }];

    expect(compareSources(before, failed)).toEqual({ newItems: [], figures: [] });
  });

  it("writes one short line a person can read", () => {
    const change = {
      newItems: [1, 2, 3].map((n) => ({ sourceId: "news" as const, title: `T${n}`, snippet: "", url: `https://n.example/${n}`, source: "n" })),
      figures: [{ label: "Inflation, consumer prices (% a year)", from: "3.4", to: "3.6" }],
    };

    expect(changeSummary("oat milk prices", change)).toBe("Oat milk prices: 3 new articles, inflation moved from 3.4% to 3.6%");
    expect(changeSummary("oat milk prices", { newItems: change.newItems.slice(0, 1), figures: [] })).toBe("Oat milk prices: 1 new article");
    expect(changeSummary("oat milk prices", { newItems: [], figures: [] })).toBe("");
  });
});

describe("weekly watch: when a check is due", () => {
  it("is due every seven days from when it was switched on when no time zone is known", () => {
    const since = "2026-11-16T09:00:00.000Z";

    expect(nextSlot(since, Date.parse(since), undefined)).toBe("2026-11-23T09:00:00.000Z");
    expect(nextSlot(since, Date.parse("2026-11-23T09:00:00Z"), undefined)).toBe("2026-11-30T09:00:00.000Z");
    // After a long gap (the server was off) the next slot is the next one still to come, not three old ones.
    expect(nextSlot(since, Date.parse("2026-12-10T12:00:00Z"), undefined)).toBe("2026-12-14T09:00:00.000Z");
  });

  it("moves to a quiet hour of the client's own night when the time zone is known", () => {
    // 09:00 UTC on 16 November is 04:00 in New York; the slot a week later is 03:00 there, which is 08:00 UTC.
    const slot = nextSlot("2026-11-16T09:00:00.000Z", Date.parse("2026-11-16T09:00:00Z"), "America/New_York");

    expect(slot).toBe("2026-11-23T08:00:00.000Z");
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(new Date(slot))).toBe(String(WATCH_QUIET_HOUR).padStart(2, "0"));
  });
});

describe("weekly watch: switching it on", () => {
  it("shows what a week uses at most and switches nothing on until that figure is confirmed", async () => {
    const d = await desk();
    const ds = await d.search(["news", "hackernews"]);
    const callsBefore = d.web.calls.length;

    const asked = await Promise.resolve().then(() => d.mining.watch("owner", d.ws, ds.id, { on: true })).catch((e) => e);

    expect(asked).toBeInstanceOf(MiningError);
    // The same sources as the first search, at the same energy a search uses today.
    expect(asked.quote).toMatchObject({ topic: "oat milk prices", total: FREE_SOURCE_ENERGY * 2 });
    expect(asked.quote.sources.map((s: { id: string }) => s.id)).toEqual(["news", "hackernews"]);
    expect(asked.message).toMatch(/up to 10 energy each week/);
    expect(asked.message).toMatch(/only pay for sources that find something/i);
    // A wrong figure is refused too, and nothing was read or saved.
    expect(() => d.mining.watch("owner", d.ws, ds.id, { on: true, confirm: true, confirmEnergy: 5 })).toThrow(MiningError);
    expect(d.mining.get("owner", d.ws, ds.id).watch).toBeUndefined();
    expect(d.web.calls.length).toBe(callsBefore);
  });

  it("switches on with the confirmed figure and says when the first check is", async () => {
    const d = await desk();
    const ds = await d.search(["news", "hackernews"]);

    const watched = await d.watchOn(ds.id);

    expect(watched.watch).toMatchObject({ since: "2026-11-16T09:00:00.000Z", sources: ["news", "hackernews"], maxEnergy: 10, nextCheckAt: "2026-11-23T09:00:00.000Z" });
    expect(d.mining.list("owner", d.ws)[0]!.watch).toMatchObject({ maxEnergy: 10, nextCheckAt: "2026-11-23T09:00:00.000Z" });
  });

  it("lets the client choose other sources, and leaves out any that are not available", async () => {
    const d = await desk();
    const ds = await d.search(["news"]);

    const watched = await d.watchOn(ds.id, ["news", "economy", "youtube"]);

    // No YouTube key on this server: it is named in the quote, not counted and not watched.
    expect(watched.watch).toMatchObject({ sources: ["news", "economy"], maxEnergy: 10 });
  });

  it("needs the right to start work, and another client's dataset looks like one that does not exist", async () => {
    const d = await desk();
    const ds = await d.search(["news"]);
    const other = (await d.identity.createWorkspace("stranger", { name: "Other Ltd" })).id;
    await d.workforce.hire("stranger", other, DATA_MINING_AGENT);

    expect(() => d.mining.watch("stranger", d.ws, ds.id, { on: true })).toThrow(PermissionError);
    expect(() => d.mining.watch("stranger", other, ds.id, { on: true })).toThrow(DatasetNotFound);
  });

  it("allows a limited number of weekly checks per client", async () => {
    const d = await desk();
    const made: { id: string }[] = [];
    for (let i = 0; i <= MAX_WATCHES; i++) made.push(await d.search(["news"], `oat milk topic ${i}`));
    for (const ds of made.slice(0, MAX_WATCHES)) await d.watchOn(ds.id);

    // Said straight away, before any figure is shown.
    expect(() => d.mining.watch("owner", d.ws, made[MAX_WATCHES]!.id, { on: true })).toThrow(/weekly checks/);
  });
});

describe("weekly watch: the scheduler", () => {
  it("does nothing before the week is up, then reads the sources once and updates the same dataset", async () => {
    const d = await desk();
    const ds = await d.search(["news", "hackernews"]);
    await d.mining.share("owner", d.ws, ds.id, ["marketing-manager"]);
    await d.watchOn(ds.id);
    const newsCalls = d.web.to("api.gdeltproject.org");

    d.after(6 * DAY_MS);
    expect(await d.mining.tick()).toBe(0);
    expect(d.web.to("api.gdeltproject.org")).toBe(newsCalls);

    d.web.state.articles.push({ title: "Oat milk shortage feared", url: "https://news.example/oat-3" });
    d.after(DAY_MS);
    // The team's pool starts a new week, so the figure is taken just before the check.
    const usedBefore = d.used();
    expect(await d.mining.tick()).toBe(1);

    const now = d.mining.get("owner", d.ws, ds.id);
    expect(now.id).toBe(ds.id);
    expect(now.sharedWith).toEqual(["marketing-manager"]);
    expect(now.updatedAt).toBe("2026-11-23T09:00:00.000Z");
    expect(now.sources.find((s) => s.id === "news")!.items.map((i) => i.url)).toContain("https://news.example/oat-3");
    expect(now.watch!.nextCheckAt).toBe("2026-11-30T09:00:00.000Z");
    expect(d.used() - usedBefore).toBe(10);
    expect(d.web.to("api.gdeltproject.org")).toBe(newsCalls + 1);
  });

  it("never runs the same week twice, however often the clock ticks", async () => {
    const d = await desk();
    const ds = await d.search(["news"]);
    await d.watchOn(ds.id);
    const calls = d.web.to("api.gdeltproject.org");

    d.after(WEEK_MS);
    await Promise.all([d.mining.tick(), d.mining.tick()]);
    await d.mining.tick();
    d.after(60_000);
    await d.mining.tick();

    expect(d.web.to("api.gdeltproject.org")).toBe(calls + 1);
    d.after(WEEK_MS);
    await d.mining.tick();
    expect(d.web.to("api.gdeltproject.org")).toBe(calls + 2);
  });

  it("tells the client once, with a short summary that opens the dataset, when something changed", async () => {
    const d = await desk();
    const ds = await d.search(["news", "economy"]);
    await d.watchOn(ds.id);
    d.web.state.articles.push({ title: "Three", url: "https://news.example/oat-3" }, { title: "Four", url: "https://news.example/oat-4" }, { title: "Five", url: "https://news.example/oat-5" });
    d.web.state.inflation = 3.6;

    d.after(WEEK_MS);
    await d.mining.tick();

    expect(d.bell).toHaveLength(1);
    expect(d.bell[0]).toMatchObject({ ws: d.ws, body: "Oat milk prices: 3 new articles, inflation moved from 3.4% to 3.6%", link: `/app.html#mining/${ds.id}` });
    const check = d.mining.get("owner", d.ws, ds.id).checks![0]!;
    expect(check).toMatchObject({ at: "2026-11-23T09:00:00.000Z", status: "changed", summary: "Oat milk prices: 3 new articles, inflation moved from 3.4% to 3.6%", energyUsed: 10 });
    expect(check.newItems.map((i) => i.url)).toEqual(["https://news.example/oat-3", "https://news.example/oat-4", "https://news.example/oat-5"]);
    expect(check.figures).toEqual([{ label: "Inflation, consumer prices (% a year)", from: "3.4", to: "3.6" }]);
    // The list shows the latest check without opening the dataset.
    expect(d.mining.list("owner", d.ws)[0]!.lastCheck).toMatchObject({ status: "changed" });
  });

  it("sends no alert when nothing changed, and still records the check", async () => {
    const d = await desk();
    const ds = await d.search(["news"]);
    await d.watchOn(ds.id);

    d.after(WEEK_MS);
    await d.mining.tick();

    expect(d.bell).toEqual([]);
    expect(d.mining.get("owner", d.ws, ds.id).checks![0]).toMatchObject({ status: "same", newItems: [], figures: [], energyUsed: 5 });
  });

  it("charges only the sources that found something, and keeps last week's data for one that could not be read", async () => {
    const d = await desk();
    const ds = await d.search(["news", "hackernews"]);
    await d.watchOn(ds.id);
    d.web.state.down.add("hn.algolia.com");

    d.after(WEEK_MS);
    const usedBefore = d.used();
    await d.mining.tick();

    expect(d.used() - usedBefore).toBe(FREE_SOURCE_ENERGY);
    const now = d.mining.get("owner", d.ws, ds.id);
    expect(now.sources.find((s) => s.id === "hackernews")).toMatchObject({ status: "ok", items: [expect.objectContaining({ title: "Oat milk margins" })] });
    expect(now.checks![0]).toMatchObject({ status: "same", energyUsed: FREE_SOURCE_ENERGY });
    expect(now.checks![0]!.note).toMatch(/Hacker News discussions/);
  });

  it("skips the week when the team has too little energy, tells the client once, and tries again the week after", async () => {
    // A trial pool that does not refill: 14 energy, of which the first search uses 10.
    const trial: EnergyPlan = { ...PLANS.trial!, weeklyTeamEnergy: 14, dailyTeamCeiling: 3_000, startedAt: START, expiresAt: "2027-06-01T00:00:00Z" };
    const d = await desk({ plan: trial });
    const ds = await d.search(["news", "hackernews"]);
    await d.watchOn(ds.id);
    const calls = d.web.calls.length;

    d.after(WEEK_MS);
    await d.mining.tick();
    d.after(WEEK_MS);
    await d.mining.tick();

    expect(d.web.calls.length).toBe(calls);
    expect(d.used()).toBe(10);
    expect(d.bell).toHaveLength(1);
    expect(d.bell[0]!.title).toMatch(/skipped/i);
    expect(d.bell[0]!.body).toMatch(/try again next week/i);
    const now = d.mining.get("owner", d.ws, ds.id);
    expect(now.checks!.map((c) => c.status)).toEqual(["skipped", "skipped"]);
    expect(now.watch!.nextCheckAt).toBe("2026-12-07T09:00:00.000Z");

    // Energy is back: the next week runs, and a later shortage is announced again.
    d.energy.setPlan("owner", d.ws, { ...trial, weeklyTeamEnergy: 24 });
    d.after(WEEK_MS);
    await d.mining.tick();
    expect(d.web.calls.length).toBeGreaterThan(calls);
    expect(d.mining.get("owner", d.ws, ds.id).checks![0]!.status).toBe("same");
    d.after(WEEK_MS);
    await d.mining.tick();
    expect(d.bell.filter((b) => /skipped/i.test(b.title))).toHaveLength(2);
  });

  it("keeps the daily limits on a source: a client who used their share today has it left out, not charged", async () => {
    const d = await desk({ keys: { youtube: "yt-key-0123456789" } });
    const ds = await d.search(["news", "youtube"]);
    await d.watchOn(ds.id);
    d.after(WEEK_MS - 60_000);
    // One client's share of YouTube is 8 searches a day; they are used up just before the check.
    for (let i = 0; i < 8; i++) await d.search(["youtube"], `oat milk video ${i}`);
    const videoCalls = d.web.to("www.googleapis.com");
    const usedBefore = d.used();
    d.after(60_000);

    await d.mining.tick();

    expect(d.web.to("www.googleapis.com")).toBe(videoCalls);
    expect(d.used() - usedBefore).toBe(FREE_SOURCE_ENERGY);
    expect(d.mining.get("owner", d.ws, ds.id).checks![0]!.note).toMatch(/YouTube videos/);
  });

  it("counts a weekly read towards the source's daily limit like any other search", async () => {
    const d = await desk({ keys: { youtube: "yt-key-0123456789" } });
    const ds = await d.search(["youtube"]);
    await d.watchOn(ds.id);
    d.after(WEEK_MS);
    await d.mining.tick();

    for (let i = 0; i < 7; i++) await d.search(["youtube"], `oat milk video ${i}`);

    // The weekly read and seven searches make eight: this client's share for the day.
    expect(d.mining.quote("owner", d.ws, { topic: "oat milk", sources: ["youtube"] }).sources[0]).toMatchObject({ available: false, reason: expect.stringMatching(/as often as one team can in a day/) });
  });

  it("keeps a short history of checks and drops the oldest", async () => {
    const d = await desk();
    const ds = await d.search(["news"]);
    await d.watchOn(ds.id);

    for (let i = 0; i < MAX_CHECKS + 3; i++) { d.after(WEEK_MS); await d.mining.tick(); }

    const checks = d.mining.get("owner", d.ws, ds.id).checks!;
    expect(checks).toHaveLength(MAX_CHECKS);
    expect(checks[0]!.at > checks[MAX_CHECKS - 1]!.at).toBe(true);
  });

  it("gives employees the dataset is shared with the newest version", async () => {
    const d = await desk();
    const ds = await d.search(["news"]);
    await d.mining.share("owner", d.ws, ds.id, ["marketing-manager"]);
    await d.watchOn(ds.id);
    d.web.state.articles = [{ title: "Oat milk price cap announced", url: "https://news.example/oat-cap" }];

    d.after(WEEK_MS);
    await d.mining.tick();

    const context = d.mining.contextFor(d.ws, "marketing-manager")!;
    expect(context).toContain("Oat milk price cap announced");
    expect(context).toContain('gathered="2026-11-23"');
    expect(context).not.toContain("Why oat milk costs more");
  });

  it("stops when the client says so, and nothing more is read", async () => {
    const d = await desk();
    const ds = await d.search(["news"]);
    await d.watchOn(ds.id);

    const stopped = d.mining.watch("owner", d.ws, ds.id, { on: false });
    d.after(WEEK_MS);
    const calls = d.web.calls.length;

    expect(stopped.watch).toBeUndefined();
    expect(await d.mining.tick()).toBe(0);
    expect(d.web.calls.length).toBe(calls);
  });

  it("stops by itself when the Data mining agent is no longer on the team, and tells the client once", async () => {
    const d = await desk();
    const first = await d.search(["news"]);
    const second = await d.search(["news"], "coffee carts");
    await d.watchOn(first.id);
    await d.watchOn(second.id);
    const calls = d.web.calls.length;

    d.team.agentGone = true;
    await d.mining.tick();
    d.after(WEEK_MS);
    await d.mining.tick();

    expect(d.web.calls.length).toBe(calls);
    expect(d.bell).toHaveLength(1);
    expect(d.bell[0]!.title).toMatch(/stopped/i);
    expect(d.bell[0]!.body).toMatch(/no longer on your team/);
    // The datasets themselves are kept.
    d.team.agentGone = false;
    expect(d.mining.list("owner", d.ws).map((h) => [h.topic, h.watch])).toEqual([["coffee carts", undefined], ["oat milk prices", undefined]]);
  });

  it("stops and says so when a check would now use more than the figure the client agreed to", async () => {
    const rule = { multiplier: 2 };
    const d = await desk({ keys: { x: "x-bearer-token-0123456789" }, multiplier: () => rule.multiplier });
    const ds = await d.search(["x"]);
    await d.watchOn(ds.id);
    expect(d.mining.get("owner", d.ws, ds.id).watch!.maxEnergy).toBe(X_BASE_ENERGY * 2);
    const calls = d.web.to("api.x.com");

    rule.multiplier = 3;
    d.after(WEEK_MS);
    const usedBefore = d.used();
    await d.mining.tick();

    expect(d.web.to("api.x.com")).toBe(calls);
    expect(d.used()).toBe(usedBefore);
    expect(d.mining.get("owner", d.ws, ds.id).watch).toBeUndefined();
    expect(d.bell[0]!.body).toMatch(/150 energy/);
  });
});

describe("weekly watch: after a restart", () => {
  it("comes back with its next check and its history, and does not repeat a week already done", async () => {
    const store = memorySink();
    const d = await desk({ sink: store.sink });
    const ds = await d.search(["news"]);
    await d.watchOn(ds.id);
    d.web.state.articles.push({ title: "Three", url: "https://news.example/oat-3" });
    d.after(WEEK_MS);
    await d.mining.tick();
    const calls = d.web.to("api.gdeltproject.org");

    const again = d.make(store.sink);
    for (const data of store.datasets()) again.restore(data);
    await again.tick();

    expect(d.web.to("api.gdeltproject.org")).toBe(calls);
    const back = again.get("owner", d.ws, ds.id);
    expect(back.watch).toMatchObject({ sources: ["news"], maxEnergy: 5, nextCheckAt: "2026-11-30T09:00:00.000Z" });
    expect(back.checks).toHaveLength(1);
    expect(back.checks![0]).toMatchObject({ status: "changed", summary: "Oat milk prices: 1 new article" });
    // The week after, the restarted service carries on.
    d.after(WEEK_MS);
    await again.tick();
    expect(d.web.to("api.gdeltproject.org")).toBe(calls + 1);
  });

  it("marks the week as handled before reading, so a crash in the middle cannot run it twice", async () => {
    const store = memorySink();
    const d = await desk({ sink: store.sink });
    const ds = await d.search(["news"]);
    await d.watchOn(ds.id);
    d.after(WEEK_MS);

    // Start the check and look at what is stored before it has finished.
    const running = d.mining.tick();
    const stored = store.datasets().find((x) => (x as { id: string }).id === ds.id) as { watch: { nextCheckAt: string } };
    await running;

    expect(stored.watch.nextCheckAt).toBe("2026-11-30T09:00:00.000Z");
  });

  it("drops a stored watch that is damaged instead of running it", async () => {
    const store = memorySink();
    const d = await desk({ sink: store.sink });
    const ds = await d.search(["news"]);
    await d.watchOn(ds.id);
    const stored = store.datasets()[0] as Record<string, unknown>;

    const again = d.make();
    again.restore({ ...stored, watch: { since: "not a date", sources: ["news", "made-up"], maxEnergy: -4, nextCheckAt: 12 } });

    expect(again.get("owner", d.ws, ds.id).watch).toBeUndefined();
  });
});
