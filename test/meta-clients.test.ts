import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp, makeToken, readToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { metaClientEnvProblems, metaClientsFromEnv } from "../src/server/config.js";
import { META_PERMISSIONS, makeSignedRequest, parseSignedRequest } from "../src/modules/meta-clients/index.js";

const OWNER = "atif@maiz.test";
const APP_SECRET = "meta-app-secret-for-tests";
const VERIFY = "0123456789abcdef-verify";
const T0 = new Date("2026-11-20T09:00:00Z");

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
type Answer = { status?: number; json?: unknown } | "drop";

function setup(opts: { live?: boolean; graph?: (c: Call) => Answer } = {}) {
  const clock = { d: new Date(T0) };
  const calls: Call[] = [];
  const http = (async (url: any, init: any = {}) => {
    const c: Call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: String(init.body ?? "") };
    calls.push(c);
    const a = opts.graph?.(c) ?? { json: {} };
    if (a === "drop") throw new Error("network down");
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  }) as typeof fetch;
  const metaClients = { mode: opts.live ? ("live" as const) : ("sandbox" as const), appId: "1234567890", appSecret: APP_SECRET, verifyToken: VERIFY, loginConfigId: "555", template: { name: "maiz_client_approval", language: "en_GB" } };
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d, http, metaClients });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, query = "") =>
    handle({ method, path, query: new URLSearchParams(query), headers, rawBody: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body) } as Req);
  const auth = (email: string) => ({ authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(email), e: email }, 7 * 86400, clock.d.getTime())}` });
  const signUp = async (email: string, name: string) => {
    const r = await call("POST", "/api/signup", { email, businessName: name, sells: "Bread", size: "2–10", country: "GB", goal: "More customers" });
    expect(r.status).toBe(201);
    const uid = userIdFor(email);
    return { email, uid, ws: platform.identity.workspacesFor(uid)[0]!.id, h: { authorization: `Bearer ${(r.body as any).token}` } };
  };
  return { platform, call, clock, calls, auth, signUp, svc: platform.metaClients };
}
type S = ReturnType<typeof setup>;
type Biz = Awaited<ReturnType<S["signUp"]>>;

/** Runs the real browser steps in sandbox: Connect, Meta window, callback, choose. */
async function connect(s: S, b: Biz, kind: "facebook" | "instagram", pick = 0) {
  const start = await s.call("POST", "/api/meta/connect", { kind }, b.h);
  expect(start.status).toBe(200);
  const url = new URL((start.body as any).url);
  const state = url.searchParams.get("state")!;
  const nonce = /maiz_meta=([^;]+)/.exec(start.headers!["set-cookie"]!)![1]!;
  const cb = await s.call("GET", "/api/meta/callback", undefined, { cookie: `maiz_meta=${nonce}` }, `code=sandbox-${kind}-${b.uid}&state=${encodeURIComponent(state)}`);
  expect(cb.status).toBe(302);
  const pendingId = /#pending=([0-9a-f]+)/.exec(cb.headers!.location!)![1]!;
  const done = await s.call("POST", "/api/meta/choose", { pendingId, index: pick }, b.h);
  expect(done.status).toBe(201);
  return (done.body as any).connection;
}

describe("sandbox connect flow", () => {
  it("connects a Page end to end in sandbox, with no token in any reply", async () => {
    const s = setup();
    const b = await s.signUp("ann@bakery.test", "Sunrise Bakery");
    const info = await s.call("GET", "/api/meta", undefined, b.h);
    expect((info.body as any).mode).toBe("sandbox");
    expect((info.body as any).kinds.facebook.map((x: any) => x.key)).toContain("pages_manage_posts");
    const conn = await connect(s, b, "facebook");
    expect(conn.status).toBe("connected");
    expect(conn.mode).toBe("sandbox");
    const all = JSON.stringify((await s.call("GET", "/api/meta", undefined, b.h)).body);
    expect(all).not.toMatch(/sandbox-token|accessToken|metaUserId/);
    expect(s.calls).toHaveLength(0); // nothing left the server
  });
  it("refuses a callback replayed, from another browser, or with a forged state", async () => {
    const s = setup();
    const b = await s.signUp("ann@bakery.test", "Sunrise Bakery");
    const start = await s.call("POST", "/api/meta/connect", { kind: "facebook" }, b.h);
    const state = new URL((start.body as any).url).searchParams.get("state")!;
    const nonce = /maiz_meta=([^;]+)/.exec(start.headers!["set-cookie"]!)![1]!;
    const q = `code=sandbox-1&state=${encodeURIComponent(state)}`;
    expect((await s.call("GET", "/api/meta/callback", undefined, { cookie: "maiz_meta=other" }, q)).status).toBe(400);
    expect((await s.call("GET", "/api/meta/callback", undefined, { cookie: `maiz_meta=${nonce}` }, "code=sandbox-1&state=forged")).status).toBe(400);
    expect((await s.call("GET", "/api/meta/callback", undefined, { cookie: `maiz_meta=${nonce}` }, q)).status).toBe(302);
    expect((await s.call("GET", "/api/meta/callback", undefined, { cookie: `maiz_meta=${nonce}` }, q)).status).toBe(400);
  });
  it("lets only the person who started the choice finish it", async () => {
    const s = setup();
    const a = await s.signUp("ann@bakery.test", "Sunrise Bakery");
    const c = await s.signUp("cy@cafe.test", "Cafe Cy");
    const start = await s.call("POST", "/api/meta/connect", { kind: "facebook" }, a.h);
    const state = new URL((start.body as any).url).searchParams.get("state")!;
    const nonce = /maiz_meta=([^;]+)/.exec(start.headers!["set-cookie"]!)![1]!;
    const cb = await s.call("GET", "/api/meta/callback", undefined, { cookie: `maiz_meta=${nonce}` }, `code=sandbox-1&state=${encodeURIComponent(state)}`);
    const pendingId = /#pending=([0-9a-f]+)/.exec(cb.headers!.location!)![1]!;
    expect((await s.call("POST", "/api/meta/choose", { pendingId, index: 0 }, c.h)).status).toBe(400);
    expect((await s.call("POST", "/api/meta/choose", { pendingId, index: 0 }, a.h)).status).toBe(201);
  });
});

describe("posting with the approval gate", () => {
  it("posts nothing until a person approves, then posts once", async () => {
    const s = setup();
    const b = await s.signUp("ann@bakery.test", "Sunrise Bakery");
    const conn = await connect(s, b, "facebook");
    const d = await s.call("POST", "/api/meta/posts", { connectionId: conn.id, text: "Fresh sourdough today" }, b.h);
    const post = (d.body as any).post;
    expect(post.status).toBe("awaiting_approval");
    await s.svc.maintenance();
    expect(s.svc.listPosts(b.uid, b.ws)[0]!.status).toBe("awaiting_approval");
    const ok = await s.call("POST", `/api/meta/posts/${post.id}/approve`, {}, b.h);
    expect((ok.body as any).post.status).toBe("posted");
    expect((ok.body as any).post.simulated).toBe(true);
    expect((await s.call("POST", `/api/meta/posts/${post.id}/approve`, {}, b.h)).status).toBe(400);
  });
  it("checks Instagram posts need a picture and https links", async () => {
    const s = setup();
    const b = await s.signUp("ann@bakery.test", "Sunrise Bakery");
    const ig = await connect(s, b, "instagram");
    expect((await s.call("POST", "/api/meta/posts", { connectionId: ig.id, text: "hi" }, b.h)).status).toBe(400);
    expect((await s.call("POST", "/api/meta/posts", { connectionId: ig.id, text: "hi", imageUrl: "http://x.test/a.jpg" }, b.h)).status).toBe(400);
    expect((await s.call("POST", "/api/meta/posts", { connectionId: ig.id, text: "hi", imageUrl: "https://x.test/a.jpg" }, b.h)).status).toBe(201);
  });
  it("holds a scheduled post until it is due", async () => {
    const s = setup();
    const b = await s.signUp("ann@bakery.test", "Sunrise Bakery");
    const conn = await connect(s, b, "facebook");
    const at = new Date(T0.getTime() + 2 * 3600_000).toISOString();
    const p = (await s.call("POST", "/api/meta/posts", { connectionId: conn.id, text: "Later", scheduledFor: at }, b.h)).body as any;
    await s.call("POST", `/api/meta/posts/${p.post.id}/approve`, {}, b.h);
    expect(s.svc.listPosts(b.uid, b.ws)[0]!.status).toBe("approved");
    s.clock.d = new Date(T0.getTime() + 3 * 3600_000);
    await s.svc.maintenance();
    expect(s.svc.listPosts(b.uid, b.ws)[0]!.status).toBe("posted");
  });
  it("stops at the per-client daily limit, and only the owner can change it", async () => {
    const s = setup();
    const b = await s.signUp("ann@bakery.test", "Sunrise Bakery");
    const conn = await connect(s, b, "facebook");
    const owner = s.auth(OWNER);
    expect((await s.call("POST", `/api/owner/meta/clients/${b.ws}/limits`, { postsPerDay: 1 }, b.h)).status).toBe(403);
    expect((await s.call("POST", `/api/owner/meta/clients/${b.ws}/limits`, { postsPerDay: 999 }, owner)).status).toBe(400);
    expect((await s.call("POST", `/api/owner/meta/clients/${b.ws}/limits`, { postsPerDay: 1 }, owner)).status).toBe(200);
    const mk = async (t: string) => ((await s.call("POST", "/api/meta/posts", { connectionId: conn.id, text: t }, b.h)).body as any).post.id;
    const one = await mk("one"), two = await mk("two");
    expect((await s.call("POST", `/api/meta/posts/${one}/approve`, {}, b.h)).status).toBe(200);
    const refused = await s.call("POST", `/api/meta/posts/${two}/approve`, {}, b.h);
    expect(refused.status).toBe(400);
    expect((refused.body as any).error).toMatch(/daily limit/);
    expect(s.svc.listPosts(b.uid, b.ws).find((p) => p.id === two)!.status).toBe("awaiting_approval");
  });
  it("keeps each business's accounts and posts to itself", async () => {
    const s = setup();
    const a = await s.signUp("ann@bakery.test", "Sunrise Bakery");
    const c = await s.signUp("cy@cafe.test", "Cafe Cy");
    const conn = await connect(s, a, "facebook");
    const p = ((await s.call("POST", "/api/meta/posts", { connectionId: conn.id, text: "Mine" }, a.h)).body as any).post;
    expect(((await s.call("GET", "/api/meta", undefined, c.h)).body as any).connections).toHaveLength(0);
    expect(((await s.call("GET", "/api/meta/posts", undefined, c.h)).body as any).posts).toHaveLength(0);
    expect((await s.call("POST", `/api/meta/posts/${p.id}/approve`, {}, c.h)).status).toBe(400);
    expect((await s.call("POST", "/api/meta/posts", { connectionId: conn.id, text: "Not yours" }, c.h)).status).toBe(400);
    expect((await s.call("DELETE", `/api/meta/connections/${conn.id}`, undefined, c.h)).status).toBe(400);
  });
  it("cancels waiting posts and drops the token when disconnected", async () => {
    const s = setup();
    const b = await s.signUp("ann@bakery.test", "Sunrise Bakery");
    const conn = await connect(s, b, "facebook");
    const p = ((await s.call("POST", "/api/meta/posts", { connectionId: conn.id, text: "Waiting" }, b.h)).body as any).post;
    expect((await s.call("DELETE", `/api/meta/connections/${conn.id}`, undefined, b.h)).status).toBe(200);
    expect(s.svc.listPosts(b.uid, b.ws).find((x) => x.id === p.id)!.status).toBe("cancelled");
    expect(((await s.call("GET", "/api/meta", undefined, b.h)).body as any).connections).toHaveLength(0);
  });
});

describe("live provider (fake Graph API)", () => {
  const graph = (over: (c: Call) => Answer | undefined = () => undefined) => (c: Call): Answer => {
    const o = over(c);
    if (o) return o;
    if (c.url.includes("/oauth/access_token")) return { json: { access_token: "USERTOKEN" } };
    if (c.url.includes("/debug_token")) return { json: { data: { is_valid: true, scopes: [], expires_at: 0 } } };
    if (c.url.includes("/me/permissions")) return { json: { data: [{ permission: "pages_show_list", status: "granted" }, { permission: "pages_manage_posts", status: "granted" }] } };
    if (c.url.includes("/me/accounts")) return { json: { data: [{ id: "100001", name: "Sunrise", access_token: "PAGETOKEN", instagram_business_account: { id: "200002", username: "sunrise" } }] } };
    if (c.url.includes("/me?")) return { json: { id: "777000111", name: "Ann" } };
    if (c.url.endsWith("/feed")) return { json: { id: "100001_55" } };
    return { json: {} };
  };
  async function liveConnected(over?: (c: Call) => Answer | undefined) {
    const s = setup({ live: true, graph: graph(over) });
    const b = await s.signUp("ann@bakery.test", "Sunrise Bakery");
    const r = await s.svc.completeLogin(b.uid, b.ws, "facebook", "AUTHCODE", "https://app.test/api/meta/callback");
    const conn = await s.svc.choose(b.uid, b.ws, r.pendingId, 0);
    return { s, b, conn, r };
  }
  it("sends the login to Facebook with the configuration id, and flags permissions not granted", async () => {
    const { s, b, r } = await liveConnected();
    const url = new URL(s.svc.authorizeUrl(b.uid, b.ws, "facebook", "st", "https://app.test/api/meta/callback"));
    expect(url.hostname).toBe("www.facebook.com");
    expect(url.searchParams.get("config_id")).toBe("555");
    expect(r.missing.map((m) => m.key)).toContain("pages_read_engagement");
    expect(s.calls.some((c) => c.url.includes("USERTOKEN") || c.url.includes("PAGETOKEN"))).toBe(false); // never in an address
  });
  it("posts with the Page token in a header and signs with appsecret_proof", async () => {
    const { s, b, conn } = await liveConnected();
    const p = await s.svc.draft(b.uid, b.ws, { connectionId: conn.id, text: "Hello" });
    const done = await s.svc.decide(b.uid, b.ws, p.id, "approve");
    expect(done.status).toBe("posted");
    const post = s.calls.find((c) => c.url.endsWith("/100001/feed"))!;
    expect(post.headers.authorization).toBe("Bearer PAGETOKEN");
    expect(post.url + post.body).not.toContain("PAGETOKEN");
    expect(post.body).toContain(`appsecret_proof=${createHmac("sha256", APP_SECRET).update("PAGETOKEN").digest("hex")}`);
  });
  it("backs off when Meta rate-limits, keeps the post, and posts later", async () => {
    let limited = true;
    const { s, b, conn } = await liveConnected((c) => (c.url.endsWith("/feed") && limited ? { status: 400, json: { error: { code: 80001, message: "Too many calls" } } } : undefined));
    const p = await s.svc.draft(b.uid, b.ws, { connectionId: conn.id, text: "Hello" });
    const first = await s.svc.decide(b.uid, b.ws, p.id, "approve");
    expect(first.status).toBe("retry_wait");
    expect(first.retryAt).toBeTruthy();
    const feeds = () => s.calls.filter((c) => c.url.endsWith("/feed")).length;
    await s.svc.maintenance();
    expect(feeds()).toBe(1); // not hammering Meta before the wait is over
    limited = false;
    s.clock.d = new Date(first.retryAt!);
    await s.svc.maintenance();
    expect(s.svc.listPosts(b.uid, b.ws)[0]!.status).toBe("posted");
  });
  it("marks the account as needing reconnection when Meta says the token is dead", async () => {
    const { s, b, conn } = await liveConnected((c) => (c.url.endsWith("/feed") ? { status: 400, json: { error: { code: 190, message: "Error validating access token" } } } : undefined));
    const p = await s.svc.draft(b.uid, b.ws, { connectionId: conn.id, text: "Hello" });
    const out = await s.svc.decide(b.uid, b.ws, p.id, "approve");
    expect(out.status).toBe("failed");
    expect(s.svc.list(b.uid, b.ws)[0]!.status).toBe("needs_reconnect");
    await expect(s.svc.draft(b.uid, b.ws, { connectionId: conn.id, text: "Again" })).rejects.toThrow(/reconnected/);
  });
  it("never retries a post whose outcome is unknown (it could post twice)", async () => {
    const { s, b, conn } = await liveConnected((c) => (c.url.endsWith("/feed") ? { status: 503 } : undefined));
    const p = await s.svc.draft(b.uid, b.ws, { connectionId: conn.id, text: "Hello" });
    expect((await s.svc.decide(b.uid, b.ws, p.id, "approve")).status).toBe("failed");
    await s.svc.maintenance();
    expect(s.calls.filter((c) => c.url.endsWith("/feed"))).toHaveLength(1);
  });
  it("finds expired tokens in the twice-daily health check", async () => {
    let valid = true;
    const { s, b } = await liveConnected((c) => (c.url.includes("/debug_token") ? { json: { data: { is_valid: valid, scopes: [], expires_at: 0, data_access_expires_at: Math.floor(T0.getTime() / 1000) + 90 * 86400 } } } : undefined));
    await s.svc.maintenance();
    expect(s.svc.list(b.uid, b.ws)[0]!.status).toBe("connected");
    valid = false;
    s.clock.d = new Date(T0.getTime() + 13 * 3600_000);
    await s.svc.maintenance();
    expect(s.svc.list(b.uid, b.ws)[0]!.status).toBe("needs_reconnect");
  });
});

describe("Meta's deauthorize and data deletion callbacks", () => {
  async function withConnection() {
    const s = setup();
    const b = await s.signUp("ann@bakery.test", "Sunrise Bakery");
    const conn = await connect(s, b, "facebook");
    const meta = (s.svc as any).conns.get(conn.id).metaUserId as string;
    const post = ((await s.call("POST", "/api/meta/posts", { connectionId: conn.id, text: "x" }, b.h)).body as any).post;
    return { s, b, conn, meta, post };
  }
  const form = (signed: string) => `signed_request=${encodeURIComponent(signed)}`;
  it("verifies signatures", () => {
    const sr = makeSignedRequest({ user_id: "123" }, APP_SECRET);
    expect(parseSignedRequest(sr, APP_SECRET)?.user_id).toBe("123");
    expect(parseSignedRequest(sr, "other")).toBeUndefined();
    expect(parseSignedRequest(sr.replace(/^./, "x"), APP_SECRET)).toBeUndefined();
    expect(parseSignedRequest("a.b.c", APP_SECRET)).toBeUndefined();
    expect(parseSignedRequest(undefined, APP_SECRET)).toBeUndefined();
  });
  it("deauthorize disconnects that person's accounts and cancels their waiting posts", async () => {
    const { s, b, meta, post } = await withConnection();
    expect((await s.call("POST", "/api/meta/deauthorize", form("bad.bad"))).status).toBe(400);
    expect((await s.call("POST", "/api/meta/deauthorize", form(makeSignedRequest({ user_id: meta }, APP_SECRET)))).status).toBe(200);
    expect(s.svc.list(b.uid, b.ws)).toHaveLength(0);
    expect(s.svc.listPosts(b.uid, b.ws).find((p) => p.id === post.id)!.status).toBe("cancelled");
  });
  it("data deletion erases the records and returns a code Meta can show the person", async () => {
    const { s, b, meta } = await withConnection();
    const other = await s.signUp("cy@cafe.test", "Cafe Cy");
    const otherConn = await connect(s, other, "facebook");
    const res = await s.call("POST", "/api/meta/data-deletion", form(makeSignedRequest({ user_id: meta }, APP_SECRET)));
    expect(res.status).toBe(200);
    const { url, confirmation_code } = res.body as any;
    expect(url).toBe(`https://app.test/data-deletion.html?code=${confirmation_code}`);
    expect(s.svc.list(b.uid, b.ws)).toHaveLength(0);
    expect(s.svc.listPosts(b.uid, b.ws)).toHaveLength(0);
    expect(JSON.stringify([...(s.svc as any).conns.values()])).not.toContain(meta);
    expect(s.svc.list(other.uid, other.ws).map((c: any) => c.id)).toEqual([otherConn.id]); // other business untouched
    const status = (await s.call("GET", "/api/meta/deletion-status", undefined, {}, `code=${confirmation_code}`)).body as any;
    expect(status.found).toBe(true);
    expect(status.removed.connections).toBe(1);
    expect(((await s.call("GET", "/api/meta/deletion-status", undefined, {}, "code=nope")).body as any).found).toBe(false);
  });
  it("lets a client delete their own Meta data from the dashboard", async () => {
    const { s, b } = await withConnection();
    const r = await s.call("POST", "/api/meta/delete-data", {}, b.h);
    expect(r.status).toBe(200);
    expect(s.svc.list(b.uid, b.ws)).toHaveLength(0);
  });
});

describe("WhatsApp approvals for a client", () => {
  async function ready() {
    const s = setup();
    const b = await s.signUp("ann@bakery.test", "Sunrise Bakery");
    const fb = await connect(s, b, "facebook");
    const wa = await s.call("POST", "/api/meta/whatsapp", { code: "sandbox-wa", wabaId: "sandbox-waba", phoneNumberId: "sandbox-phone", approverNumber: "+44 7700 900123" }, b.h);
    expect(wa.status).toBe(201);
    const reply = async (text: string) => (await s.call("POST", "/api/meta/sandbox/whatsapp-reply", { text }, b.h)).body as any;
    return { s, b, fb, wa: (wa.body as any).connection, reply };
  }
  const outbox = (s: S, b: Biz) => s.svc.sandboxOutbox(b.uid, b.ws);
  it("masks the approver number and does not obey it until confirmed", async () => {
    const { s, b, fb, wa, reply } = await ready();
    expect(wa.approverNumber).toBe("••••0123");
    expect(wa.approverConfirmed).toBe(false);
    const p = ((await s.call("POST", "/api/meta/posts", { connectionId: fb.id, text: "Hi" }, b.h)).body as any).post;
    await reply(`yes ${p.code}`);
    expect(s.svc.listPosts(b.uid, b.ws)[0]!.status).toBe("awaiting_approval");
    const code = /CONFIRM (\d{6})/.exec(outbox(s, b)[0]!.text)![1];
    await reply("confirm 000000");
    expect(s.svc.list(b.uid, b.ws).find((c: any) => c.kind === "whatsapp")!.approverConfirmed).toBe(false);
    await reply(`confirm ${code}`);
    expect(s.svc.list(b.uid, b.ws).find((c: any) => c.kind === "whatsapp")!.approverConfirmed).toBe(true);
  });
  it("tells the approver about a new draft and posts when they reply yes with its code", async () => {
    const { s, b, fb, reply } = await ready();
    await reply(`confirm ${/CONFIRM (\d{6})/.exec(outbox(s, b)[0]!.text)![1]}`);
    const p = ((await s.call("POST", "/api/meta/posts", { connectionId: fb.id, text: "Fresh bread" }, b.h)).body as any).post;
    const msg = outbox(s, b).find((m) => m.text.includes("Fresh bread"))!;
    expect(msg.text).toContain(`YES ${p.code}`);
    await reply("hello?");
    expect(s.svc.listPosts(b.uid, b.ws)[0]!.status).toBe("awaiting_approval");
    await reply(`YES ${p.code}`);
    const done = s.svc.listPosts(b.uid, b.ws)[0]!;
    expect(done.status).toBe("posted");
    expect(done.decidedVia).toBe("whatsapp");
  });
  it("asks which post when several wait, and a No skips without posting", async () => {
    const { s, b, fb, reply } = await ready();
    await reply(`confirm ${/CONFIRM (\d{6})/.exec(outbox(s, b)[0]!.text)![1]}`);
    const mk = async (t: string) => ((await s.call("POST", "/api/meta/posts", { connectionId: fb.id, text: t }, b.h)).body as any).post;
    const one = await mk("one"), two = await mk("two");
    await reply("yes");
    expect(s.svc.listPosts(b.uid, b.ws).every((p) => p.status === "awaiting_approval")).toBe(true);
    await reply(`no ${two.code}`);
    expect(s.svc.listPosts(b.uid, b.ws).find((p) => p.id === two.id)!.status).toBe("rejected");
    expect(s.svc.listPosts(b.uid, b.ws).find((p) => p.id === one.id)!.status).toBe("awaiting_approval");
  });
  it("ignores messages from any other number", async () => {
    const { s, b, fb } = await ready();
    const p = ((await s.call("POST", "/api/meta/posts", { connectionId: fb.id, text: "Hi" }, b.h)).body as any).post;
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "sandbox-phone" }, messages: [{ id: "m1", from: "447700900999", type: "text", text: { body: `yes ${p.code}` } }] } }] }] });
    const n = await s.svc.handleWhatsApp(JSON.parse(raw));
    expect(n).toBe(0);
    expect(s.svc.listPosts(b.uid, b.ws)[0]!.status).toBe("awaiting_approval");
  });
});

describe("the Meta webhook", () => {
  it("answers the handshake only with the verify token and rejects bad signatures", async () => {
    const s = setup();
    expect((await s.call("GET", "/api/meta/webhook", undefined, {}, `hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=4242`)).text).toBe("4242");
    expect((await s.call("GET", "/api/meta/webhook", undefined, {}, "hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1")).status).toBe(403);
    const raw = JSON.stringify({ entry: [] });
    expect((await s.call("POST", "/api/meta/webhook", raw)).status).toBe(401);
    expect((await s.call("POST", "/api/meta/webhook", raw, { "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}` })).status).toBe(200);
  });
});

describe("owner's status view", () => {
  it("is for the platform owner only and shows approved versus pending per permission", async () => {
    const s = setup();
    const b = await s.signUp("ann@bakery.test", "Sunrise Bakery");
    expect((await s.call("GET", "/api/owner/meta", undefined, b.h)).status).toBe(403);
    const owner = s.auth(OWNER);
    const first = (await s.call("GET", "/api/owner/meta", undefined, owner)).body as any;
    expect(first.permissions).toHaveLength(META_PERMISSIONS.length);
    expect(first.permissions.every((p: any) => p.state === "not_submitted")).toBe(true);
    expect(first.mode).toBe("sandbox");
    expect(first.urls.dataDeletionCallback).toBe("https://app.test/api/meta/data-deletion");
    expect(first.readiness.find((r: any) => r.key === "live").ok).toBe(false);
    expect(first.readiness.find((r: any) => r.key === "privacy_page").how).toBe("fetched");
    expect((await s.call("POST", "/api/owner/meta/permissions", { key: "pages_manage_posts", state: "approved" }, b.h)).status).toBe(403);
    expect((await s.call("POST", "/api/owner/meta/permissions", { key: "made_up", state: "approved" }, owner)).status).toBe(400);
    expect((await s.call("POST", "/api/owner/meta/permissions", { key: "pages_manage_posts", state: "in_review", note: "Submitted 14 Nov" }, owner)).status).toBe(200);
    const after = (await s.call("GET", "/api/owner/meta", undefined, owner)).body as any;
    expect(after.permissions.find((p: any) => p.key === "pages_manage_posts")).toMatchObject({ state: "in_review", note: "Submitted 14 Nov" });
  });
});

describe("configuration", () => {
  it("defaults to sandbox and only goes live when asked and fully configured", () => {
    expect(metaClientsFromEnv({}).mode).toBe("sandbox");
    expect(metaClientsFromEnv({ META_MODE: "live" }).mode).toBe("sandbox");
    expect(metaClientsFromEnv({ META_MODE: "live", META_APP_ID: "123456", META_APP_SECRET: "s" }).mode).toBe("live");
    expect(metaClientEnvProblems({ META_MODE: "live", APP_URL: "http://x" }).join(" ")).toMatch(/META_APP_ID.*META_APP_SECRET.*META_WEBHOOK_VERIFY_TOKEN.*https/s);
    expect(metaClientEnvProblems({ META_MODE: "banana" })[0]).toMatch(/sandbox or live/);
  });
  it("keeps the permission list in step with what each screen asks for", () => {
    for (const p of META_PERMISSIONS) {
      expect(p.plain.length).toBeGreaterThan(10);
      expect(p.justification.length).toBeGreaterThan(80);
      expect(p.screencast.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("App Review pack", () => {
  it("docs/META-APP-REVIEW.md is up to date with the permission list (run npm run docs:meta)", async () => {
    const { readFileSync } = await import("node:fs");
    const { metaReviewDoc } = await import("../src/modules/meta-clients/review-doc.js");
    expect(readFileSync(new URL("../docs/META-APP-REVIEW.md", import.meta.url), "utf8")).toBe(metaReviewDoc());
  });
});
