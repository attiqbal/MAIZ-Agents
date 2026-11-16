import { describe, expect, it } from "vitest";
import { DATA_MINING_AGENT, FREE_SOURCE_ENERGY, readSearchRequest } from "../src/modules/data-mining/index.js";
import { miningApp } from "./mining-app.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("search from chat: is this a request to look something up?", () => {
  it("reads the topic out of a plain request to the Data mining agent", () => {
    expect(readSearchRequest("Find what people are saying about oat milk prices", "addressed")).toEqual({ topic: "oat milk prices", named: [] });
    expect(readSearchRequest("Can you look up coffee carts please?", "addressed")).toEqual({ topic: "coffee carts", named: [] });
    expect(readSearchRequest("research oat milk", "addressed")).toEqual({ topic: "oat milk", named: [] });
  });

  it("notices the places the client named", () => {
    expect(readSearchRequest("Look up coffee carts on Reddit and the news", "addressed")).toEqual({ topic: "coffee carts", named: ["reddit", "news"] });
    expect(readSearchRequest("Search Hacker News for coffee carts", "addressed")).toEqual({ topic: "coffee carts", named: ["hackernews"] });
    expect(readSearchRequest("find posts about oat milk on X", "addressed")).toEqual({ topic: "oat milk", named: ["x"] });
  });

  it("leaves a question about saved datasets, or a bigger job, to the employee", () => {
    expect(readSearchRequest("What did the last dataset say about prices?", "addressed")).toBeUndefined();
    expect(readSearchRequest("Find the inflation figure in the dataset you gathered", "addressed")).toBeUndefined();
    expect(readSearchRequest("Find news about oat milk and then write a blog post", "addressed")).toBeUndefined();
    expect(readSearchRequest("Thanks, that is useful", "addressed")).toBeUndefined();
  });

  it("in the ask bar, only takes something that is clearly a request for public market data", () => {
    expect(readSearchRequest("Find market data on oat milk prices", "open")).toEqual({ topic: "oat milk prices", named: [] });
    expect(readSearchRequest("Look up what people are saying about coffee carts", "open")).toEqual({ topic: "coffee carts", named: [] });
    expect(readSearchRequest("Search the news for oat milk prices", "open")).toEqual({ topic: "oat milk prices", named: ["news"] });
    // Ordinary work for the team is not a search.
    expect(readSearchRequest("Find me a new supplier for cups", "open")).toBeUndefined();
    expect(readSearchRequest("What should I charge for a flat white?", "open")).toBeUndefined();
    expect(readSearchRequest("Look up coffee carts", "open")).toBeUndefined();
    expect(readSearchRequest("Write a post about the news", "open")).toBeUndefined();
  });

  it("cleans the topic like the screen does, and gives up on one that is too short", () => {
    expect(readSearchRequest('Find news about "oat milk" <b>prices</b>', "addressed")!.topic).toBe("oat milk b prices /b");
    expect(readSearchRequest("find it", "addressed")).toBeUndefined();
  });
});

async function hired() {
  const s = miningApp();
  const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
  const team = s.platform.workforce.team(ann.userId, ann.ws);
  const other = team.find((e) => e.templateKey !== DATA_MINING_AGENT)!;
  const ask = (text: string, employeeId = ann.agent!, extra: Record<string, unknown> = {}) => s.call("POST", "/api/ask", { text, employeeId, ...extra }, ann.auth);
  const thread = async () => ((await s.call("GET", `/api/conversations/${ann.agent}`, undefined, ann.auth)).body as any).turns as any[];
  const used = () => s.platform.energy.teamEnergyOf(ann.ws)!.used;
  const datasets = async () => ((await s.call("GET", "/api/mining", undefined, ann.auth)).body as any).datasets as any[];
  return { ...s, ann, other, ask, thread, used, datasets };
}

describe("search from chat: the quote", () => {
  it("answers with the same quote the screen gives, and runs nothing", async () => {
    const s = await hired();
    const before = s.used();

    const r = await s.ask("Find what people are saying about coffee carts in the news and on Hacker News");

    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.offer).toEqual({ kind: "mining", topic: "coffee carts", sources: ["news", "hackernews"], total: FREE_SOURCE_ENERGY * 2 });
    expect(body.answer).toMatch(/"coffee carts"/);
    expect(body.answer).toMatch(/News coverage \(5 energy\)/);
    expect(body.answer).toMatch(/Hacker News discussions \(5 energy\)/);
    expect(body.answer).toMatch(/up to 10 energy/);
    expect(body.answer).toMatch(/only pay for sources that find something/i);
    expect(body.answer).toMatch(/Nothing has been looked up yet/);
    // The same figure the Market data screen shows for the same request.
    const screen = await s.call("POST", "/api/mining/run", { topic: "coffee carts", sources: ["news", "hackernews"] }, s.ann.auth);
    expect((screen.body as any).quote.total).toBe(body.offer.total);
    // Nothing was read, charged or saved.
    expect(s.web.calls).toEqual([]);
    expect(s.used()).toBe(before);
    expect(body.energyUsed).toBe(0);
    expect(await s.datasets()).toEqual([]);
    // The offer is in the conversation, so it is still there after a reload.
    const turns = await s.thread();
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ role: "employee", offer: body.offer });
  });

  it("uses the usual places when none is named, and leaves out any that MAIZ has not switched on", async () => {
    const s = await hired();

    const body = (await s.ask("Look up oat milk")).body as any;

    // Reddit and YouTube need keys this server does not have.
    expect(body.offer.sources).toEqual(["news", "hackernews"]);
    expect(body.answer).not.toMatch(/Reddit/);
  });

  it("says so when a place the client named is not available", async () => {
    const s = await hired();

    const body = (await s.ask("Look up oat milk on Reddit and the news")).body as any;

    expect(body.offer).toMatchObject({ sources: ["news"], total: FREE_SOURCE_ENERGY });
    expect(body.answer).toMatch(/Reddit conversations is not available yet/);
  });

  it("answers over the live stream too, as one finished reply", async () => {
    const s = await hired();
    const events: { event: string; data: any }[] = [];

    const r = await s.call("POST", "/api/ask/stream", { text: "Research coffee carts", employeeId: s.ann.agent }, s.ann.auth);
    await r.stream!((event, data) => { events.push({ event, data }); });

    expect(events.map((e) => e.event)).toEqual(["accepted", "done"]);
    expect(events[1]!.data.offer).toMatchObject({ kind: "mining", topic: "coffee carts" });
    expect(s.web.calls).toEqual([]);
  });

  it("still lets the client ask the agent about what is already saved", async () => {
    const s = await hired();

    const body = (await s.ask("What did the last dataset say?")).body as any;

    expect(body.offer).toBeUndefined();
    expect(body.status).not.toBe("failed");
  });
});

describe("search from chat: confirm and not now", () => {
  it("runs after Confirm and start, and puts the summary and a link to the dataset in the conversation", async () => {
    const s = await hired();
    await s.ask("Find what people are saying about coffee carts in the news and on Hacker News");
    const before = s.used();

    const r = await s.call("POST", "/api/mining/chat/confirm", {}, s.ann.auth);

    expect(r.status).toBe(200);
    const saved = await s.datasets();
    expect(saved).toHaveLength(1);
    expect(s.used() - before).toBe(10);
    const reply = (r.body as any).reply;
    expect(reply.link).toEqual({ href: `/app.html#mining/${saved[0].id}`, label: "Open this dataset on Market data" });
    expect(reply.text).toMatch(/10 energy/);
    expect(reply.text).toContain("Coffee carts are booming");
    expect(reply.offer).toBeUndefined();
    const turns = await s.thread();
    expect(turns.map((t) => t.role)).toEqual(["you", "employee", "you", "employee"]);
    expect(turns[2].text).toBe("Confirm and start");
    expect(turns[3].link.href).toBe(`/app.html#mining/${saved[0].id}`);
    // Pressing again finds nothing waiting: the search cannot run twice.
    expect((await s.call("POST", "/api/mining/chat/confirm", {}, s.ann.auth)).status).toBe(400);
    expect(await s.datasets()).toHaveLength(1);
  });

  it("does nothing after Not now, and says no energy was used", async () => {
    const s = await hired();
    await s.ask("Research coffee carts");

    const r = await s.call("POST", "/api/mining/chat/decline", {}, s.ann.auth);

    expect(r.status).toBe(200);
    expect((r.body as any).reply.text).toMatch(/Nothing was looked up and no energy was used/);
    expect(s.web.calls).toEqual([]);
    expect(s.used()).toBe(0);
    expect((await s.thread())[2].text).toBe("Not now");
    expect((await s.call("POST", "/api/mining/chat/confirm", {}, s.ann.auth)).status).toBe(400);
  });

  it("refuses a confirm when nothing is waiting, including from another client", async () => {
    const s = await hired();
    const bob = await s.signUp("bob@other.co", "Other Ltd");
    await s.ask("Research coffee carts");

    expect((await s.call("POST", "/api/mining/chat/confirm", {}, bob.auth)).status).toBe(400);
    expect((await s.call("POST", "/api/mining/chat/confirm", {})).status).toBe(401);
    expect(s.web.calls).toEqual([]);
    // Asking something else first means the offer is no longer the last thing said.
    await s.ask("What did the last dataset say?");
    expect((await s.call("POST", "/api/mining/chat/confirm", {}, s.ann.auth)).status).toBe(400);
  });

  it("shows the new figure instead of running when it changed since the offer was made", async () => {
    const s = await hired();
    // An offer made when the figure was different (as after a price change).
    s.platform.conversations.record(s.ann.userId, s.ann.ws, s.ann.agent!, "Research coffee carts", { text: "old offer", status: "answered", offer: { kind: "mining", topic: "coffee carts", sources: ["news"], total: 3 } });

    const r = await s.call("POST", "/api/mining/chat/confirm", {}, s.ann.auth);

    expect(r.status).toBe(200);
    expect((r.body as any).reply.offer).toEqual({ kind: "mining", topic: "coffee carts", sources: ["news"], total: FREE_SOURCE_ENERGY });
    expect((r.body as any).reply.text).toMatch(/figure has changed/i);
    expect(s.web.calls).toEqual([]);
    expect(s.used()).toBe(0);
  });

  it("says in plain words when the search found nothing, and charges nothing", async () => {
    const s = await hired();
    s.web.state.articles = [];
    await s.ask("Look up coffee carts in the news");

    const r = await s.call("POST", "/api/mining/chat/confirm", {}, s.ann.auth);

    expect(r.status).toBe(200);
    expect((r.body as any).reply.text).toMatch(/Nothing was found, so no energy was used/);
    expect(s.used()).toBe(0);
  });
});

describe("search from chat: the ask bar", () => {
  it("offers a search for a clear market data request, and keeps the offer in the Data mining agent's conversation", async () => {
    const s = await hired();

    const body = (await s.ask("Look up market data on coffee carts", s.other.id, { bar: true })).body as any;

    expect(body.offer).toMatchObject({ kind: "mining", topic: "coffee carts" });
    expect(body.employee).toBe("Data mining agent");
    expect((await s.thread())[1].offer).toBeDefined();
    expect(s.web.calls).toEqual([]);
  });

  it("leaves ordinary questions with the employee they were sent to", async () => {
    const s = await hired();

    const bar = (await s.ask("What should I charge for a flat white?", s.other.id, { bar: true })).body as any;
    // In a conversation with another employee nothing is taken over, whatever the words.
    const chat = (await s.ask("Look up market data on coffee carts", s.other.id)).body as any;

    expect(bar.offer).toBeUndefined();
    expect(chat.offer).toBeUndefined();
    expect(await s.thread()).toEqual([]);
  });

  it("says the Data mining agent is not on the team, with a link to the store, when it has not been hired", async () => {
    const s = miningApp();
    const cat = await s.signUp("cat@plain.co", "Plain Ltd", false);
    const someone = s.platform.workforce.team(cat.userId, cat.ws)[0]!;

    const asked = (await s.call("POST", "/api/ask", { text: "Find market data on coffee carts", employeeId: someone.id, bar: true }, cat.auth)).body as any;
    const prefixed = (await s.call("POST", "/api/ask", { text: "data: what are people saying about coffee?", employeeId: someone.id, bar: true }, cat.auth)).body as any;

    for (const body of [asked, prefixed]) {
      expect(body.answer).toMatch(/Data mining agent is not on your team/);
      expect(body.link).toEqual({ href: "/app.html#store", label: "Open the store" });
      expect(body.offer).toBeUndefined();
      expect(body.energyUsed).toBe(0);
    }
    expect(s.web.calls).toEqual([]);
    expect((await s.call("POST", "/api/mining/chat/confirm", {}, cat.auth)).status).toBe(400);
  });
});
