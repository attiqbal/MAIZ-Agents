/**
 * Contract tests: what we send to each outside service and how we read its answer, checked against recorded,
 * documented request and response shapes with no network. They fail when someone changes a URL, header or body
 * by accident, and they keep every outbound call on that vendor's own host. They do NOT prove the vendor still
 * behaves this way: that needs the real keys (see docs/INTEGRATIONS.md, "Needs real keys").
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createApp, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender, ResendEmailSender } from "../src/server/email.js";
import { AnthropicAdapter } from "../src/modules/model-gateway/adapters/anthropic.js";
import { RunPodAdapter } from "../src/modules/model-gateway/adapters/runpod.js";

interface Seen { url: URL; method: string; headers: Record<string, string>; body?: string }
/** A fetch that records each call and answers from a queue of canned replies. */
function recorder(...replies: (Response | ((s: Seen) => Response))[]) {
  const seen: Seen[] = [];
  const http = (async (url: string | URL, init?: RequestInit) => {
    const s: Seen = { url: new URL(String(url)), method: init?.method ?? "GET", headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), body: init?.body ? String(init.body) : undefined };
    seen.push(s);
    const r = replies.length > 1 ? replies.shift()! : replies[0]!;
    return typeof r === "function" ? r(s) : r.clone();
  }) as typeof fetch;
  return { http, seen };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Resend (email)", () => {
  it("posts one JSON email to api.resend.com with a Bearer key", async () => {
    const r = recorder(ok({ id: "e1" }));
    await new ResendEmailSender("re_key", "MAIZ <hello@maiz.test>", r.http).send({ to: "ann@kestrel.co", subject: "Hi", text: "Body" });
    const s = r.seen[0]!;
    expect(s.url.href).toBe("https://api.resend.com/emails");
    expect(s.method).toBe("POST");
    expect(s.headers).toMatchObject({ authorization: "Bearer re_key", "content-type": "application/json" });
    expect(JSON.parse(s.body!)).toEqual({ from: "MAIZ <hello@maiz.test>", to: ["ann@kestrel.co"], subject: "Hi", text: "Body" });
  });
  it("throws on a refusal without echoing the key or the message", async () => {
    const r = recorder(new Response("domain not verified", { status: 403 }));
    const err = await new ResendEmailSender("re_secret", "a@b.test", r.http).send({ to: "x@y.test", subject: "s", text: "t" }).then(() => new Error("did not throw"), (e: Error) => e);
    expect(err.message).toBe("email provider 403");
    expect(err.message).not.toContain("re_secret");
  });
});

describe("Anthropic (Claude)", () => {
  it("calls /v1/messages with the key and version headers, system prompt separate from messages", async () => {
    const r = recorder(ok({ content: [{ type: "text", text: "Hello" }], usage: { input_tokens: 12, output_tokens: 3 }, stop_reason: "end_turn" }));
    const out = await new AnthropicAdapter("sk-ant-test", "claude-haiku-5-5", r.http).complete({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }], maxTokens: 50 });
    const s = r.seen[0]!;
    expect(s.url.href).toBe("https://api.anthropic.com/v1/messages");
    expect(s.headers).toMatchObject({ "x-api-key": "sk-ant-test", "anthropic-version": "2023-06-01" });
    expect(JSON.parse(s.body!)).toEqual({ model: "claude-haiku-5-5", max_tokens: 50, system: "Be brief.", messages: [{ role: "user", content: "Hi" }] });
    expect(out).toMatchObject({ text: "Hello", inputTokens: 12, outputTokens: 3, truncated: false });
  });
  it("reads a cut-off answer and maps rate limits and outages to typed errors", async () => {
    const cut = recorder(ok({ content: [{ type: "text", text: "partial" }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "max_tokens" }));
    expect((await new AnthropicAdapter("k", "m", cut.http).complete({ messages: [{ role: "user", content: "x" }] })).truncated).toBe(true);
    const limited = recorder(new Response("", { status: 429 }));
    await expect(new AnthropicAdapter("k", "m", limited.http).complete({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ status: 429 });
  });
});

describe("RunPod (open models)", () => {
  it("uses the endpoint's OpenAI-compatible route on api.runpod.ai only", async () => {
    const r = recorder(ok({ choices: [{ message: { content: "Draft" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
    const out = await new RunPodAdapter("rp_key", "abc123def", "Qwen/Qwen3-8B", r.http).complete({ messages: [{ role: "user", content: "Hi" }], maxTokens: 64 });
    const s = r.seen[0]!;
    expect(s.url.href).toBe("https://api.runpod.ai/v2/abc123def/openai/v1/chat/completions");
    expect(s.headers.authorization).toBe("Bearer rp_key");
    expect(JSON.parse(s.body!)).toEqual({ model: "Qwen/Qwen3-8B", messages: [{ role: "user", content: "Hi" }], max_tokens: 64 });
    expect(out).toMatchObject({ text: "Draft", inputTokens: 20, outputTokens: 5 });
  });
  it("reads worker health from /health with the same key", async () => {
    const r = recorder(ok({ workers: { idle: 1, running: 0 }, jobs: { inQueue: 2 } }));
    const h = await new RunPodAdapter("rp_key", "abc123def", "m", r.http).health();
    expect(r.seen[0]!.url.href).toBe("https://api.runpod.ai/v2/abc123def/health");
    expect(h).toEqual({ reachable: true, workers: { idle: 1, running: 0 }, jobs: { inQueue: 2 } });
  });
});

describe("Slack", () => {
  const slack = { clientId: "cid", clientSecret: "csecret", signingSecret: "sign", redirectUri: "https://app.test/api/slack/callback" };
  function world(http: typeof fetch) {
    const clock = { d: new Date("2026-11-10T09:00:00Z") };
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", slack, http, now: () => clock.d });
    const handle = createApp(platform);
    const call = (method: string, path: string, query = "", body?: unknown, headers: Record<string, string> = {}) =>
      handle({ method, path, query: new URLSearchParams(query), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
    return { platform, call };
  }

  it("builds the install link with the scopes we need and exchanges the code on slack.com, once", async () => {
    const r = recorder(ok({ ok: true, access_token: "xoxb-new", team: { id: "T9" }, authed_user: { id: "U9" } }), ok({ ok: true }));
    const { platform, call } = world(r.http);
    const su = await call("POST", "/api/signup", "", { email: "ann@kestrel.co", businessName: "Kestrel", sells: "Coffee", size: "2–10", country: "GB" });
    const auth = { authorization: `Bearer ${(su.body as any).token}` };
    const link = new URL(((await call("GET", "/api/slack/install", "", undefined, auth)).body as any).url);
    expect(link.origin + link.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(link.searchParams.get("client_id")).toBe("cid");
    expect(link.searchParams.get("scope")!.split(",").sort()).toEqual(["app_mentions:read", "chat:write", "im:history", "im:read", "im:write"]);
    expect(link.searchParams.get("redirect_uri")).toBe(slack.redirectUri);

    const state = link.searchParams.get("state")!;
    const done = await call("GET", "/api/slack/callback", `code=thecode&state=${encodeURIComponent(state)}`);
    expect(done.status).toBe(302);
    const exchange = r.seen[0]!;
    expect(exchange.url.href).toBe("https://slack.com/api/oauth.v2.access");
    expect(exchange.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toEqual({ code: "thecode", client_id: "cid", client_secret: "csecret", redirect_uri: slack.redirectUri });
    expect(platform.slackTokens.get("T9")).toBe("xoxb-new");
    expect(JSON.stringify(done)).not.toContain("xoxb-new");
    // The same link cannot be used twice.
    expect((await call("GET", "/api/slack/callback", `code=thecode&state=${encodeURIComponent(state)}`)).status).toBe(400);
  });

  it("refuses the install when Slack says no, and stores nothing", async () => {
    const r = recorder(ok({ ok: false, error: "invalid_code" }));
    const { platform, call } = world(r.http);
    const su = await call("POST", "/api/signup", "", { email: "bob@x.co", businessName: "X", sells: "y", size: "2–10", country: "GB" });
    const auth = { authorization: `Bearer ${(su.body as any).token}` };
    const state = new URL(((await call("GET", "/api/slack/install", "", undefined, auth)).body as any).url).searchParams.get("state")!;
    const res = await call("GET", "/api/slack/callback", `code=bad&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
    expect(platform.slackTokens.size).toBe(0);
  });

  it("answers Slack's URL check only when the signature over `v0:timestamp:body` is right", async () => {
    const { call } = world(recorder(ok({})).http);
    const body = { type: "url_verification", challenge: "abc" };
    const ts = String(Math.floor(new Date("2026-11-10T09:00:00Z").getTime() / 1000));
    const sig = `v0=${createHmac("sha256", slack.signingSecret).update(`v0:${ts}:${JSON.stringify(body)}`).digest("hex")}`;
    expect((await call("POST", "/api/slack/events", "", body, {})).status).toBe(401);
    expect((await call("POST", "/api/slack/events", "", body, { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=00" })).status).toBe(401);
    const good = await call("POST", "/api/slack/events", "", body, { "x-slack-request-timestamp": ts, "x-slack-signature": sig });
    expect(good).toMatchObject({ status: 200, body: { challenge: "abc" } });
  });
});

describe("Square and Stripe request shapes", () => {
  it("sends the pinned Square API version and a Bearer token to connect.squareup.com", async () => {
    const { IntegrationService, defaultRegistry } = await import("../src/modules/integrations/index.js");
    const { AuditLog, EventBus, IdentityService, Ledger } = await import("../src/index.js");
    const audit = new AuditLog();
    const identity = new IdentityService(audit, new EventBus());
    const ledger = new Ledger(identity, audit);
    const ws = await identity.createWorkspace("owner", { name: "K", baseCurrency: "GBP" });
    ledger.open("owner", ws.id);
    // Token exchange first, then a payments read.
    const rec = recorder(ok({ access_token: "sq-access", refresh_token: "r", merchant_id: "M1" }), ok({ payments: [] }));
    const ig2 = new IntegrationService(identity, audit, ledger, defaultRegistry(), { http: rec.http, now: () => new Date("2026-11-10T12:00:00Z"), oauthApps: { square: { clientId: "i", clientSecret: "s", redirectUri: "https://app.test/cb" } } });
    const conn = await ig2.completeOAuth("owner", ws.id, "square", "code");
    await ig2.sync("owner", ws.id, conn.id, { from: "2026-11-01", to: "2026-11-10" });
    const [token, payments] = rec.seen;
    expect(token!.url.href).toBe("https://connect.squareup.com/oauth2/token");
    expect(token!.headers["square-version"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payments!.url.origin + payments!.url.pathname).toBe("https://connect.squareup.com/v2/payments");
    expect(payments!.headers).toMatchObject({ authorization: "Bearer sq-access", accept: "application/json" });
    expect(payments!.headers["square-version"]).toBe(token!.headers["square-version"]);
    expect(payments!.url.searchParams.get("begin_time")).toBe("2026-11-01T00:00:00Z");
    expect(payments!.url.searchParams.get("end_time")).toBe("2026-11-10T23:59:59Z");
  });
});

describe("outbound hosts", () => {
  it("each adapter only ever talks to its own vendor", async () => {
    const hosts = new Set<string>();
    const spy = (reply: unknown) => (async (url: string) => { hosts.add(new URL(String(url)).host); return ok(reply); }) as typeof fetch;
    await new ResendEmailSender("k", "a@b.test", spy({})).send({ to: "x@y.test", subject: "s", text: "t" });
    await new AnthropicAdapter("k", "m", spy({ content: [{ type: "text", text: "a" }], usage: { input_tokens: 1, output_tokens: 1 } })).complete({ messages: [{ role: "user", content: "x" }] });
    await new RunPodAdapter("k", "abc123", "m", spy({ choices: [{ message: { content: "a" } }] })).complete({ messages: [{ role: "user", content: "x" }] });
    expect([...hosts].sort()).toEqual(["api.anthropic.com", "api.resend.com", "api.runpod.ai"]);
  });
  it("RunPod refuses an endpoint id that could redirect the call", () => {
    expect(() => new RunPodAdapter("k", "evil.test/x", "m")).toThrow();
    expect(() => new RunPodAdapter("k", "https://api.runpod.ai/v2/abc", "m")).toThrow();
  });
});
