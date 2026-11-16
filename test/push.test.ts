import { createDecipheriv, createECDH, createPublicKey, createVerify, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { MAX_SUBSCRIPTIONS_PER_USER, PushService, VAPID_STORE_KEY, encryptPayload, generateVapidKeys, isPushEndpoint, vapidAuthorization } from "../src/modules/push/index.js";
import type { Sink } from "../src/core/persistence.js";

/** A stand-in for a browser: its own key pair and secret, and the decryption a real browser does. */
function browser() {
  const ecdh = createECDH("prime256v1");
  const p256dh = ecdh.generateKeys();
  const auth = randomBytes(16);
  const open = (body: Buffer): string => {
    const salt = body.subarray(0, 16);
    const idLen = body.readUInt8(20);
    const asPublic = body.subarray(21, 21 + idLen);
    const sealed = body.subarray(21 + idLen);
    const ikm = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(asPublic), auth, Buffer.concat([Buffer.from("WebPush: info\0"), p256dh, asPublic]), 32));
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const d = createDecipheriv("aes-128-gcm", cek, nonce);
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
    expect(plain[plain.length - 1]).toBe(2);
    return plain.subarray(0, plain.length - 1).toString("utf8");
  };
  const sub = (endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(6).toString("hex")}`) => ({ endpoint, keys: { p256dh: p256dh.toString("base64url"), auth: auth.toString("base64url") } });
  return { open, sub };
}

function service(status = 201) {
  const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const state = { status };
  const http = (async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
    sent.push({ url, headers: init.headers, body: Buffer.from(init.body) });
    return new Response(null, { status: state.status });
  }) as unknown as typeof fetch;
  const push = new PushService({ subject: "https://maiz.test", now: () => new Date("2026-11-16T12:00:00Z"), http });
  return { push, sent, state };
}

describe("web push encryption and signing", () => {
  it("encrypts a message that only the subscribed browser can open", () => {
    const b = browser();
    const body = encryptPayload(b.sub(), Buffer.from(JSON.stringify({ title: "Your batch is done" })));
    expect(JSON.parse(b.open(body))).toEqual({ title: "Your batch is done" });
    expect(() => browser().open(body)).toThrow();
  });

  it("signs a short-lived token for the push service's own origin with the sender's key", () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "https://maiz.test", Date.parse("2026-11-16T12:00:00Z"));
    const [, token, key] = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(header)!;
    const [head, claims, sig] = token!.split(".");
    expect(key).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: Date.parse("2026-11-17T00:00:00Z") / 1000, sub: "https://maiz.test" });
    const pub = Buffer.from(keys.publicKey, "base64url");
    const publicKey = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") } });
    expect(createVerify("SHA256").update(`${head}.${claims}`).verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"))).toBe(true);
  });

  it("refuses a browser key or message of the wrong size", () => {
    const b = browser().sub();
    expect(() => encryptPayload({ ...b, keys: { ...b.keys, auth: "c2hvcnQ" } }, Buffer.from("x"))).toThrow(/16 bytes/);
    expect(() => encryptPayload(b, Buffer.alloc(5000))).toThrow(/too long/);
  });
});

describe("where a push may be sent", () => {
  it("accepts only the push services browsers use, over https", () => {
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    expect(isPushEndpoint("https://web.push.apple.com/abc")).toBe(true);
    expect(isPushEndpoint("https://db5p.notify.windows.com/w/?token=abc")).toBe(true);
    for (const bad of ["http://fcm.googleapis.com/x", "https://169.254.169.254/latest", "https://localhost/x", "https://evil.test/fcm.googleapis.com", "https://fcm.googleapis.com.evil.test/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "", 7, null]) {
      expect(isPushEndpoint(bad)).toBe(false);
    }
  });
});

describe("push subscriptions", () => {
  it("sends an encrypted, signed message to every browser in the workspace and reports how many got it", async () => {
    const { push, sent } = service();
    const a = browser(), b = browser();
    push.subscribe("u_ann", "ws_1", a.sub());
    push.subscribe("u_ben", "ws_1", b.sub());
    push.subscribe("u_cat", "ws_2", browser().sub());

    const n = await push.sendToWorkspace("ws_1", { title: "Quality review passed", body: "Your brand kit is ready", link: "/app.html#work" });

    expect(n).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers).toMatchObject({ "content-encoding": "aes128gcm", ttl: "43200" });
    expect(sent[0]!.headers.authorization).toMatch(/^vapid t=/);
    expect(JSON.parse(a.open(sent[0]!.body))).toEqual({ title: "Quality review passed", body: "Your brand kit is ready", link: "/app.html#work" });
  });

  it("never puts a link to another site in a notification", async () => {
    const { push, sent } = service();
    const a = browser();
    push.subscribe("u_ann", "ws_1", a.sub());
    await push.sendToWorkspace("ws_1", { title: "Hello", link: "//evil.test/x" });
    expect(JSON.parse(a.open(sent[0]!.body))).toEqual({ title: "Hello" });
  });

  it("forgets a browser the push service says is gone", async () => {
    const { push, sent, state } = service(410);
    push.subscribe("u_ann", "ws_1", browser().sub());
    expect(await push.sendToUser("u_ann", { title: "Hello" })).toBe(0);
    state.status = 201;
    expect(await push.sendToUser("u_ann", { title: "Hello again" })).toBe(0);
    expect(sent).toHaveLength(1);
    expect(push.count("u_ann")).toBe(0);
  });

  it("keeps a browser after a temporary failure, and a failure never throws", async () => {
    const { push, state } = service(503);
    push.subscribe("u_ann", "ws_1", browser().sub());
    expect(await push.sendToUser("u_ann", { title: "Hello" })).toBe(0);
    state.status = 201;
    expect(await push.sendToUser("u_ann", { title: "Hello" })).toBe(1);
  });

  it("refuses an address that is not a push service, and keys that are missing", () => {
    const { push } = service();
    expect(() => push.subscribe("u_ann", "ws_1", { ...browser().sub(), endpoint: "https://internal.example/hook" })).toThrow(/address/);
    expect(() => push.subscribe("u_ann", "ws_1", { endpoint: "https://fcm.googleapis.com/fcm/send/abc" })).toThrow(/keys/);
  });

  it("replaces the same browser instead of adding it twice, and keeps only the newest few per person", () => {
    const { push } = service();
    const one = browser().sub();
    push.subscribe("u_ann", "ws_1", one);
    push.subscribe("u_ann", "ws_1", one);
    expect(push.count("u_ann")).toBe(1);
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER + 3; i++) push.subscribe("u_ann", "ws_1", browser().sub());
    expect(push.count("u_ann")).toBe(MAX_SUBSCRIPTIONS_PER_USER);
  });

  it("moves a shared browser to whoever logged in on it last, so the last person's alerts stop arriving there", async () => {
    const { push, sent } = service();
    const shared = browser().sub();
    push.subscribe("u_ann", "ws_ann", shared);
    push.subscribe("u_ben", "ws_ben", shared);

    const toAnn = await push.sendToWorkspace("ws_ann", { title: "Ann's work is ready" });
    const toBen = await push.sendToWorkspace("ws_ben", { title: "Ben's work is ready" });

    expect(push.count("u_ann")).toBe(0);
    expect(toAnn).toBe(0);
    expect(toBen).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("does not tell someone who has left the team", async () => {
    const sent: string[] = [];
    const http = (async (url: string) => { sent.push(url); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    const onTeam = new Set(["u_ann"]);
    const push = new PushService({ subject: "https://maiz.test", now: () => new Date("2026-11-16T12:00:00Z"), http, member: (userId) => onTeam.has(userId) });
    push.subscribe("u_ann", "ws_1", browser().sub());
    push.subscribe("u_gone", "ws_1", browser().sub());

    const told = await push.sendToWorkspace("ws_1", { title: "Work is ready" });

    expect(told).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("lets only the person who subscribed a browser remove it", () => {
    const { push } = service();
    const one = browser().sub();
    push.subscribe("u_ann", "ws_1", one);
    expect(push.unsubscribe("u_ben", one.endpoint)).toBe(false);
    expect(push.unsubscribe("u_ann", one.endpoint)).toBe(true);
    expect(push.count("u_ann")).toBe(0);
  });

  it("stores its key pair and subscriptions so a restart keeps them", async () => {
    const saved = { secret: "", subs: [] as any[] };
    const sink = new Proxy({}, { get: (_t, k) => (k === "connectionSecret" ? (key: string, s: string) => { if (key === VAPID_STORE_KEY) saved.secret = s; } : k === "promo" ? (_kind: string, _id: string, d: unknown) => { saved.subs.push(d); } : () => undefined) }) as unknown as Sink;
    const first = service();
    first.push.useSink(sink);
    const key = first.push.publicKey();
    const b = browser();
    first.push.subscribe("u_ann", "ws_1", b.sub());

    const second = service();
    second.push.restoreKeys(saved.secret);
    for (const s of saved.subs) second.push.restore(s);

    expect(second.push.publicKey()).toBe(key);
    expect(await second.push.sendToWorkspace("ws_1", { title: "Still here" })).toBe(1);
    expect(JSON.parse(b.open(second.sent[0]!.body))).toEqual({ title: "Still here" });
  });
});

describe("push over the API", () => {
  function setup() {
    const sent: string[] = [];
    const http = (async (url: string) => { sent.push(String(url)); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", platformOwners: ["atif@maiz.test"], http });
    const handle = createApp(platform);
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
    const signUp = async (email: string, name: string) => {
      const r = await call("POST", "/api/signup", { email, businessName: name, sells: "Coffee", size: "2–10", country: "GB" });
      return { authorization: `Bearer ${(r.body as any).token}` };
    };
    return { platform, call, signUp, sent };
  }

  it("needs a signed-in person, hands out the public key, and pushes when the bell rings", async () => {
    const s = setup();
    expect((await s.call("GET", "/api/push")).status).toBe(401);
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const info = (await s.call("GET", "/api/push", undefined, ann)).body as any;
    expect(info).toMatchObject({ subscribed: 0 });
    expect(Buffer.from(info.publicKey, "base64url")).toHaveLength(65);

    const sub = browser().sub();
    expect((await s.call("POST", "/api/push/subscribe", { subscription: sub }, ann)).status).toBe(201);
    const ws = ((await s.call("GET", "/api/org", undefined, ann)).body as any).id;
    s.platform.notices.add(ws, { kind: "batch_done", title: "Your batch is done", link: "/app.html#work" });
    await new Promise((r) => setTimeout(r, 5));

    expect(s.sent).toEqual([sub.endpoint]);
    expect((await s.call("POST", "/api/push/test", {}, ann)).body).toEqual({ sent: 1 });
    expect((await s.call("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint }, ann)).body).toEqual({ removed: true, subscribed: 0 });
  });

  it("answers a bad subscription with a plain reason instead of an error page", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const r = await s.call("POST", "/api/push/subscribe", { subscription: { endpoint: "https://example.test/x", keys: {} } }, ann);
    expect(r.status).toBe(400);
    expect((r.body as any).error).toMatch(/notification address/);
  });
});
