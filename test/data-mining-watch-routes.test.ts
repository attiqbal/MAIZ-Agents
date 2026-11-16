import { describe, expect, it } from "vitest";
import { FREE_SOURCE_ENERGY } from "../src/modules/data-mining/index.js";
import { WEEK_MS, miningApp } from "./mining-app.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("weekly watch routes", () => {
  it("shows what a week uses at most first, then switches on with that figure confirmed", async () => {
    const s = miningApp();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const id = ((await s.run(ann.auth, { topic: "coffee carts", sources: ["news", "hackernews"] })).body as any).dataset.id as string;

    const asked = await s.call("POST", `/api/mining/datasets/${id}/watch`, { on: true }, ann.auth);

    expect(asked.status).toBe(409);
    expect((asked.body as any).quote).toMatchObject({ total: FREE_SOURCE_ENERGY * 2 });
    expect((asked.body as any).error).toMatch(/up to 10 energy each week/);
    const on = await s.call("POST", `/api/mining/datasets/${id}/watch`, { on: true, confirm: true, confirmEnergy: 10 }, ann.auth);
    expect(on.status).toBe(200);
    expect((on.body as any).dataset.watch).toMatchObject({ sources: ["news", "hackernews"], maxEnergy: 10 });
    // The workspace id never leaves the server.
    expect(JSON.stringify(on.body)).not.toContain(ann.ws);
    expect(((await s.call("GET", "/api/mining", undefined, ann.auth)).body as any).datasets[0].watch).toMatchObject({ maxEnergy: 10 });
  });

  it("rings the bell once with a line that opens the dataset when a weekly check finds something new", async () => {
    const s = miningApp();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const id = ((await s.run(ann.auth, { topic: "coffee carts", sources: ["news"] })).body as any).dataset.id as string;
    await s.call("POST", `/api/mining/datasets/${id}/watch`, { on: true, confirm: true, confirmEnergy: FREE_SOURCE_ENERGY }, ann.auth);
    const bellBefore = ((await s.call("GET", "/api/notifications", undefined, ann.auth)).body as any).notices.length;

    // The business is in Great Britain, so the check waits for three in the morning there: a week later is enough.
    s.web.state.articles.push({ title: "Coffee cart licences change", url: "https://news.example/licences" });
    s.after(WEEK_MS);
    await s.platform.mining.tick();
    await s.platform.mining.tick();

    // A week on, Ann signs in again (her old session has run out).
    const auth = s.tokenFor("ann@kestrel.co");
    const notices = ((await s.call("GET", "/api/notifications", undefined, auth)).body as any).notices;
    expect(notices).toHaveLength(bellBefore + 1);
    expect(notices[0]).toMatchObject({ body: "Coffee carts: 1 new article", link: `/app.html#mining/${id}` });
    const dataset = ((await s.call("GET", `/api/mining/datasets/${id}`, undefined, auth)).body as any).dataset;
    expect(dataset.checks[0]).toMatchObject({ status: "changed", summary: "Coffee carts: 1 new article", energyUsed: FREE_SOURCE_ENERGY });
    expect(dataset.checks[0].newItems[0]).toMatchObject({ title: "Coffee cart licences change", sourceId: "news" });
  });

  it("stops when asked, and never touches another client's dataset", async () => {
    const s = miningApp();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const bob = await s.signUp("bob@other.co", "Other Ltd");
    const id = ((await s.run(ann.auth, { topic: "coffee carts", sources: ["news"] })).body as any).dataset.id as string;
    await s.call("POST", `/api/mining/datasets/${id}/watch`, { on: true, confirm: true, confirmEnergy: FREE_SOURCE_ENERGY }, ann.auth);

    expect((await s.call("POST", `/api/mining/datasets/${id}/watch`, { on: true }, bob.auth)).status).toBe(404);
    expect((await s.call("POST", `/api/mining/datasets/${id}/watch`, { on: false }, bob.auth)).status).toBe(404);
    expect((await s.call("POST", `/api/mining/datasets/${id}/watch`, { on: true })).status).toBe(401);

    const off = await s.call("POST", `/api/mining/datasets/${id}/watch`, { on: false }, ann.auth);
    expect(off.status).toBe(200);
    expect((off.body as any).dataset.watch).toBeUndefined();
    s.after(WEEK_MS);
    expect(await s.platform.mining.tick()).toBe(0);
  });

  it("refuses sources that are not on the list", async () => {
    const s = miningApp();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const id = ((await s.run(ann.auth, { topic: "coffee carts", sources: ["news"] })).body as any).dataset.id as string;

    const r = await s.call("POST", `/api/mining/datasets/${id}/watch`, { on: true, sources: ["news", "the-dark-web"] }, ann.auth);

    expect(r.status).toBe(400);
  });
});
