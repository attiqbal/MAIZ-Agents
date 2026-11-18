import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { checkEnv, openModeWarnings } from "../src/server/config.js";

const OWNER = "atif@maiz.test";

function setup(signupMode?: "interest" | "open") {
  const mail = new MemoryEmailSender();
  const clock = { d: new Date("2026-11-17T12:00:00Z") };
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: mail, appUrl: "https://app.test", platformOwners: [OWNER], signupMode, now: () => clock.d });
  const handle = createApp(platform);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
    await res.after?.();
    return res;
  };
  const bearer = (email: string) => ({ authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(email), e: email }, 7 * 86400, clock.d.getTime())}` });
  return { call, mail, owner: bearer(OWNER), other: bearer("someone@else.test") };
}
const form = { name: "Dana", email: "Dana@Shop.test", business: "Dana's Bakery", need: "Help with invoices", source: "/pricing.html" };

describe("register your interest", () => {
  it("stores the person, thanks them and tells the owner", async () => {
    const { call, mail, owner } = setup("interest");
    const res = await call("POST", "/api/interest", form);
    expect(res.status).toBe(201);
    const list = (await call("GET", "/api/owner/interest", undefined, owner)).body as any;
    expect(list.people).toHaveLength(1);
    expect(list.people[0]).toMatchObject({ email: "dana@shop.test", name: "Dana", business: "Dana's Bakery", source: "/pricing.html" });
    const sent = mail.sent.map((m) => m.to).sort();
    expect(sent).toEqual(["atif@maiz.test", "dana@shop.test"]);
  });

  it("does not list or thank the same address twice", async () => {
    const { call, mail, owner } = setup("interest");
    await call("POST", "/api/interest", form);
    await call("POST", "/api/interest", { ...form, need: "Also payroll" });
    const list = (await call("GET", "/api/owner/interest", undefined, owner)).body as any;
    expect(list.people).toHaveLength(1);
    expect(list.people[0].need).toBe("Also payroll");
    expect(mail.sent.filter((m) => m.to === "dana@shop.test")).toHaveLength(1);
  });

  it("refuses a bad email or a missing name, and stores nothing from a bot", async () => {
    const { call, owner } = setup("interest");
    expect((await call("POST", "/api/interest", { ...form, email: "nope" })).status).toBe(400);
    expect((await call("POST", "/api/interest", { ...form, name: " " })).status).toBe(400);
    expect((await call("POST", "/api/interest", { ...form, company_site: "http://spam" })).status).toBe(201);
    expect(((await call("GET", "/api/owner/interest", undefined, owner)).body as any).people).toHaveLength(0);
  });

  it("limits tries per address", async () => {
    const { call } = setup("interest");
    for (let i = 0; i < 3; i++) expect((await call("POST", "/api/interest", form)).status).toBe(201);
    expect((await call("POST", "/api/interest", form)).status).toBe(429);
  });

  it("removes someone on request, and keeps them off the list", async () => {
    const { call, owner, other } = setup("interest");
    await call("POST", "/api/interest", form);
    expect((await call("POST", "/api/owner/interest/remove", { email: "dana@shop.test" }, other)).status).toBe(403);
    expect((await call("POST", "/api/owner/interest/remove", { email: "dana@shop.test" }, owner)).status).toBe(200);
    expect((await call("POST", "/api/owner/interest/remove", { email: "dana@shop.test" }, owner)).status).toBe(404);
    expect(((await call("GET", "/api/owner/interest", undefined, owner)).body as any).people).toHaveLength(0);
  });

  it("shows the list only to the platform owner", async () => {
    const { call, other } = setup("interest");
    expect((await call("GET", "/api/owner/interest", undefined, other)).status).toBe(403);
    expect((await call("GET", "/api/owner/interest")).status).toBe(401);
  });
});

describe("signup switch", () => {
  const signup = { businessName: "Dana's Bakery" };
  it("reports the mode", async () => {
    expect(((await setup("interest").call("GET", "/api/signup/mode")).body as any).mode).toBe("interest");
    expect(((await setup("open").call("GET", "/api/signup/mode")).body as any).mode).toBe("open");
  });
  it("blocks account creation before launch, except for the platform owner", async () => {
    const { call, other, owner } = setup("interest");
    expect((await call("POST", "/api/signup", signup, other)).status).toBe(403);
    expect((await call("POST", "/api/signup", signup, owner)).status).toBe(201);
  });
  it("lets anyone with a verified email sign up when open", async () => {
    const { call, other } = setup("open");
    expect((await call("POST", "/api/signup", signup, other)).status).toBe(201);
  });
  it("rejects a mistyped SIGNUP_MODE at start-up", () => {
    expect(checkEnv({ SIGNUP_MODE: "soon" }).join(" ")).toMatch(/SIGNUP_MODE/);
    expect(checkEnv({ SIGNUP_MODE: "open" }).join(" ")).not.toMatch(/SIGNUP_MODE/);
  });
});

describe("opening signup", () => {
  const live = { NODE_ENV: "production", SIGNUP_MODE: "open", PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_abc", GOOGLE_CLIENT_ID: "g", CONTACT_EMAIL: "hi@maiz.test", RUNPOD_API_KEY: "r" };
  it("has nothing to say when everything is set, or while still pre-launch", () => {
    expect(openModeWarnings(live)).toEqual([]);
    expect(openModeWarnings({ ...live, SIGNUP_MODE: "interest", PAYMENTS_PROVIDER: "" })).toEqual([]);
  });
  it("warns about payments, sign-in and contact address without blocking start-up", () => {
    const w = openModeWarnings({ NODE_ENV: "production", SIGNUP_MODE: "open" }).join("\n");
    expect(w).toMatch(/PAYMENTS_PROVIDER/);
    expect(w).toMatch(/Google or Microsoft/);
    expect(w).toMatch(/CONTACT_EMAIL/);
    expect(openModeWarnings({ ...live, STRIPE_SECRET_KEY: "sk_test_x" }).join()).toMatch(/test key/);
  });
});
