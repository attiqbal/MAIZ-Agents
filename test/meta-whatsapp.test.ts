import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { checkEnv, metaEnvProblems, metaFromEnv, whatsappFromEnv } from "../src/server/config.js";
import { MetaGraph, MetaRejected, MetaUncertain, publishProblems } from "../src/modules/meta/index.js";
import { WhatsAppCloud, normalizeNumber } from "../src/modules/whatsapp/index.js";

const OWNER = "atif@maiz.test";
const OWNER_NUMBER = "447700900123";
const APP_SECRET = "app-secret-for-tests";
const TOKEN = "EAAtesttoken123";
const now = new Date("2026-11-20T09:00:00Z");

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
function fakeHttp(answer: (c: Call) => { status?: number; json?: unknown } | "drop") {
  const calls: Call[] = [];
  const http = (async (url: any, init: any = {}) => {
    const c: Call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: String(init.body ?? "") };
    calls.push(c);
    const a = answer(c);
    if (a === "drop") throw new Error("network down");
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { http, calls };
}

describe("Meta Graph client", () => {
  it("puts the token in a header, never in the URL, and signs with appsecret_proof", async () => {
    const { http, calls } = fakeHttp(() => ({ json: { id: "123_456" } }));
    const g = new MetaGraph({ accessToken: TOKEN, pageId: "1000001", appSecret: APP_SECRET }, http);
    const out = await g.publish({ target: "facebook", message: "Hello", linkUrl: "https://examutor.com/" });
    expect(out.url).toBe("https://www.facebook.com/123_456");
    expect(calls[0]!.url).toContain("/1000001/feed");
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(calls[0]!.body).not.toContain(TOKEN);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body).toContain(`appsecret_proof=${createHmac("sha256", APP_SECRET).update(TOKEN).digest("hex")}`);
  });
  it("schedules Facebook posts as unpublished with a future time", async () => {
    const { http, calls } = fakeHttp(() => ({ json: { id: "1_2" } }));
    const at = new Date(now.getTime() + 3_600_000);
    const out = await new MetaGraph({ accessToken: TOKEN, pageId: "1000001" }, http).publish({ target: "facebook", message: "Later", scheduleAt: at });
    expect(calls[0]!.body).toContain("published=false");
    expect(calls[0]!.body).toContain(`scheduled_publish_time=${Math.floor(at.getTime() / 1000)}`);
    expect(out.scheduledFor).toBe(at.toISOString());
  });
  it("publishes Instagram in two steps and reads the permalink", async () => {
    const { http, calls } = fakeHttp((c) => ({ json: c.url.includes("/media_publish") ? { id: "ig9" } : c.url.includes("/ig9") ? { permalink: "https://www.instagram.com/p/abc/" } : { id: "container1" } }));
    const out = await new MetaGraph({ accessToken: TOKEN, instagramId: "5555555" }, http).publish({ target: "instagram", message: "Pic", imageUrl: "https://examutor.com/a.png" });
    expect(out.url).toBe("https://www.instagram.com/p/abc/");
    expect(calls[1]!.body).toContain("creation_id=container1");
  });
  it("tells a clear refusal from an uncertain failure", async () => {
    const no = fakeHttp(() => ({ status: 400, json: { error: { message: `bad ${TOKEN}` } } }));
    const e = await new MetaGraph({ accessToken: TOKEN, pageId: "1000001" }, no.http).publish({ target: "facebook", message: "x" }).catch((x) => x);
    expect(e).toBeInstanceOf(MetaRejected);
    expect(e.message).not.toContain(TOKEN);
    const drop = fakeHttp(() => "drop");
    await expect(new MetaGraph({ accessToken: TOKEN, pageId: "1000001" }, drop.http).publish({ target: "facebook", message: "x" })).rejects.toBeInstanceOf(MetaUncertain);
    const fault = fakeHttp(() => ({ status: 503, json: {} }));
    await expect(new MetaGraph({ accessToken: TOKEN, pageId: "1000001" }, fault.http).publish({ target: "facebook", message: "x" })).rejects.toBeInstanceOf(MetaUncertain);
  });
  it("reads basic engagement", async () => {
    const { http } = fakeHttp(() => ({ json: { reactions: { summary: { total_count: 7 } }, comments: { summary: { total_count: 2 } }, shares: { count: 1 } } }));
    const s = await new MetaGraph({ accessToken: TOKEN, pageId: "1000001" }, http).stats("facebook", "1_2", now);
    expect([s.likes, s.comments, s.shares]).toEqual([7, 2, 1]);
  });
  it("checks a post before sending it", () => {
    expect(publishProblems({ target: "instagram", message: "x" }, now).join()).toMatch(/picture/);
    expect(publishProblems({ target: "instagram", message: "x", imageUrl: "https://a.b/c.png", scheduleAt: new Date(now.getTime() + 3_600_000) }, now).join()).toMatch(/cannot be scheduled/);
    expect(publishProblems({ target: "facebook", message: "x", scheduleAt: new Date(now.getTime() + 60_000) }, now).join()).toMatch(/10 minutes/);
    expect(publishProblems({ target: "facebook", message: "x", scheduleAt: new Date(now.getTime() + 40 * 86_400_000) }, now).join()).toMatch(/30 days/);
    expect(publishProblems({ target: "facebook", message: "x", imageUrl: "http://a.b/c.png" }, now).join()).toMatch(/https/);
    expect(publishProblems({ target: "facebook", message: "fine" }, now)).toEqual([]);
  });
});

describe("settings", () => {
  const good = { META_ACCESS_TOKEN: "t", META_FACEBOOK_PAGE_ID: "1000001", META_APP_SECRET: "s", WHATSAPP_ACCESS_TOKEN: "w", WHATSAPP_PHONE_NUMBER_ID: "2000002", WHATSAPP_VERIFY_TOKEN: "0123456789abcdef", WHATSAPP_OWNER_NUMBER: "+44 7700 900123" };
  it("accepts a full set and builds the configs", () => {
    expect(metaEnvProblems(good)).toEqual([]);
    expect(metaFromEnv(good)?.pageId).toBe("1000001");
    expect(whatsappFromEnv(good)?.ownerNumber).toBe(OWNER_NUMBER);
    expect(checkEnv(good)).toEqual([]);
  });
  it("refuses half-set groups and bad values, and stays off with nothing set", () => {
    expect(metaEnvProblems({ META_ACCESS_TOKEN: "t" }).join()).toMatch(/PAGE_ID/);
    expect(metaEnvProblems({ ...good, WHATSAPP_OWNER_NUMBER: "" }).join()).toMatch(/WHATSAPP_OWNER_NUMBER/);
    expect(metaEnvProblems({ ...good, WHATSAPP_VERIFY_TOKEN: "short" }).join()).toMatch(/16/);
    expect(metaEnvProblems({ ...good, WHATSAPP_PHONE_NUMBER_ID: "+447700900123" }).join()).toMatch(/numeric id/);
    expect(metaFromEnv({})).toBeUndefined();
    expect(whatsappFromEnv({ ...good, META_APP_SECRET: "" })).toBeUndefined();
    expect(normalizeNumber("+44 (0)7700-900123")).toBe("4407700900123");
    expect(normalizeNumber("abc")).toBeUndefined();
  });
});

function setup(opts: { graph?: (c: Call) => any } = {}) {
  const clock = { d: new Date(now) };
  const out: Call[] = [];
  const { http } = fakeHttp((c) => {
    out.push(c);
    if (c.url.includes("/messages")) return { json: { messages: [{ id: "wamid.out" }] } };
    return opts.graph?.(c) ?? { json: { id: "1000001_77" } };
  });
  const platform = createPlatform({
    sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d, http,
    meta: { accessToken: TOKEN, pageId: "1000001", instagramId: "5555555", appSecret: APP_SECRET },
    whatsapp: { accessToken: "wa-token", phoneNumberId: "2000002", appSecret: APP_SECRET, verifyToken: "0123456789abcdef", ownerNumber: OWNER_NUMBER, alertTemplate: { name: "maiz_owner_alert", language: "en_GB" } },
  });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, query = "") =>
    handle({ method, path, query: new URLSearchParams(query), headers, rawBody: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body) } as Req);
  const owner = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(OWNER), e: OWNER }, 7 * 86400, clock.d.getTime())}` };
  const ownerId = userIdFor(OWNER);
  const sent = () => out.filter((c) => c.url.includes("/2000002/messages")).map((c) => JSON.parse(c.body));
  const webhook = async (from: string, text: string, id = `wamid.${Math.random()}`) => {
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from, type: "text", text: { body: text } }] } }] }] });
    const sig = `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
    const res = await call("POST", "/api/whatsapp/webhook", raw, { "x-hub-signature-256": sig });
    await res.after?.();
    return res;
  };
  const draft = async (channel = "social") => (await platform.promoter.draft(ownerId, { site: "examutor", channel, brief: "A tip" }));
  return { platform, call, owner, ownerId, out, sent, webhook, draft, clock };
}

describe("publishing approved posts to Meta", () => {
  it("publishes only after approval, once, and records where it went", async () => {
    const { platform, ownerId, draft, out } = setup();
    const d = await draft();
    await expect(platform.promoter.publishToMeta(ownerId, d.id, { target: "facebook" })).rejects.toThrow(/approved/);
    platform.promoter.decide(ownerId, d.id, true);
    const posted = await platform.promoter.publishToMeta(ownerId, d.id, { target: "facebook" });
    expect(posted.status).toBe("posted");
    expect(posted.postedUrl).toBe("https://www.facebook.com/1000001_77");
    await expect(platform.promoter.publishToMeta(ownerId, d.id, { target: "facebook" })).rejects.toThrow(/approved/);
    expect(out.filter((c) => c.url.includes("/feed"))).toHaveLength(1);
  });
  it("two presses at once publish once", async () => {
    const { platform, ownerId, draft, out } = setup();
    const d = await draft();
    platform.promoter.decide(ownerId, d.id, true);
    const r = await Promise.allSettled([platform.promoter.publishToMeta(ownerId, d.id, { target: "facebook" }), platform.promoter.publishToMeta(ownerId, d.id, { target: "facebook" })]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(out.filter((c) => c.url.includes("/feed"))).toHaveLength(1);
  });
  it("puts a refused post back to approved, and an uncertain one to failed", async () => {
    const refuse = setup({ graph: () => ({ status: 400, json: { error: { message: "Invalid parameter" } } }) });
    const a = await refuse.draft(); refuse.platform.promoter.decide(refuse.ownerId, a.id, true);
    await expect(refuse.platform.promoter.publishToMeta(refuse.ownerId, a.id, { target: "facebook" })).rejects.toThrow(/Meta said no/);
    expect(refuse.platform.promoter.items_(refuse.ownerId).find((x) => x.id === a.id)!.status).toBe("approved");
    const drop = setup({ graph: () => ({ status: 503 }) });
    const b = await drop.draft(); drop.platform.promoter.decide(drop.ownerId, b.id, true);
    await expect(drop.platform.promoter.publishToMeta(drop.ownerId, b.id, { target: "facebook" })).rejects.toThrow(/Check the page/);
    expect(drop.platform.promoter.items_(drop.ownerId).find((x) => x.id === b.id)!.status).toBe("failed");
  });
  it("refuses emails and non-owners, and the route is owner only", async () => {
    const { platform, ownerId, call, owner, draft } = setup();
    const d = await draft();
    platform.promoter.decide(ownerId, d.id, true);
    await expect(platform.promoter.publishToMeta("someone", d.id, { target: "facebook" })).rejects.toThrow();
    const other = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor("x@y.test"), e: "x@y.test" }, 86400, now.getTime())}` };
    expect((await call("POST", `/api/owner/promoter/drafts/${d.id}/publish`, { target: "facebook" }, other)).status).toBe(403);
    expect((await call("POST", `/api/owner/promoter/drafts/${d.id}/publish`, { target: "facebook" }, owner)).status).toBe(200);
    expect(((await call("GET", "/api/owner/promoter/channels", undefined, owner)).body as any).facebook).toBe(true);
    const em = await platform.promoter.draft(ownerId, { site: "examutor", channel: "seo", brief: "x" });
    platform.promoter.decide(ownerId, em.id, true);
    await expect(platform.promoter.publishToMeta(ownerId, em.id, { target: "facebook" })).rejects.toThrow(/social posts/);
  });
  it("reads engagement for a live post but not a scheduled one", async () => {
    const { platform, ownerId, draft, clock } = setup({ graph: (c) => (c.method === "GET" ? { json: { reactions: { summary: { total_count: 3 } }, comments: { summary: { total_count: 1 } } } } : { json: { id: "1_9" } }) });
    const d = await draft(); platform.promoter.decide(ownerId, d.id, true);
    await platform.promoter.publishToMeta(ownerId, d.id, { target: "facebook", scheduleAt: new Date(clock.d.getTime() + 3_600_000).toISOString() });
    await expect(platform.promoter.refreshStats(ownerId, d.id)).rejects.toThrow(/not live/);
    clock.d = new Date(clock.d.getTime() + 2 * 3_600_000);
    expect((await platform.promoter.refreshStats(ownerId, d.id)).stats?.likes).toBe(3);
  });
});

describe("WhatsApp webhook", () => {
  it("answers Meta's handshake only with the right verify token", async () => {
    const { call } = setup();
    const ok = await call("GET", "/api/whatsapp/webhook", undefined, {}, "hub.mode=subscribe&hub.verify_token=0123456789abcdef&hub.challenge=998877");
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("998877");
    expect((await call("GET", "/api/whatsapp/webhook", undefined, {}, "hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status).toBe(403);
  });
  it("rejects unsigned and badly signed deliveries", async () => {
    const { call, sent } = setup();
    const raw = JSON.stringify({ entry: [] });
    expect((await call("POST", "/api/whatsapp/webhook", raw)).status).toBe(401);
    expect((await call("POST", "/api/whatsapp/webhook", raw, { "x-hub-signature-256": "sha256=" + "0".repeat(64) })).status).toBe(401);
    expect(sent()).toHaveLength(0);
  });
  it("is off (503) when WhatsApp is not configured", async () => {
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, platformOwners: [OWNER] });
    const res = await createApp(platform)({ method: "GET", path: "/api/whatsapp/webhook", query: new URLSearchParams(), headers: {}, rawBody: "" } as Req);
    expect(res.status).toBe(503);
  });
  it("ignores everyone except the owner's number, without replying", async () => {
    const { webhook, sent, platform, ownerId, draft } = setup();
    const d = await draft();
    await new Promise((r) => setTimeout(r, 0));
    const before = sent().length; // the alert about the new draft
    await webhook("447911123456", `approve ${d.id.slice(0, 5)}`);
    expect(sent()).toHaveLength(before);
    expect(platform.promoter.items_(ownerId).find((x) => x.id === d.id)!.status).toBe("awaiting_approval");
  });
  it("lets the owner list, show, approve, reject and publish by replying", async () => {
    const { webhook, sent, platform, ownerId, draft } = setup();
    const a = await draft(); const b = await draft();
    const code = (id: string) => id.replace(/-/g, "").slice(0, 5);
    await webhook(OWNER_NUMBER, "hello");
    expect(sent().at(-1).text.body).toContain(code(a.id));
    await webhook(OWNER_NUMBER, `show ${code(a.id)}`);
    expect(sent().at(-1).text.body).toContain(a.body.slice(0, 20));
    await webhook(OWNER_NUMBER, `post ${code(a.id)} fb`);
    expect(sent().at(-1).text.body).toMatch(/Approve it first/);
    await webhook(OWNER_NUMBER, `approve ${code(a.id)}`);
    expect(platform.promoter.items_(ownerId).find((x) => x.id === a.id)!.status).toBe("approved");
    await webhook(OWNER_NUMBER, `post ${code(a.id)} fb`);
    expect(sent().at(-1).text.body).toContain("https://www.facebook.com/1000001_77");
    await webhook(OWNER_NUMBER, `reject ${code(b.id)} not now`);
    expect(platform.promoter.items_(ownerId).find((x) => x.id === b.id)!.status).toBe("rejected");
    await webhook(OWNER_NUMBER, "approve zzzzz");
    expect(sent().at(-1).text.body).toMatch(/could not find/);
    await webhook(OWNER_NUMBER, "gibberish");
    expect(sent().at(-1).text.body).toMatch(/did not understand/);
  });
  it("handles a redelivered message once", async () => {
    const { webhook, sent } = setup();
    await webhook(OWNER_NUMBER, "list", "wamid.same");
    await webhook(OWNER_NUMBER, "list", "wamid.same");
    expect(sent()).toHaveLength(1);
  });
  it("uses the template outside the 24-hour window and plain text inside it", async () => {
    const { platform, ownerId, sent, webhook, draft, clock } = setup();
    await draft();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent()).toHaveLength(1);
    expect(sent()[0].type).toBe("template");
    expect(sent()[0].template.name).toBe("maiz_owner_alert");
    expect(sent()[0].to).toBe(OWNER_NUMBER);
    await webhook(OWNER_NUMBER, "hello"); // opens the window
    await draft();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent().at(-1).type).toBe("text");
    // The same waiting items are not announced twice.
    await platform.ownerWhatsApp!.notifyWaiting();
    const n = sent().length;
    await platform.ownerWhatsApp!.notifyWaiting();
    expect(sent()).toHaveLength(n);
    // 25 hours later the window is closed again.
    clock.d = new Date(clock.d.getTime() + 25 * 3_600_000);
    expect(platform.ownerWhatsApp!.windowOpen()).toBe(false);
    expect(ownerId).toBeTruthy();
  });
});
