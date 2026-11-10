import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp, makeToken, readToken, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender, ResendEmailSender } from "../src/server/email.js";

const SLACK = { clientId: "cid", clientSecret: "sec", signingSecret: "sign", redirectUri: "https://x/api/slack/callback" };
function setup(over: Record<string, unknown> = {}) {
  const clock = { d: new Date("2026-06-10T10:00:00Z") };
  const calls: any[] = [];
  const http = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("oauth.v2.access")) return { json: async () => ({ ok: true, access_token: "xoxb-9", team: { id: "T9" }, authed_user: { id: "U9" } }) };
    return { json: async () => ({ ok: true }) };
  }) as any;
  const mail = new MemoryEmailSender();
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: mail, appUrl: "https://app.test", slack: SLACK, now: () => clock.d, http, ...over });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, query = "") =>
    handle({ method, path, query: new URLSearchParams(query), headers, rawBody: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body) } as Req);
  return { platform, call, clock, calls, mail };
}
async function signedUp() {
  const s = setup();
  const r = await s.call("POST", "/api/signup", { email: "Ann@Kestrel.co", businessName: "Kestrel Coffee", sells: "Specialty coffee", size: "2–10", country: "GB", goal: "More customers" });
  const { token } = r.body as any;
  return { ...s, r, auth: { authorization: `Bearer ${token}` } };
}

describe("tokens", () => {
  it("reject tampering and expiry", () => {
    const t = makeToken("k", { u: "a" }, 60, 0);
    expect(readToken("k", t, 1000)?.u).toBe("a");
    expect(readToken("k", t, 61_000)).toBeUndefined();
    expect(readToken("other", t, 1000)).toBeUndefined();
    expect(readToken("k", t.replace(/^./, "x"), 1000)).toBeUndefined();
  });
});

describe("signup and org", () => {
  it("creates an organisation and returns the team with energy left", async () => {
    const { r, call, auth } = await signedUp();
    expect(r.status).toBe(201);
    expect((r.body as any).trialEndsAt).toBe("2026-06-17T10:00:00.000Z");
    const org = (await call("GET", "/api/org", undefined, auth)).body as any;
    expect(org.name).toBe("Kestrel Coffee");
    expect(org.team.map((e: any) => e.templateKey)).toEqual(["admin-manager", "finance-manager", "marketing-manager", "business-consultant", "hr-manager"]);
    expect(org.team[0].energyLeft).toBe(300);
  });
  it("refuses a second signup for the same email, bad emails, and unconfigured dev auth", async () => {
    const { call } = await signedUp().then(async (x) => x);
    expect((await call("POST", "/api/signup", { email: "ann@kestrel.co", businessName: "X" })).status).toBe(409);
    expect((await call("POST", "/api/signup", { email: "nope", businessName: "X" })).status).toBe(400);
    expect((await setup({ allowDevAuth: false }).call("POST", "/api/signup", { email: "a@b.co", businessName: "X" })).status).toBe(401);
  });
  it("requires a session for everything else", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/org")).status).toBe(401);
    expect((await call("GET", "/api/org", undefined, { authorization: "Bearer junk" })).status).toBe(401);
  });
  it("keeps customers apart", async () => {
    const a = await signedUp();
    const r2 = await a.call("POST", "/api/signup", { email: "bob@other.co", businessName: "Other" });
    const bobAuth = { authorization: `Bearer ${(r2.body as any).token}` };
    const bobOrg = (await a.call("GET", "/api/org", undefined, bobAuth)).body as any;
    const annOrg = (await a.call("GET", "/api/org", undefined, a.auth)).body as any;
    expect(bobOrg.name).toBe("Other");
    // Bob cannot ask Ann's employee
    const res = await a.call("POST", "/api/ask", { text: "hi", employeeId: annOrg.team[0].id }, bobAuth);
    expect(res.status).toBe(400);
  });
});

describe("ask and finance", () => {
  it("asks an employee and spends energy accounting", async () => {
    const { call, auth } = await signedUp();
    const org = (await call("GET", "/api/org", undefined, auth)).body as any;
    const r = await call("POST", "/api/ask", { text: "Draft a post", employeeId: org.team[1].id }, auth);
    expect(r.status).toBe(200);
    expect((r.body as any).status).toBe("ready_for_review");
    expect((await call("POST", "/api/ask", { text: "", employeeId: org.team[1].id }, auth)).status).toBe(400);
  });
  it("posts an entry and reports profit and loss", async () => {
    const { call, auth } = await signedUp();
    const bad = await call("POST", "/api/finance/entries", { date: "2026-06-02", memo: "x", lines: [{ account: "1000", debit: 5, credit: 0 }, { account: "4000", debit: 0, credit: 4 }] }, auth);
    expect(bad.status).toBe(400);
    const ok = await call("POST", "/api/finance/entries", { date: "2026-06-02", memo: "Sale", lines: [{ account: "1000", debit: 9000, credit: 0 }, { account: "4000", debit: 0, credit: 9000 }] }, auth);
    expect(ok.status).toBe(201);
    const s = (await call("GET", "/api/finance/summary", undefined, auth)).body as any;
    expect(s.profitAndLoss.netProfit).toBe(9000);
  });
});

describe("slack", () => {
  const sign = (secret: string, ts: number, body: string) => `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  it("install link carries a signed state; callback connects, stores token, links installer", async () => {
    const { call, auth, platform } = await signedUp();
    const { url } = (await call("GET", "/api/slack/install", undefined, auth)).body as any;
    const u = new URL(url);
    expect(u.searchParams.get("client_id")).toBe("cid");
    const state = u.searchParams.get("state")!;
    const cb = await call("GET", "/api/slack/callback", undefined, {}, `code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    expect(platform.slackTokens.get("T9")).toBe("xoxb-9");
    expect((await call("GET", "/api/slack/callback", undefined, {}, "code=abc&state=forged")).status).toBe(400);
  });
  it("answers Slack events only when signed, and replies in the chat afterwards", async () => {
    const { call, auth, calls, clock } = await signedUp();
    const { url } = (await call("GET", "/api/slack/install", undefined, auth)).body as any;
    await call("GET", "/api/slack/callback", undefined, {}, `code=abc&state=${new URL(url).searchParams.get("state")}`);
    const ts = Math.floor(clock.d.getTime() / 1000);
    const body = JSON.stringify({ type: "event_callback", team_id: "T9", event_id: "Ev1", event: { type: "message", channel_type: "im", user: "U9", channel: "D9", text: "finance: runway?" } });
    const bad = await call("POST", "/api/slack/events", body, { "x-slack-request-timestamp": String(ts), "x-slack-signature": "v0=bad" });
    expect(bad.status).toBe(401);
    const good = await call("POST", "/api/slack/events", body, { "x-slack-request-timestamp": String(ts), "x-slack-signature": sign("sign", ts, body) });
    expect(good.status).toBe(200);
    await good.after!();
    expect(calls.some((c) => c.url.includes("chat.postMessage") && c.init.headers.authorization === "Bearer xoxb-9")).toBe(true);
    const ch = await call("POST", "/api/slack/events", JSON.stringify({ type: "url_verification", challenge: "zz" }), { "x-slack-request-timestamp": String(ts), "x-slack-signature": sign("sign", ts, JSON.stringify({ type: "url_verification", challenge: "zz" })) });
    expect((ch.body as any).challenge).toBe("zz");
  });
});

describe("admin manager", () => {
  const answers = { goals: "More subscribers and tidy books", customers: "Home coffee drinkers", tone: "Warm and friendly", financialYearStart: "April", salesTaxRegistered: false, marketingChannels: ["Instagram"], staffCount: 3, hiringSoon: true };
  it("welcomes a new owner with the team and the setup form", async () => {
    const { call, auth } = await signedUp();
    const s = (await call("GET", "/api/setup", undefined, auth)).body as any;
    expect(s.state).toBe("awaiting_form");
    expect(s.messages.map((m: any) => m.kind)).toEqual(["welcome", "form"]);
    expect(s.form.some((f: any) => f.key === "goals" && f.required)).toBe(true);
  });
  it("runs setup from the form, then rolls it back on request", async () => {
    const { call, auth } = await signedUp();
    const bad = await call("POST", "/api/setup", { answers: { tone: "Warm and friendly" } }, auth);
    expect(bad.status).toBe(400);
    const ok = (await call("POST", "/api/setup", { answers }, auth)).body as any;
    expect(ok.run.status).toBe("completed");
    expect(ok.state).toBe("ready");
    expect(ok.messages.at(-1).kind).toBe("ready");
    expect((await call("POST", "/api/setup", { answers }, auth)).status).toBe(400); // already set up
    const undone = (await call("POST", "/api/setup/rollback", undefined, auth)).body as any;
    expect(undone.run.status).toBe("rolled_back");
    expect(undone.state).toBe("awaiting_form");
  });
  it("needs a session", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/setup")).status).toBe(401);
    expect((await call("POST", "/api/setup", { answers: {} })).status).toBe(401);
  });
  it("holds the welcome for Slack until Slack is connected, then sends it", async () => {
    const s = setup();
    const r = await s.call("POST", "/api/signup", { email: "z@z.co", businessName: "Zed", contact: "slack" });
    const auth = { authorization: `Bearer ${(r.body as any).token}` };
    expect(((await s.call("GET", "/api/setup", undefined, auth)).body as any).messages.every((m: any) => m.pendingOn === "slack")).toBe(true);
    const { url } = (await s.call("GET", "/api/slack/install", undefined, auth)).body as any;
    await s.call("GET", "/api/slack/callback", undefined, {}, `code=abc&state=${new URL(url).searchParams.get("state")}`);
    expect(((await s.call("GET", "/api/setup", undefined, auth)).body as any).messages.some((m: any) => m.pendingOn)).toBe(false);
    expect(s.calls.filter((c) => c.url.includes("chat.postMessage")).length).toBe(2);
  });
});

describe("email sign-in", () => {
  const tokenIn = (text: string) => /#token=(\S+)/.exec(text)![1]!;
  const strict = () => setup({ allowDevAuth: false });

  it("sends a link, verifies it once, then signs up with the verified email only", async () => {
    const s = strict();
    expect((await s.call("POST", "/api/signup", { email: "ann@k.co", businessName: "K" })).status).toBe(401); // no shortcut
    expect((await s.call("POST", "/api/signin/start", { email: "Ann@K.co" })).status).toBe(200);
    expect(s.mail.sent).toHaveLength(1);
    expect(s.mail.sent[0]!.to).toBe("ann@k.co");
    expect(s.mail.sent[0]!.text).toContain("https://app.test/signin.html#token=");
    const link = tokenIn(s.mail.sent[0]!.text);
    const v = (await s.call("POST", "/api/signin/verify", { token: link })).body as any;
    expect(v).toMatchObject({ email: "ann@k.co", hasOrganisation: false });
    expect((await s.call("POST", "/api/signin/verify", { token: link })).status).toBe(400); // single use
    const auth = { authorization: `Bearer ${v.token}` };
    // the email in the body is ignored: the verified one wins
    const r = await s.call("POST", "/api/signup", { email: "someone-else@x.co", businessName: "Kestrel" }, auth);
    expect(r.status).toBe(201);
    const again = (await s.call("POST", "/api/signin/start", { email: "ann@k.co" }), tokenIn(s.mail.sent[1]!.text));
    const v2 = (await s.call("POST", "/api/signin/verify", { token: again })).body as any;
    expect(v2.hasOrganisation).toBe(true);
    expect(((await s.call("GET", "/api/org", undefined, { authorization: `Bearer ${v2.token}` })).body as any).name).toBe("Kestrel");
  });

  it("rejects forged, expired and wrong-kind tokens", async () => {
    const s = strict();
    await s.call("POST", "/api/signin/start", { email: "a@b.co" });
    const link = tokenIn(s.mail.sent[0]!.text);
    expect((await s.call("POST", "/api/signin/verify", { token: link.replace(/.$/, "x") })).status).toBe(400);
    s.clock.d = new Date(s.clock.d.getTime() + 16 * 60_000);
    expect((await s.call("POST", "/api/signin/verify", { token: link })).status).toBe(400);
    // a sign-in link is not a session
    expect((await s.call("GET", "/api/org", undefined, { authorization: `Bearer ${link}` })).status).toBe(401);
  });

  it("a Slack install state token cannot be used as a session", async () => {
    const s = await signedUp();
    const { url } = (await s.call("GET", "/api/slack/install", undefined, s.auth)).body as any;
    const state = new URL(url).searchParams.get("state")!;
    expect((await s.call("GET", "/api/org", undefined, { authorization: `Bearer ${state}` })).status).toBe(401);
  });

  it("answers the same for any address, validates it, and limits sends per address", async () => {
    const s = strict();
    expect((await s.call("POST", "/api/signin/start", { email: "nope" })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await s.call("POST", "/api/signin/start", { email: "a@b.co" })).status).toBe(200);
    expect((await s.call("POST", "/api/signin/start", { email: "a@b.co" })).status).toBe(429);
    expect((await s.call("POST", "/api/signin/start", { email: "other@b.co" })).status).toBe(200);
  });

  it("the Resend sender posts the message and reports failures", async () => {
    let seen: any;
    await new ResendEmailSender("key", "MAIZ agents <hi@x.co>", (async (u: any, i: any) => { seen = { u, i }; return { ok: true }; }) as any).send({ to: "a@b.co", subject: "s", text: "t" });
    expect(seen.u).toBe("https://api.resend.com/emails");
    expect(JSON.parse(seen.i.body)).toMatchObject({ from: "MAIZ agents <hi@x.co>", to: ["a@b.co"] });
    await expect(new ResendEmailSender("k", "f", (async () => ({ ok: false, status: 422 })) as any).send({ to: "a", subject: "s", text: "t" })).rejects.toThrow(/422/);
  });
});

describe("business apps API", () => {
  it("imports a till file, posts it to the books, and runs a webhook end to end", async () => {
    const { call, auth } = await signedUp();
    const csv = "Date,Total,VAT\n2026-06-01,120.00,20.00\n2026-06-02,60.00,10.00";
    const imp = await call("POST", "/api/integrations/apps/till-file/import", { csv }, auth);
    expect(imp.status).toBe(200);
    expect((imp.body as any).added).toBe(2);
    const list = (await call("GET", "/api/integrations", undefined, auth)).body as any;
    expect(list.pending).toHaveLength(2);
    expect(list.catalogue.some((c: any) => c.key === "brightpay")).toBe(true);
    expect((await call("POST", "/api/integrations/post", {}, auth)).body).toEqual({ posted: 2, skipped: [] });

    const hook = (await call("POST", "/api/integrations/apps/webhook/connect", {}, auth)).body as any;
    expect(hook.url).toMatch(/^https:\/\/app\.test\/api\/integrations\/hooks\//);
    const path = new URL(hook.url).pathname;
    expect((await call("POST", path, { sales: [{ date: "2026-06-03", gross: 500 }] })).status).toBe(200);
    expect((await call("POST", path.replace(/[^/]+$/, "x".repeat(32)), { sales: [] })).status).toBe(404);
  });
  it("refuses app routes without a session and unknown apps", async () => {
    const { call, auth } = await signedUp();
    expect((await call("GET", "/api/integrations")).status).toBe(401);
    expect((await call("POST", "/api/integrations/apps/nope/import", { csv: "a" }, auth)).status).toBe(400);
    expect((await call("POST", "/api/integrations/apps/square/connect", {}, auth)).status).toBe(400); // no Square app keys in this setup
  });
  it("only accepts a signed connect state on the OAuth return", async () => {
    const { call } = await signedUp();
    expect((await call("GET", "/api/integrations/callback", undefined, {}, "code=x&state=forged")).status).toBe(400);
  });
});
