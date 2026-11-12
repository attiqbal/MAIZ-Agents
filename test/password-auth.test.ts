import { describe, expect, it } from "vitest";
import { createApp, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { limitFor } from "../src/server/rate-limit.js";
import { passwordProblem } from "../src/modules/credentials/index.js";

const GOOD = "correct horse battery";
function setup(over: Record<string, unknown> = {}) {
  const clock = { d: new Date("2026-06-10T10:00:00Z") };
  const mail = new MemoryEmailSender();
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: false, email: mail, appUrl: "https://app.test", now: () => clock.d, platformOwners: ["boss@maiz.co"], ...over } as any);
  const handle = createApp(platform);
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle({ method: "POST", path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const linkIn = (key: string) => new RegExp(`#${key}=(\\S+)`).exec(mail.sent.at(-1)!.text)![1]!;
  return { platform, call, clock, mail, linkIn };
}
/** Registers and confirms an account, returning the session token. */
async function account(s: ReturnType<typeof setup>, email = "ann@k.co", password = GOOD) {
  const reg = await s.call("/api/auth/register", { email, password });
  expect(reg.status).toBe(200);
  const r = await s.call("/api/auth/confirm", { token: s.linkIn("confirm"), bind: (reg.body as any).bind });
  expect(r.status).toBe(200);
  return (r.body as any).token as string;
}

describe("password rules", () => {
  it("explains what is wrong in plain words", () => {
    expect(passwordProblem("short")).toMatch(/at least 8/);
    expect(passwordProblem("x".repeat(129))).toMatch(/at most 128/);
    expect(passwordProblem("password123")).toMatch(/too easy/);
    expect(passwordProblem("aaaaaaaaaa")).toMatch(/too easy/);
    expect(passwordProblem("ann@k.co", "ann@k.co")).toMatch(/email/);
    expect(passwordProblem(undefined)).toMatch(/Enter a password/);
    expect(passwordProblem(GOOD, "ann@k.co")).toBeUndefined();
  });
});

describe("sign up with email and password", () => {
  it("holds the password until the emailed link is opened, then signs in, once", async () => {
    const s = setup();
    const reg = await s.call("/api/auth/register", { email: "Ann@K.co", password: GOOD });
    const bind = (reg.body as any).bind;
    expect(reg.body).toEqual({ ok: true, bind });
    expect(s.mail.sent[0]!.to).toBe("ann@k.co");
    expect(s.mail.sent[0]!.text).toContain("https://app.test/signin.html#confirm=");
    // not an account yet: the password does not work before the link is opened
    expect((await s.call("/api/auth/login", { email: "ann@k.co", password: GOOD })).status).toBe(401);
    const token = s.linkIn("confirm");
    const ok = await s.call("/api/auth/confirm", { token, bind });
    expect(ok.body).toMatchObject({ email: "ann@k.co", hasOrganisation: false, platformOwner: false });
    expect((ok.body as any).token).toBeTruthy();
    expect((await s.call("/api/auth/confirm", { token, bind })).status).toBe(400); // single use
    expect((await s.call("/api/auth/login", { email: "ANN@k.co", password: GOOD })).status).toBe(200);
  });

  it("will not plant a password from another browser, over an existing team, or over an existing password", async () => {
    const s = setup();
    // someone registers with the victim's address; the victim opens the emailed link in a browser that never signed up
    await s.call("/api/auth/register", { email: "vic@k.co", password: "attacker chosen phrase" });
    expect((await s.call("/api/auth/confirm", { token: s.linkIn("confirm"), bind: "" })).status).toBe(400);
    expect((await s.call("/api/auth/login", { email: "vic@k.co", password: "attacker chosen phrase" })).status).toBe(401);
    // an account made with the emailed link and a team already: register only emails them, no confirm link
    await s.call("/api/signin/start", { email: "team@k.co" });
    const magic = /#token=(\S+)/.exec(s.mail.sent.at(-1)!.text)![1]!;
    const v = (await s.call("/api/signin/verify", { token: magic })).body as any;
    await s.call("/api/signup", { businessName: "T" }, { authorization: `Bearer ${v.token}` });
    const n = s.mail.sent.length;
    await s.call("/api/auth/register", { email: "team@k.co", password: "attacker chosen phrase" });
    expect(s.mail.sent.length).toBe(n + 1);
    expect(s.mail.sent.at(-1)!.text).not.toContain("#confirm=");
  });

  it("ends sessions started before a password reset", async () => {
    const s = setup();
    const old = await account(s);
    s.clock.d = new Date(s.clock.d.getTime() + 5000);
    await s.call("/api/auth/forgot", { email: "ann@k.co" });
    await s.call("/api/auth/reset", { token: s.linkIn("reset"), password: "a brand new phrase" });
    expect((await s.call("/api/signup", { businessName: "K" }, { authorization: `Bearer ${old}` })).status).toBe(401);
  });

  it("session from the password works for signing up a team", async () => {
    const s = setup();
    const token = await account(s);
    const r = await s.call("/api/signup", { businessName: "Kestrel", sells: "Coffee" }, { authorization: `Bearer ${token}` });
    expect(r.status).toBe(201);
    const login = await s.call("/api/auth/login", { email: "ann@k.co", password: GOOD });
    expect((login.body as any).hasOrganisation).toBe(true);
  });

  it("rejects a bad email or weak password with a message", async () => {
    const s = setup();
    expect(await s.call("/api/auth/register", { email: "nope", password: GOOD })).toMatchObject({ status: 400, body: { field: "email" } });
    expect(await s.call("/api/auth/register", { email: "a@b.co", password: "short" })).toMatchObject({ status: 400, body: { field: "password" } });
    expect(s.mail.sent).toHaveLength(0);
  });

  it("gives the same answer for an address that already has an account, and tells that person by email", async () => {
    const s = setup();
    await account(s);
    const again = await s.call("/api/auth/register", { email: "ann@k.co", password: "another long one" });
    expect(Object.keys(again.body as object).sort()).toEqual(["bind", "dev", "ok"].filter((k) => k in (again.body as object)));
    expect((again.body as any).ok).toBe(true);
    expect(s.mail.sent.at(-1)!.subject).toMatch(/already have/);
    expect(s.mail.sent.at(-1)!.text).not.toContain("#confirm=");
    // the old password still works, the new one does not
    expect((await s.call("/api/auth/login", { email: "ann@k.co", password: GOOD })).status).toBe(200);
    expect((await s.call("/api/auth/login", { email: "ann@k.co", password: "another long one" })).status).toBe(401);
  });

  it("limits confirmation emails per address and refuses expired or forged links", async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) expect((await s.call("/api/auth/register", { email: "a@b.co", password: GOOD })).status).toBe(200);
    expect((await s.call("/api/auth/register", { email: "a@b.co", password: GOOD })).status).toBe(429);
    const t = s.linkIn("confirm");
    expect((await s.call("/api/auth/confirm", { token: t.replace(/.$/, "x") })).status).toBe(400);
    s.clock.d = new Date(s.clock.d.getTime() + 2 * 3_600_000);
    expect((await s.call("/api/auth/confirm", { token: t })).status).toBe(400);
  });

  it("returns the link directly in development, never for a platform owner", async () => {
    const dev = setup({ allowDevAuth: true });
    const r = await dev.call("/api/auth/register", { email: "d@x.co", password: GOOD });
    expect((r.body as any).devLink).toBeTruthy();
    expect((await dev.call("/api/auth/confirm", { token: (r.body as any).devLink, bind: (r.body as any).bind })).status).toBe(200);
    expect((await dev.call("/api/auth/register", { email: "boss@maiz.co", password: GOOD })).status).toBe(403);
    expect((await dev.call("/api/auth/forgot", { email: "boss@maiz.co" })).body).not.toHaveProperty("devLink");
  });
});

describe("log in", () => {
  it("never says whether the email or the password was wrong", async () => {
    const s = setup();
    await account(s);
    const wrongPw = await s.call("/api/auth/login", { email: "ann@k.co", password: "not the one" });
    const noUser = await s.call("/api/auth/login", { email: "ghost@k.co", password: "not the one" });
    expect(wrongPw.status).toBe(401);
    expect((wrongPw.body as any).error).toBe((noUser.body as any).error);
    expect((await s.call("/api/auth/login", { email: "ann@k.co" })).status).toBe(400);
  });

  it("locks an address after five wrong passwords, even for the right one, until the window passes", async () => {
    const s = setup();
    await account(s);
    for (let i = 0; i < 5; i++) expect((await s.call("/api/auth/login", { email: "ann@k.co", password: `wrong-${i}-pass` })).status).toBe(401);
    expect((await s.call("/api/auth/login", { email: "ann@k.co", password: GOOD })).status).toBe(429);
    expect((await s.call("/api/auth/login", { email: "other@k.co", password: GOOD })).status).toBe(401); // others unaffected
    s.clock.d = new Date(s.clock.d.getTime() + 16 * 60_000);
    expect((await s.call("/api/auth/login", { email: "ann@k.co", password: GOOD })).status).toBe(200);
  });

  it("keeps platform owners on the emailed link", async () => {
    const s = setup();
    expect((await s.call("/api/auth/login", { email: "boss@maiz.co", password: GOOD })).status).toBe(403);
    expect((await s.call("/api/auth/register", { email: "boss@maiz.co", password: GOOD })).status).toBe(403);
    await s.call("/api/auth/forgot", { email: "boss@maiz.co" });
    expect(s.mail.sent).toHaveLength(0);
  });

  it("is rate limited by address on top of the per-email lock", () => {
    for (const path of ["/api/auth/login", "/api/auth/register", "/api/auth/forgot", "/api/auth/reset", "/api/auth/confirm"]) {
      expect(limitFor("POST", path)).toEqual({ max: 15, windowMs: 600_000 });
    }
  });
});

describe("forgot and first-time password", () => {
  it("emails a one-time link that sets the password and signs in; the old password stops working", async () => {
    const s = setup();
    await account(s);
    expect((await s.call("/api/auth/forgot", { email: "Ann@k.co" })).body).toEqual({ ok: true });
    expect(s.mail.sent.at(-1)!.text).toContain("https://app.test/signin.html#reset=");
    const token = s.linkIn("reset");
    expect((await s.call("/api/auth/reset", { token, password: "short" })).status).toBe(400); // weak: link not spent
    const done = await s.call("/api/auth/reset", { token, password: "a brand new phrase" });
    expect(done.status).toBe(200);
    expect((done.body as any).token).toBeTruthy();
    expect((await s.call("/api/auth/reset", { token, password: "yet another phrase" })).status).toBe(400); // once
    expect((await s.call("/api/auth/login", { email: "ann@k.co", password: GOOD })).status).toBe(401);
    expect((await s.call("/api/auth/login", { email: "ann@k.co", password: "a brand new phrase" })).status).toBe(200);
  });

  it("lets an existing email-link account set a password and a reset clears a lock", async () => {
    const s = setup();
    // an account made the old way: only the emailed sign-in link
    await s.call("/api/signin/start", { email: "old@k.co" });
    const magic = /#token=(\S+)/.exec(s.mail.sent[0]!.text)![1]!;
    expect((await s.call("/api/signin/verify", { token: magic })).status).toBe(200);
    expect((await s.call("/api/auth/login", { email: "old@k.co", password: GOOD })).status).toBe(401);
    await s.call("/api/auth/forgot", { email: "old@k.co" });
    expect((await s.call("/api/auth/reset", { token: s.linkIn("reset"), password: GOOD })).status).toBe(200);
    expect((await s.call("/api/auth/login", { email: "old@k.co", password: GOOD })).status).toBe(200);
  });

  it("answers the same for unknown addresses, limits emails, and refuses a confirm link as a reset link", async () => {
    const s = setup();
    expect((await s.call("/api/auth/forgot", { email: "nobody@k.co" })).body).toEqual({ ok: true });
    for (let i = 0; i < 2; i++) await s.call("/api/auth/forgot", { email: "nobody@k.co" });
    expect((await s.call("/api/auth/forgot", { email: "nobody@k.co" })).status).toBe(429);
    expect((await s.call("/api/auth/forgot", { email: "bad" })).status).toBe(400);
    await s.call("/api/auth/register", { email: "r@k.co", password: GOOD });
    expect((await s.call("/api/auth/reset", { token: s.linkIn("confirm"), password: GOOD })).status).toBe(400);
  });
});

describe("change password while logged in", () => {
  it("needs the current password once one exists", async () => {
    const s = setup();
    const token = await account(s);
    const auth = { authorization: `Bearer ${token}` };
    expect((await s.call("/api/auth/password", { password: "a brand new phrase" })).status).toBe(401);
    expect((await s.call("/api/auth/password", { password: "a brand new phrase" }, auth)).status).toBe(401);
    expect((await s.call("/api/auth/password", { current: GOOD, password: "short" }, auth)).status).toBe(400);
    expect((await s.call("/api/auth/password", { current: GOOD, password: "a brand new phrase" }, auth)).status).toBe(200);
    expect((await s.call("/api/auth/login", { email: "ann@k.co", password: "a brand new phrase" })).status).toBe(200);
  });
});
