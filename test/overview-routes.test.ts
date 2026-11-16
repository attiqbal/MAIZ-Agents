import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { userIdFor } from "../src/server/identity.js";
import { limitFor } from "../src/server/rate-limit.js";
import { CUSTOMER_SUPPORT_KEY } from "../src/modules/agents/index.js";
import type { Snapshot } from "../src/core/persistence.js";

const T0 = "2026-11-16T09:00:00Z";

function setup() {
  const clock = { d: new Date(T0) };
  const http = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  const metaClients = { mode: "sandbox" as const, appId: "1234567890", appSecret: "shh", verifyToken: "v", loginConfigId: "555", template: { name: "maiz_client_approval", language: "en_GB" } };
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", now: () => clock.d, http, metaClients });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, query = "") =>
    handle({ method, path, query: new URLSearchParams(query), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const signUp = async (email: string, name: string) => {
    const r = await call("POST", "/api/signup", { email, businessName: name, sells: "Coffee", size: "2–10", country: "GB", goal: "More customers" });
    expect(r.status).toBe(201);
    const uid = userIdFor(email);
    return { uid, ws: platform.identity.workspacesFor(uid)[0]!.id, h: { authorization: `Bearer ${(r.body as any).token}` } };
  };
  /** A session for someone who was added to a business, without a business of their own. */
  const sessionFor = (email: string) => ({ authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(email), e: email }, 7 * 86400, clock.d.getTime())}` });
  const approvals = async (h: Record<string, string>) => (await call("GET", "/api/overview/approvals", undefined, h)).body as any;
  /** Presses a button exactly as the website does: the item's own path, with "/api" in front. */
  const press = (h: Record<string, string>, item: any, key: "approve" | "refuse") => {
    const a = item.actions.find((x: any) => x.key === key);
    return call("POST", `/api${a.path}`, a.body, h);
  };
  return { platform, call, clock, signUp, sessionFor, approvals, press };
}
type S = ReturnType<typeof setup>;
type Biz = Awaited<ReturnType<S["signUp"]>>;

async function connectFacebook(s: S, b: Biz) {
  const start = await s.call("POST", "/api/meta/connect", { kind: "facebook" }, b.h);
  const state = new URL((start.body as any).url).searchParams.get("state")!;
  const nonce = /maiz_meta=([^;]+)/.exec(start.headers!["set-cookie"]!)![1]!;
  const cb = await s.call("GET", "/api/meta/callback", undefined, { cookie: `maiz_meta=${nonce}` }, `code=sandbox-facebook-${b.uid}&state=${encodeURIComponent(state)}`);
  const pendingId = /#pending=([0-9a-f]+)/.exec(cb.headers!.location!)![1]!;
  return ((await s.call("POST", "/api/meta/choose", { pendingId, index: 0 }, b.h)).body as any).connection;
}

describe("the three overview screens need a signed-in person and stay inside one business", () => {
  it("refuses every call without a session", async () => {
    const s = setup();
    for (const path of ["/api/overview/approvals", "/api/overview/books", "/api/overview/calendar"]) expect((await s.call("GET", path)).status).toBe(401);
    expect((await s.call("POST", "/api/overview/calendar/dates", { title: "x", date: "2027-01-01" })).status).toBe(401);
  });

  it("shows a brand new client only what is really true: setup is waiting, nothing is connected, the trial has an end date", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");

    const a = await s.approvals(ann.h);
    expect(a.items.map((i: any) => i.kind)).toEqual(["setup"]);
    expect(a.items[0]).toMatchObject({ title: "Your team is waiting to meet you", actions: [], link: { href: "#firstday" } });
    expect(a.summary).toEqual({ total: 1, decideHere: 0, elsewhere: 1 });

    const b = (await s.call("GET", "/api/overview/books", undefined, ann.h)).body as any;
    expect(b).toMatchObject({ apps: [], sales: { sources: [], days: [], totals: [] }, payroll: [], accounts: [], period: { days: 30, to: "2026-11-16" } });
    expect(b.ledger).toMatchObject({ entries: 0, lines: [], waiting: 0, currency: s.platform.identity.workspaceById(ann.ws)!.baseCurrency });
    expect(b.check).toBeUndefined();

    const c = (await s.call("GET", "/api/overview/calendar", undefined, ann.h)).body as any;
    expect(c.items.map((i: any) => i.id)).toEqual(["plan:trial"]);
    expect(c.items[0].daysLeft).toBeGreaterThan(0);
    expect(c).toMatchObject({ today: "2026-11-16", canEdit: true, staffIncluded: true, done: [] });
    expect(c.team.map((e: any) => e.key)).toContain("compliance-manager");
  });

  it("limits how often the screens can be read and changed", () => {
    expect(limitFor("GET", "/api/overview/approvals")).toEqual({ max: 120, windowMs: 60_000 });
    expect(limitFor("GET", "/api/overview/books")).toBeDefined();
    expect(limitFor("GET", "/api/overview/calendar")).toBeDefined();
    expect(limitFor("POST", "/api/overview/calendar/dates")).toEqual({ max: 30, windowMs: 60_000 });
    expect(limitFor("POST", "/api/overview/calendar/dates/abc/remove")).toEqual({ max: 30, windowMs: 60_000 });
  });
});

describe("approvals over the API: every item is decided through its own existing endpoint", () => {
  it("lists a waiting job from the client's own tool and takes it off the list when it is refused", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    await s.platform.workforce.hire(ann.uid, ann.ws, CUSTOMER_SUPPORT_KEY);
    const made = await s.platform.agents.create(ann.uid, ann.ws, { name: "Website chatbot", needsApproval: true });
    s.platform.agents.submit(made.key, { employee: CUSTOMER_SUPPORT_KEY, brief: "Where is order 4471?" });

    const item = (await s.approvals(ann.h)).items.find((i: any) => i.kind === "agent_job");
    expect(item).toMatchObject({ who: "Website chatbot", detail: "Where is order 4471?", source: "Your own AI tools" });
    expect(item.actions.map((x: any) => x.label)).toEqual(["Let it run", "Refuse"]);
    expect((await s.press(ann.h, item, "refuse")).status).toBe(200);
    expect((await s.approvals(ann.h)).items.some((i: any) => i.kind === "agent_job")).toBe(false);
  });

  it("shows an admin the job without buttons, because only the owner may decide it", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    await s.platform.workforce.hire(ann.uid, ann.ws, CUSTOMER_SUPPORT_KEY);
    const made = await s.platform.agents.create(ann.uid, ann.ws, { name: "Bot", needsApproval: true });
    s.platform.agents.submit(made.key, { employee: CUSTOMER_SUPPORT_KEY, brief: "Hello" });
    s.platform.identity.addMember(ann.uid, ann.ws, userIdFor("adam@kestrel.co"), "admin");

    const item = (await s.approvals(s.sessionFor("adam@kestrel.co"))).items.find((i: any) => i.kind === "agent_job");
    expect(item.actions).toEqual([]);
    expect(item.blocked).toMatch(/Only the owner/);
  });

  it("lists a social post waiting for a yes and removes it once it is approved", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const conn = await connectFacebook(s, ann);
    const post = ((await s.call("POST", "/api/meta/posts", { connectionId: conn.id, text: "Autumn blend is here" }, ann.h)).body as any).post;

    const item = (await s.approvals(ann.h)).items.find((i: any) => i.id === `social_post:${post.id}`);
    expect(item).toMatchObject({ detail: "Autumn blend is here", cost: "Uses no energy" });
    expect(item.title).toBe(`Post to Facebook: ${conn.name}`);
    expect((await s.press(ann.h, item, "approve")).status).toBe(200);
    expect((await s.approvals(ann.h)).items.some((i: any) => i.kind === "social_post")).toBe(false);
  });

  it("lists a leave request for the people who may open staff records, and nobody else", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const staff = ((await s.call("POST", "/api/people", { name: "Priya Shah", jobTitle: "Barista", startDate: "2026-03-02", contract: "part_time", hoursPerWeek: 24 }, ann.h)).body as any).member;
    await s.call("POST", `/api/people/${staff.id}/leave`, { from: "2026-12-22", to: "2026-12-23", days: 2, status: "requested" }, ann.h);
    s.platform.identity.addMember(ann.uid, ann.ws, userIdFor("mia@kestrel.co"), "member");

    expect((await s.approvals(s.sessionFor("mia@kestrel.co"))).items.some((i: any) => i.kind === "leave_request")).toBe(false);
    const item = (await s.approvals(ann.h)).items.find((i: any) => i.kind === "leave_request");
    expect(item).toMatchObject({ who: "Priya Shah", title: "Holiday request: 2 days", detail: "22 Dec 2026 to 23 Dec 2026" });
    expect((await s.press(ann.h, item, "refuse")).status).toBe(200);
    expect((await s.approvals(ann.h)).items.some((i: any) => i.kind === "leave_request")).toBe(false);
  });

  it("never shows one business what is waiting in another", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const bob = await s.signUp("bob@bakery.co", "Bob's Bakery");
    const staff = ((await s.call("POST", "/api/people", { name: "Priya Shah", jobTitle: "Barista", startDate: "2026-03-02", contract: "part_time", hoursPerWeek: 24 }, ann.h)).body as any).member;
    await s.call("POST", `/api/people/${staff.id}/leave`, { from: "2026-12-22", to: "2026-12-23", days: 2, status: "requested" }, ann.h);
    expect(JSON.stringify(await s.approvals(bob.h))).not.toMatch(/Priya/);
    expect(JSON.stringify((await s.call("GET", "/api/overview/calendar", undefined, bob.h)).body)).not.toMatch(/Priya/);
  });
});

describe("books and cash over the API: figures arrive only from a connected app", () => {
  it("shows a day of takings with the app's name, says it is waiting, and shows the books once it is added", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const hook = (await s.call("POST", "/api/integrations/apps/webhook/connect", {}, ann.h)).body as any;
    const path = new URL(hook.url).pathname;
    // The bridge takes amounts in pence, and a day with no currency named is in the currency of the client's books.
    const currency = s.platform.identity.workspaceById(ann.ws)!.baseCurrency;
    expect((await s.call("POST", path, { sales: [{ date: "2026-11-15", gross: 50_000, tax: 8_333, fees: 750, refunds: 2_000, transactions: 31 }] })).status).toBe(200);

    const before = (await s.call("GET", "/api/overview/books", undefined, ann.h, "days=7")).body as any;
    expect(before.period).toEqual({ from: "2026-11-10", to: "2026-11-16", days: 7 });
    expect(before.apps).toHaveLength(1);
    expect(before.sales.sources[0]).toMatchObject({ app: before.apps[0].app, currency, moneyIn: 50_000, refunds: 2_000, fees: 750, transactions: 31, daysWithFigures: 1, waiting: 1 });
    expect(before.sales.days).toEqual([{ date: "2026-11-15", currency, moneyIn: 50_000, refunds: 2_000, fees: 750, tips: 0, transactions: 31, apps: [before.apps[0].app] }]);
    expect(before.ledger).toMatchObject({ entries: 0, waiting: 1 });

    const waiting = (await s.approvals(ann.h)).items.find((i: any) => i.kind === "books_pending");
    expect(waiting).toMatchObject({ title: "1 day of figures is waiting to go into your books", detail: "15 Nov 2026", link: { href: "#apps" }, actions: [] });

    expect((await s.call("POST", "/api/integrations/post", {}, ann.h)).body).toMatchObject({ posted: 1 });
    const after = (await s.call("GET", "/api/overview/books", undefined, ann.h)).body as any;
    expect(after.ledger).toMatchObject({ opened: true, entries: 1, fromApps: 1, waiting: 0, lastEntryDate: "2026-11-15" });
    expect(after.ledger.lines.some((l: any) => l.type === "income" && l.amount > 0)).toBe(true);
    expect(after.sales.sources[0].waiting).toBe(0);
    expect((await s.approvals(ann.h)).items.some((i: any) => i.kind === "books_pending")).toBe(false);
    expect(JSON.stringify(after)).not.toMatch(/balance|runway|payout|cashNow/i);
  });

  it("refuses a period that is not one of the three on the screen", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    for (const days of ["365", "0", "abc", "30.5"]) expect((await s.call("GET", "/api/overview/books", undefined, ann.h, `days=${days}`)).status).toBe(400);
    expect((await s.call("GET", "/api/overview/books", undefined, ann.h, "days=90")).status).toBe(200);
  });

  it("keeps another business's figures out", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const bob = await s.signUp("bob@bakery.co", "Bob's Bakery");
    const hook = (await s.call("POST", "/api/integrations/apps/webhook/connect", {}, ann.h)).body as any;
    await s.call("POST", new URL(hook.url).pathname, { sales: [{ date: "2026-11-15", gross: 500 }] });
    const b = (await s.call("GET", "/api/overview/books", undefined, bob.h)).body as any;
    expect(b).toMatchObject({ apps: [], sales: { sources: [], days: [], totals: [] } });
  });
});

describe("the calendar over the API: the client's own dates", () => {
  it("adds, changes, ticks off and removes a date", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const add = await s.call("POST", "/api/overview/calendar/dates", { title: "Renew the premises licence", date: "2026-12-01", repeat: "yearly", note: "Council ref 88", employee: "compliance-manager", remindDays: 14 }, ann.h);
    expect(add.status).toBe(201);
    const id = (add.body as any).date.id;

    const cal = (await s.call("GET", "/api/overview/calendar", undefined, ann.h)).body as any;
    const mine = cal.items.find((i: any) => i.id === `own:${id}`);
    expect(mine).toMatchObject({ kind: "yours", date: "2026-12-01", title: "Renew the premises licence", note: "Council ref 88", source: "Added by you", state: "soon", owner: { key: "compliance-manager", title: "Compliance manager" }, own: { id, repeat: "yearly", remindDays: 14 } });

    const changed = await s.call("POST", `/api/overview/calendar/dates/${id}`, { title: "Renew the licence", employee: "" }, ann.h);
    expect(changed).toMatchObject({ status: 200, body: { date: { title: "Renew the licence", date: "2026-12-01" } } });
    expect((changed.body as any).date.employee).toBeUndefined();

    expect((await s.call("POST", `/api/overview/calendar/dates/${id}/done`, { done: true }, ann.h)).body).toMatchObject({ date: { doneThrough: "2026-12-01" } });
    const next = ((await s.call("GET", "/api/overview/calendar", undefined, ann.h)).body as any).items.find((i: any) => i.id === `own:${id}`);
    expect(next.date).toBe("2027-12-01");

    expect((await s.call("POST", `/api/overview/calendar/dates/${id}/remove`, {}, ann.h))).toMatchObject({ status: 200, body: { removed: true } });
    expect(((await s.call("GET", "/api/overview/calendar", undefined, ann.h)).body as any).items.some((i: any) => i.kind === "yours")).toBe(false);
    expect((await s.call("POST", `/api/overview/calendar/dates/${id}/remove`, {}, ann.h)).status).toBe(404);
  });

  it("keeps a ticked one-off date where the tick can be taken back", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const id = ((await s.call("POST", "/api/overview/calendar/dates", { title: "Fire alarm test", date: "2026-11-20" }, ann.h)).body as any).date.id;
    await s.call("POST", `/api/overview/calendar/dates/${id}/done`, { done: true }, ann.h);
    const cal = (await s.call("GET", "/api/overview/calendar", undefined, ann.h)).body as any;
    expect(cal.items.some((i: any) => i.id === `own:${id}`)).toBe(false);
    expect(cal.done).toEqual([{ id, title: "Fire alarm test", date: "2026-11-20" }]);
    await s.call("POST", `/api/overview/calendar/dates/${id}/done`, { done: false }, ann.h);
    expect(((await s.call("GET", "/api/overview/calendar", undefined, ann.h)).body as any).items.some((i: any) => i.id === `own:${id}`)).toBe(true);
  });

  it("answers bad input with a plain reason, and an unknown date as not found", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const bad = async (b: unknown) => s.call("POST", "/api/overview/calendar/dates", b, ann.h);
    expect(await bad({ title: "", date: "2027-01-01" })).toMatchObject({ status: 400, body: { error: "Say what the date is for." } });
    expect(await bad({ title: "A", date: "2027-02-30" })).toMatchObject({ status: 400, body: { error: "Pick a real date." } });
    expect((await bad({ title: "A", date: "2027-01-01", employee: "nobody" })).status).toBe(400);
    const id = ((await bad({ title: "A", date: "2027-01-01" })).body as any).date.id;
    expect((await s.call("POST", `/api/overview/calendar/dates/${id}/done`, { done: "yes" }, ann.h)).status).toBe(400);
    expect((await s.call("POST", "/api/overview/calendar/dates/not-a-real-id", { title: "B" }, ann.h))).toMatchObject({ status: 404, body: { error: "That date is not on your calendar." } });
    expect((await s.call("POST", `/api/overview/calendar/dates/${"x".repeat(80)}`, { title: "B" }, ann.h)).status).toBe(404);
  });

  it("lets the owner and admins change the calendar, lets everyone else only look, and keeps other businesses out", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const bob = await s.signUp("bob@bakery.co", "Bob's Bakery");
    const id = ((await s.call("POST", "/api/overview/calendar/dates", { title: "Insurance renewal", date: "2027-01-01" }, ann.h)).body as any).date.id;
    s.platform.identity.addMember(ann.uid, ann.ws, userIdFor("mia@kestrel.co"), "member");
    s.platform.identity.addMember(ann.uid, ann.ws, userIdFor("vic@kestrel.co"), "viewer");
    s.platform.identity.addMember(ann.uid, ann.ws, userIdFor("adam@kestrel.co"), "admin");
    const mia = s.sessionFor("mia@kestrel.co"), vic = s.sessionFor("vic@kestrel.co"), adam = s.sessionFor("adam@kestrel.co");

    expect((await s.call("POST", "/api/overview/calendar/dates", { title: "x", date: "2027-01-01" }, mia)).status).toBe(403);
    expect((await s.call("POST", `/api/overview/calendar/dates/${id}`, { title: "x" }, mia)).status).toBe(403);
    expect((await s.call("POST", `/api/overview/calendar/dates/${id}/done`, { done: true }, vic)).status).toBe(403);
    expect((await s.call("POST", `/api/overview/calendar/dates/${id}/remove`, {}, vic)).status).toBe(403);
    const seen = (await s.call("GET", "/api/overview/calendar", undefined, vic)).body as any;
    expect(seen).toMatchObject({ canEdit: false, staffIncluded: false });
    expect(seen.items.some((i: any) => i.id === `own:${id}`)).toBe(true);
    expect((await s.call("POST", `/api/overview/calendar/dates/${id}`, { title: "Insurance" }, adam)).status).toBe(200);

    // Another business cannot see, change or remove it, and learns nothing about whether it exists.
    expect(JSON.stringify((await s.call("GET", "/api/overview/calendar", undefined, bob.h)).body)).not.toMatch(/Insurance/);
    expect((await s.call("POST", `/api/overview/calendar/dates/${id}`, { title: "mine" }, bob.h)).status).toBe(404);
    expect((await s.call("POST", `/api/overview/calendar/dates/${id}/remove`, {}, bob.h)).status).toBe(404);
    expect(((await s.call("GET", "/api/overview/calendar", undefined, ann.h)).body as any).items.find((i: any) => i.id === `own:${id}`).title).toBe("Insurance");
  });

  it("rings the client's bell before the date, with a link back to the calendar", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    await s.call("POST", "/api/overview/calendar/dates", { title: "Renew the insurance", date: "2026-11-20", remindDays: 7 }, ann.h);
    s.platform.overview.dates.tick();
    s.platform.overview.dates.tick();
    const bell = (await s.call("GET", "/api/notifications", undefined, ann.h)).body as any;
    const mine = bell.notices.filter((n: any) => /Renew the insurance/.test(n.title));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: "In 4 days: Renew the insurance", link: "/app.html#compliance" });
  });

  it("puts staff dates, a tool key and the plan on the calendar from the records themselves", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    await s.call("POST", "/api/people/settings", { sector: "hospitality" }, ann.h);
    const staff = ((await s.call("POST", "/api/people", { name: "Priya Shah", jobTitle: "Barista", startDate: "2026-03-02", contract: "part_time", hoursPerWeek: 24, probationEndsOn: "2026-12-02" }, ann.h)).body as any).member;
    await s.platform.workforce.hire(ann.uid, ann.ws, CUSTOMER_SUPPORT_KEY);
    const made = await s.platform.agents.create(ann.uid, ann.ws, { name: "Website chatbot" });

    const cal = (await s.call("GET", "/api/overview/calendar", undefined, ann.h)).body as any;
    const ids = cal.items.map((i: any) => i.id);
    expect(ids).toContain("plan:trial");
    expect(ids).toContain(`connection:key:${made.connection.id}`);
    expect(cal.items.find((i: any) => i.id === `staff:${staff.id}:review:probation`)).toMatchObject({ title: "Priya Shah: Probation review due", date: "2026-12-02", source: "Staff records", href: "#people" });
    expect(cal.items.map((i: any) => i.date)).toEqual([...cal.items.map((i: any) => i.date)].sort());
  });

  it("brings the client's dates back after a restart, and leaves removed ones out", async () => {
    const writes: { workspaceId: string; kind: string; id: string; data: any }[] = [];
    const empty = { workspaces: [], memberships: [], employees: [], profiles: [], training: [], accounts: [], entries: [], usage: [], plans: [], audit: [], connections: [], links: [], adminOrgs: [], adminMessages: [], slackTokens: [] } as unknown as Snapshot;
    const store = (snapshot: Snapshot) => new Proxy({} as any, {
      get: (_t, prop) => {
        if (prop === "load") return async () => snapshot;
        if (prop === "flush") return async () => {};
        if (prop === "record") return (workspaceId: string, kind: string, id: string, data: unknown) => writes.push({ workspaceId, kind, id, data: JSON.parse(JSON.stringify(data)) });
        if (prop === "then") return undefined;
        return () => {};
      },
    });
    const a = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), now: () => new Date(T0) });
    await a.attachStore(store(empty));
    const ws = (await a.identity.createWorkspace("u_ann", { name: "Kestrel Coffee" })).id;
    const kept = a.overview.dates.add("u_ann", ws, { title: "Insurance renewal", date: "2027-01-01", repeat: "yearly" });
    const gone = a.overview.dates.add("u_ann", ws, { title: "Old one", date: "2027-02-01" });
    a.overview.dates.remove("u_ann", ws, gone.id);

    const b = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), now: () => new Date(T0) });
    const latest = [...new Map(writes.map((r) => [`${r.kind}|${r.id}`, r])).values()];
    await b.attachStore(store({ ...empty, records: latest } as Snapshot));
    await b.identity.createWorkspace("u_ann", { name: "Kestrel Coffee" });
    // The restored date still belongs to the first business's id, so it is read at platform level here.
    expect(b.overview.dates.contextFor(ws, "compliance-manager")).toMatch(/2027-01-01: Insurance renewal \(repeats every year\)/);
    expect(b.overview.dates.contextFor(ws, "compliance-manager")).not.toMatch(/Old one/);
    expect(kept.id).not.toBe(gone.id);
  });
});
