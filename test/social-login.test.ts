import { describe, expect, it } from "vitest";
import { createApp, makeToken, readToken, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { checkEnv } from "../src/server/config.js";
import { attemptSecrets, loginAppsFromEnv, loginRedirectUri } from "../src/server/social-login.js";

const SECRET = "s3";
const NOW = new Date("2026-11-11T10:00:00Z");
const TENANT = "11111111-2222-3333-4444-555555555555";
const PERSONAL = "9188040d-6c67-4c5b-b112-36a304b66dad";

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

/** A fake Google/Microsoft token endpoint. `claims` get the right nonce and audience unless overridden. */
function setup(claimsFor: (nonce: string) => Record<string, unknown> | "error", provider: "google" | "microsoft" = "google") {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const http = (async (url: string, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    calls.push({ url, body });
    const nonce = lastNonce;
    const c = claimsFor(nonce);
    if (c === "error") return new Response("{}", { status: 400 });
    return new Response(JSON.stringify({ id_token: jwt(c) }), { status: 200 });
  }) as typeof fetch;
  let lastNonce = "";
  const platform = createPlatform({
    sessionSecret: SECRET, allowDevAuth: false, email: new MemoryEmailSender(), appUrl: "https://app.test", platformOwners: ["atif@maiz.test"], now: () => NOW, http,
    loginApps: { google: { clientId: "g-id", clientSecret: "g-secret" }, microsoft: { clientId: "m-id", clientSecret: "m-secret", tenant: "common" } },
  });
  const handle = createApp(platform);
  const call = (path: string, query: Record<string, string> = {}, headers: Record<string, string> = {}, method = "GET", body?: unknown) =>
    handle({ method, path, query: new URLSearchParams(query), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);

  /** Presses "continue with …" and returns what the provider would send back, plus the cookie the browser holds. */
  const begin = async () => {
    const start = await call(`/api/signin/oauth/${provider}/start`);
    expect(start.status).toBe(302);
    const url = new URL(start.headers!.location!);
    const cookie = start.headers!["set-cookie"]!.split(";")[0]!;
    const state = url.searchParams.get("state")!;
    lastNonce = url.searchParams.get("nonce")!;
    return { url, cookie, state };
  };
  const finish = (b: { cookie: string; state: string }, code = "the-code", extra: Record<string, string> = {}) =>
    call(`/api/signin/oauth/${provider}/callback`, { code, state: b.state, ...extra }, { cookie: b.cookie });
  return { call, begin, finish, calls, platform };
}

const goodGoogle = (extra: Record<string, unknown> = {}) => (nonce: string) => ({ iss: "https://accounts.google.com", aud: "g-id", exp: NOW.getTime() / 1000 + 600, nonce, email: "Ann@Kestrel.co", email_verified: true, ...extra });
const goodMicrosoft = (extra: Record<string, unknown> = {}) => (nonce: string) => ({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT, aud: "m-id", exp: NOW.getTime() / 1000 + 600, nonce, email: "ann@kestrel.co", xms_edov: true, ...extra });

describe("which sign-in buttons exist", () => {
  it("lists only the providers that are switched on", async () => {
    const s = setup(goodGoogle());
    expect((await s.call("/api/signin/providers")).body).toEqual({ providers: ["google", "microsoft"] });
    const off = createApp(createPlatform({ sessionSecret: SECRET, allowDevAuth: false, appUrl: "https://app.test", now: () => NOW }));
    const r = await off({ method: "GET", path: "/api/signin/providers", query: new URLSearchParams(), headers: {}, rawBody: "" });
    expect(r.body).toEqual({ providers: [] });
    expect((await off({ method: "GET", path: "/api/signin/oauth/google/start", query: new URLSearchParams(), headers: {}, rawBody: "" })).status).toBe(404);
  });
  it("uses the __Host- cookie over https, and refuses odd tenant names", async () => {
    const s = setup(goodGoogle());
    expect((await s.call("/api/signin/oauth/google/start")).headers!["set-cookie"]).toMatch(/^__Host-maiz_login=[0-9a-f]{48}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
    expect(loginAppsFromEnv({ MICROSOFT_CLIENT_ID: "a", MICROSOFT_CLIENT_SECRET: "b", MICROSOFT_TENANT: ".." }).microsoft!.tenant).toBe("common");
  });
  it("reads providers from the environment and needs both halves", () => {
    expect(loginAppsFromEnv({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" })).toEqual({ google: { clientId: "a", clientSecret: "b" } });
    expect(loginAppsFromEnv({ GOOGLE_CLIENT_ID: "a" })).toEqual({});
    expect(loginAppsFromEnv({ MICROSOFT_CLIENT_ID: "a", MICROSOFT_CLIENT_SECRET: "b", MICROSOFT_TENANT: "../evil" }).microsoft!.tenant).toBe("common");
    expect(checkEnv({ GOOGLE_CLIENT_ID: "a", APP_URL: "https://x.co" }).join()).toMatch(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together/);
    expect(checkEnv({ MICROSOFT_CLIENT_ID: "a", MICROSOFT_CLIENT_SECRET: "b" }).join()).toMatch(/APP_URL is required for Google or Microsoft/);
  });
});

describe("continue with Google", () => {
  it("sends the browser to Google with PKCE, a nonce and a signed state, and keeps the secrets off the page", async () => {
    const s = setup(goodGoogle());
    const { url, cookie, state } = await s.begin();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe(loginRedirectUri("https://app.test", "google"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid email");
    const held = cookie.split("=")[1]!;
    const mine = attemptSecrets(SECRET, held);
    // The cookie value is random and never appears in the URL; the state holds only a hash of it.
    expect(readToken(SECRET, state, NOW.getTime())).toMatchObject({ k: "login-oauth", pr: "google", b: mine.binding });
    expect(url.toString()).not.toContain(held);
    expect(url.toString()).not.toContain("g-secret");
    expect(mine.challenge).toBe(url.searchParams.get("code_challenge"));
    expect(url.searchParams.get("nonce")).toBe(mine.idNonce);
    expect(url.toString()).not.toContain(mine.verifier);
  });

  it("turns a verified Google email into the same one-time link an emailed sign-in gives", async () => {
    const s = setup(goodGoogle());
    const b = await s.begin();
    const r = await s.finish(b);
    expect(r.status).toBe(302);
    const link = r.headers!.location!;
    expect(link).toMatch(/^\/signin\.html#token=/);
    const token = link.split("#token=")[1]!;
    expect(readToken(SECRET, token, NOW.getTime())).toMatchObject({ k: "magic", e: "ann@kestrel.co", exp: NOW.getTime() / 1000 + 120 }); // short-lived: the page redeems it at once
    // The code goes to Google with the secret and the verifier, from the server only.
    expect(s.calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(s.calls[0]!.body.get("client_secret")).toBe("g-secret");
    expect(s.calls[0]!.body.get("code_verifier")).toBe(attemptSecrets(SECRET, b.cookie.split("=")[1]!).verifier);
    // And that link signs in for real, once.
    const verify = await s.call("/api/signin/verify", {}, {}, "POST", { token });
    expect(verify.status).toBe(200);
    expect((verify.body as any).email).toBe("ann@kestrel.co");
    expect((await s.call("/api/signin/verify", {}, {}, "POST", { token })).status).toBe(400);
  });

  it.each([
    ["an unverified email", { email_verified: false }, "unverified"],
    ["another app's token", { aud: "someone-else" }, "failed"],
    ["a token from another issuer", { iss: "https://evil.example" }, "failed"],
    ["an expired token", { exp: NOW.getTime() / 1000 - 5 }, "failed"],
    ["a replayed token (wrong nonce)", { nonce: "other" }, "failed"],
    ["no email", { email: undefined }, "failed"],
  ])("refuses %s", async (_label, extra, problem) => {
    const s = setup(goodGoogle(extra));
    const r = await s.finish(await s.begin());
    expect(r.headers!.location).toBe(`/signin.html?error=${problem}`);
  });

  it("refuses a callback that this browser did not start, or that was already used", async () => {
    const s = setup(goodGoogle());
    const b = await s.begin();
    const other = await s.finish({ ...b, cookie: "__Host-maiz_login=wrong" });
    expect(other.headers!.location).toBe("/signin.html?error=failed");
    expect((await s.call("/api/signin/oauth/google/callback", { code: "x", state: b.state })).headers!.location).toBe("/signin.html?error=failed"); // no cookie at all
    // A state signed for something else (a business-app connect link) is not a sign-in.
    const alien = makeToken(SECRET, { k: "int-oauth", u: "u", a: "xero", n: "n" }, 600, NOW.getTime());
    expect((await s.call("/api/signin/oauth/google/callback", { code: "x", state: alien }, { cookie: b.cookie })).headers!.location).toBe("/signin.html?error=failed");
    expect(s.calls).toHaveLength(0); // nothing was sent to Google
    expect((await s.finish(b)).headers!.location).toMatch(/#token=/);
    expect((await s.finish(b)).headers!.location).toBe("/signin.html?error=failed"); // once only
    const forged = await s.call("/api/signin/oauth/google/callback", { code: "x", state: "nope.nope" }, { cookie: b.cookie });
    expect(forged.headers!.location).toBe("/signin.html?error=failed");
  });

  it("does not take a state that was made for the other provider", async () => {
    const s = setup(goodGoogle());
    const b = await s.begin();
    const r = await s.call("/api/signin/oauth/microsoft/callback", { code: "x", state: b.state }, { cookie: b.cookie });
    expect(r.headers!.location).toBe("/signin.html?error=failed");
  });

  it("says so when the person pressed cancel, and when Google is down", async () => {
    const s = setup(goodGoogle());
    const b = await s.begin();
    const r = await s.call("/api/signin/oauth/google/callback", { error: "access_denied", state: b.state }, { cookie: b.cookie });
    expect(r.headers!.location).toBe("/signin.html?error=cancelled");
    const down = setup(() => "error");
    expect((await down.finish(await down.begin())).headers!.location).toBe("/signin.html?error=failed");
  });

  it("never signs the platform owner in this way: that always needs the emailed link", async () => {
    const s = setup(goodGoogle({ email: "atif@maiz.test" }));
    const r = await s.finish(await s.begin());
    expect(r.headers!.location).toBe("/signin.html?error=owner");
  });
});

describe("continue with Microsoft", () => {
  it("accepts a work account only when Microsoft says the email's domain is verified", async () => {
    const ok = setup(goodMicrosoft(), "microsoft");
    const b = await ok.begin();
    expect(b.url.origin + b.url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect((await ok.finish(b)).headers!.location).toMatch(/#token=/);

    // Anyone can type any email into their own tenant: an unverified `email` claim proves nothing.
    const spoof = setup(goodMicrosoft({ xms_edov: undefined, email: "ceo@victim.co" }), "microsoft");
    expect((await spoof.finish(await spoof.begin())).headers!.location).toBe("/signin.html?error=unverified");
    const noEmail = setup(goodMicrosoft({ email: undefined }), "microsoft");
    expect((await noEmail.finish(await noEmail.begin())).headers!.location).toBe("/signin.html?error=unverified");
  });

  it("accepts a personal Microsoft account, and refuses a token whose issuer does not match its tenant", async () => {
    const personal = setup(goodMicrosoft({ tid: PERSONAL, iss: `https://login.microsoftonline.com/${PERSONAL}/v2.0`, xms_edov: undefined }), "microsoft");
    expect((await personal.finish(await personal.begin())).headers!.location).toMatch(/#token=/);
    for (const extra of [{ nonce: "other" }, { aud: "someone-else" }, { exp: NOW.getTime() / 1000 - 1 }]) {
      const bad = setup(goodMicrosoft(extra), "microsoft");
      expect((await bad.finish(await bad.begin())).headers!.location, JSON.stringify(extra)).toBe("/signin.html?error=failed");
    }
    const falseEdov = setup(goodMicrosoft({ xms_edov: "false" }), "microsoft");
    expect((await falseEdov.finish(await falseEdov.begin())).headers!.location).toBe("/signin.html?error=unverified");
    const arrayAud = setup(goodMicrosoft({ aud: ["x", "m-id"] }), "microsoft");
    expect((await arrayAud.finish(await arrayAud.begin())).headers!.location).toMatch(/#token=/);
    const mismatch = setup(goodMicrosoft({ iss: "https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555/v2.0" }), "microsoft");
    expect((await mismatch.finish(await mismatch.begin())).headers!.location).toBe("/signin.html?error=failed");
  });
});
