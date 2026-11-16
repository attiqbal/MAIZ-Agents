import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { CATALOG, defOf, type ConnDef } from "../src/modules/connections/catalog.js";
import { modeOf, tierOf } from "../src/modules/connections/tiers.js";
import { META_STORE_KEY, unpackMeta } from "../src/modules/connections/meta.js";
import { limitFor } from "../src/server/rate-limit.js";
import type { Snapshot } from "../src/core/persistence.js";

const OWNER = "atif@maiz.test";
const TOKEN = "EAAtesttoken1234567890";
const start = new Date("2026-11-20T09:00:00Z");

type Answer = { status?: number; json?: unknown };

function setup(opts: { answer?: (url: string) => Answer; env?: Record<string, string> } = {}) {
  const http = (async (url: unknown) => {
    const a = opts.answer?.(String(url)) ?? { json: { id: "1", name: "MAIZ" } };
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  }) as typeof fetch;
  const clock = { d: start };
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, platformOwners: [OWNER], appUrl: "https://maizagents.com", now: () => clock.d, http, connectionEnv: opts.env });
  const app = createApp(platform);
  const owner = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(OWNER), e: OWNER }, 86400, start.getTime())}` };
  const stranger = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor("x@y.test"), e: "x@y.test" }, 86400, start.getTime())}` };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = owner) =>
    app({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const card = async (key: string) => ((await call("GET", "/api/owner/connections")).body as any).connections.find((c: any) => c.key === key);
  const later = (minutes: number) => { clock.d = new Date(clock.d.getTime() + minutes * 60_000); return clock.d.toISOString(); };
  return { platform, call, card, later, stranger };
}

/** A store that only records what is written to the encrypted connection records, and hands back what it is given. */
function fakeStore(writes: [string, string][], saved: { key: string; secret: string }[] = []) {
  return new Proxy({} as any, {
    get: (_t, prop) => {
      if (prop === "load") return async () => ({ workspaces: [], memberships: [], employees: [], profiles: [], training: [], accounts: [], entries: [], usage: [], plans: [], audit: [], connections: [], links: [], adminOrgs: [], adminMessages: [], slackTokens: [], connectionSecrets: saved }) as Snapshot;
      if (prop === "flush") return async () => {};
      if (prop === "connectionSecret") return (k: string, s: string) => writes.push([k, s]);
      if (prop === "then") return undefined;
      return () => {};
    },
  });
}
const latest = (writes: [string, string][]): { key: string; secret: string }[] => [...new Map(writes).entries()].map(([key, secret]) => ({ key, secret })).filter((x) => x.secret);

describe("connection tiers", () => {
  it("puts payment, the AI engine, quality checking and email in Critical", () => {
    const critical = CATALOG.filter((d) => tierOf(d).tier === "critical").map((d) => d.key).sort();
    expect(critical).toEqual(["anthropic", "resend", "runpod", "stripe"]);
  });

  it("puts what main features depend on in Must have", () => {
    for (const key of ["google", "microsoft", "slack", "xero", "quickbooks", "google-data"]) expect(tierOf(defOf(key)!).tier, key).toBe("must");
  });

  it("leaves the owner's own channels, market research sources and extra client apps as Optional", () => {
    for (const key of ["facebook", "instagram", "whatsapp", "square", "reddit", "youtube", "x", "fred", "alphavantage", "companieshouse", "creatomate", "hubspot", "tiktok", "canva", "envato"]) expect(tierOf(defOf(key)!).tier, key).toBe("optional");
  });

  it("gives every service a tier and a reason in plain words", () => {
    for (const d of CATALOG) {
      const t = tierOf(d);
      expect(["critical", "must", "optional"], d.key).toContain(t.tier);
      expect(t.why.length, d.key).toBeGreaterThan(15);
      expect(t.why, d.key).not.toMatch(/API|webhook|token|—/);
    }
    expect(tierOf(defOf("stripe")!).why).toBe("Without this, nobody can pay.");
    expect(tierOf(defOf("google")!).why).toBe("Needed for clients to log in with Google.");
  });

  it("lets a definition set its own tier, and gives new definitions a default by kind", () => {
    const base: ConnDef = { key: "newthing", title: "New thing", summary: "s", group: "clients", editable: true, fields: [], guide: [], usedBy: [] };
    expect(tierOf(base).tier).toBe("optional");
    expect(tierOf({ ...base, tier: "must" })).toEqual({ tier: "must", why: "A main feature depends on this." });
    expect(tierOf({ ...base, tier: "critical" }).tier).toBe("critical");
    // A built-in whose definition is given another tier follows the definition.
    expect(tierOf({ ...defOf("square")!, tier: "must" }).tier).toBe("must");
    expect(tierOf({ ...base, group: "platform" }).why).toMatch(/works without it/);
  });

  it("says how each service is connected", () => {
    expect(modeOf(defOf("facebook")!)).toBe("editable");
    expect(modeOf(defOf("stripe")!)).toBe("server");
    expect(modeOf(defOf("tiktok")!)).toBe("approval");
    expect(modeOf(defOf("canva")!)).toBe("manual");
    expect(modeOf(defOf("envato")!)).toBe("manual");
    const base: ConnDef = { key: "newthing", title: "New thing (needs approval)", summary: "s", group: "platform", editable: false, fields: [], guide: [], usedBy: [] };
    expect(modeOf(base)).toBe("approval");
    expect(modeOf({ ...base, title: "New thing (used by hand)" })).toBe("manual");
    expect(modeOf({ ...base, title: "New thing" })).toBe("server");
  });
});

describe("Connections page: managing a saved service", () => {
  it("sends the tier, the reason and how it is connected with every service", async () => {
    const { call } = setup({ env: { ANTHROPIC_API_KEY: "sk-ant-secret-123456" } });
    const all = ((await call("GET", "/api/owner/connections")).body as any).connections as any[];
    for (const c of all) { expect(["critical", "must", "optional"]).toContain(c.tier); expect(c.tierWhy).toBeTruthy(); expect(["editable", "server", "approval", "manual"]).toContain(c.mode); }
    const by = (k: string) => all.find((c) => c.key === k);
    expect(by("stripe")).toMatchObject({ tier: "critical", mode: "server", status: "not_connected" });
    expect(by("anthropic")).toMatchObject({ tier: "critical", mode: "server", status: "connected" });
    expect(by("tiktok")).toMatchObject({ mode: "approval", editable: false });
    expect(by("canva")).toMatchObject({ mode: "manual", editable: false });
    expect(by("google")).toMatchObject({ tier: "must", mode: "editable" });
  });

  it("shows a service set by server settings as set on the server", async () => {
    const { card } = setup({ env: { GOOGLE_CLIENT_ID: "abcde-1.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "server-secret-123" } });
    expect(await card("google")).toMatchObject({ mode: "server", editable: false, status: "connected" });
  });

  it("records when each detail was last changed, and never returns the secret", async () => {
    const { call, card, later } = setup();
    const t0 = start.toISOString();
    const save = await call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN, pageId: "1000001" } });
    expect(save.status).toBe(200);
    expect(JSON.stringify(save.body)).not.toContain(TOKEN);
    const a = await card("facebook");
    expect(a.changedAt).toBe(t0);
    expect(a.fields.find((f: any) => f.key === "accessToken")).toMatchObject({ set: true, changedAt: t0 });
    expect(a.fields.find((f: any) => f.key === "accessToken").value).toBeUndefined();
    expect(a.fields.find((f: any) => f.key === "appSecret").changedAt).toBeUndefined();

    // Change one detail: the others are kept as they were, with their own times.
    const t1 = later(10);
    expect((await call("PUT", "/api/owner/connections/facebook", { fields: { pageId: "1000002" } })).status).toBe(200);
    const b = await card("facebook");
    expect(b.status).toBe("connected");
    expect(b.fields.find((f: any) => f.key === "pageId")).toMatchObject({ value: "1000002", changedAt: t1 });
    expect(b.fields.find((f: any) => f.key === "accessToken")).toMatchObject({ set: true, changedAt: t0 });
    expect(b.changedAt).toBe(t1);

    // Saving the same value again is not a change.
    later(10);
    await call("PUT", "/api/owner/connections/facebook", { fields: { pageId: "1000002" } });
    expect((await card("facebook")).fields.find((f: any) => f.key === "pageId").changedAt).toBe(t1);
  });

  it("forgets the times and the test result when the service is disconnected", async () => {
    const { call, card, later } = setup();
    await call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN, pageId: "1000001" } });
    later(1);
    await call("POST", "/api/owner/connections/facebook/test");
    expect((await card("facebook")).lastTest.ok).toBe(true);
    const r = await call("POST", "/api/owner/connections/facebook/disconnect");
    expect(r.status).toBe(200);
    const c = await card("facebook");
    expect(c).toMatchObject({ status: "not_connected", source: "none" });
    expect(c.lastTest).toBeUndefined();
    expect(c.changedAt).toBeUndefined();
    expect(c.fields.every((f: any) => !f.set && !f.changedAt)).toBe(true);
  });

  it("refuses to disconnect for anyone but the owner, and for services that are not kept here", async () => {
    const { call, stranger } = setup({ env: { ANTHROPIC_API_KEY: "sk-ant-secret-123456" } });
    expect((await call("POST", "/api/owner/connections/facebook/disconnect", undefined, stranger)).status).toBe(403);
    expect((await call("POST", "/api/owner/connections/anthropic/disconnect")).status).toBe(400);
    expect((await call("POST", "/api/owner/connections/tiktok/disconnect")).status).toBe(400);
    expect((await call("POST", "/api/owner/connections/nothing/disconnect")).status).toBe(400);
  });

  it("keeps the last test result and the changed times across a restart, without any secret in them", async () => {
    const writes: [string, string][] = [];
    const a = setup({ answer: (url) => (url.includes("1000001") ? { status: 400, json: { error: { message: "Error validating access token: Session has expired", code: 190 } } } : { json: {} }) });
    await a.platform.attachStore(fakeStore(writes));
    await a.call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN, pageId: "1000001" } });
    const at = a.later(5);
    await a.call("POST", "/api/owner/connections/facebook/test");
    expect((await a.card("facebook")).status).toBe("error");
    const meta = writes.filter((w) => w[0] === META_STORE_KEY).at(-1)![1];
    expect(meta).not.toContain(TOKEN);

    const b = setup();
    await b.platform.attachStore(fakeStore([], latest(writes)));
    const c = await b.card("facebook");
    expect(c.status).toBe("error");
    expect(c.lastTest).toMatchObject({ ok: false, at });
    expect(c.lastTest.message).toMatch(/expired/i);
    expect(c.fields.find((f: any) => f.key === "accessToken").changedAt).toBe(start.toISOString());
    expect(JSON.stringify(c)).not.toContain(TOKEN);
  });

  it("keeps the last test of a server-set service across a restart too", async () => {
    const writes: [string, string][] = [];
    const env = { ANTHROPIC_API_KEY: "sk-ant-secret-123456" };
    const a = setup({ env });
    await a.platform.attachStore(fakeStore(writes));
    await a.call("POST", "/api/owner/connections/anthropic/test");
    const b = setup({ env });
    await b.platform.attachStore(fakeStore([], latest(writes)));
    expect((await b.card("anthropic")).lastTest).toMatchObject({ ok: true, message: "Claude accepted the key." });
  });

  it("drops anything in a stored record that it does not recognise", () => {
    const fieldsOf = (k: string) => (k === "facebook" ? ["accessToken", "pageId"] : undefined);
    const bad = JSON.stringify({
      changed: { facebook: { accessToken: "2026-11-20T09:00:00.000Z", pageId: "not a date", other: "2026-11-20T09:00:00.000Z" }, gone: { a: "2026-11-20T09:00:00.000Z" }, __proto__: { x: "y" } },
      tests: { facebook: { ok: "yes", message: "m", at: "2026-11-20T09:00:00.000Z" }, gone: { ok: true, message: "m", details: [], at: "2026-11-20T09:00:00.000Z" } },
    });
    expect(unpackMeta(bad, fieldsOf)).toEqual({ changed: { facebook: { accessToken: "2026-11-20T09:00:00.000Z" } }, tests: {} });
    expect(unpackMeta("not json", fieldsOf)).toEqual({ changed: {}, tests: {} });
    expect(unpackMeta("[1]", fieldsOf)).toEqual({ changed: {}, tests: {} });
    const long = JSON.stringify({ tests: { facebook: { ok: false, message: "x".repeat(5000), details: Array(50).fill("d"), at: "2026-11-20T09:00:00.000Z" } } });
    const t = unpackMeta(long, fieldsOf).tests.facebook!;
    expect(t.message.length).toBe(600);
    expect(t.details.length).toBe(8);
  });

  it("limits how often a service can be disconnected from one address", () => {
    expect(limitFor("POST", "/api/owner/connections/facebook/disconnect")).toEqual({ max: 30, windowMs: 10 * 60_000 });
  });
});
