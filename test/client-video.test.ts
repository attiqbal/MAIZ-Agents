import { describe, expect, it } from "vitest";
import { cleanBrand, VideoError } from "../src/modules/video/index.js";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";

const KEY = "creatomate-key-0123456789abcdef";
const TEMPLATE = "tmpl-1234-abcd";
const OWNER = "atif@maiz.test";

async function site(opts: { key?: boolean } = {}) {
  const calls: { url: string; body: string }[] = [];
  const http = (async (url: any, init: any = {}) => {
    calls.push({ url: String(url), body: String(init.body ?? "") });
    if (String(url).includes("creatomate.com") && String(url).includes("/renders/")) return new Response(JSON.stringify({ id: "render-1", status: "succeeded", url: "https://cdn.test/v.mp4" }));
    return new Response(JSON.stringify([{ id: "render-1", status: "planned" }]));
  }) as unknown as typeof fetch;
  const platform = createPlatform({ sessionSecret: "s5", allowDevAuth: true, appUrl: "https://app.test", now: () => new Date("2026-11-17T10:00:00Z"), http, platformOwners: [OWNER] });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  if (opts.key) {
    const owner = { authorization: `Bearer ${makeToken("s5", { k: "session", u: userIdFor(OWNER), e: OWNER }, 86400, Date.parse("2026-11-17T10:00:00Z"))}` };
    await call("PUT", "/api/owner/connections/creatomate", { fields: { apiKey: KEY } }, owner);
  }
  const client = async (email = "ann@kestrel.co", name = "Kestrel Coffee") => {
    const su = await call("POST", "/api/signup", { email, businessName: name, sells: "Coffee", size: "2–10", country: "GB" });
    const auth = { authorization: `Bearer ${(su.body as any).token}` };
    const org = (await call("GET", "/api/org", undefined, auth)).body as any;
    return { auth, marketing: org.team.find((e: any) => e.templateKey === "marketing-manager").id as string };
  };
  return { call, client, calls, platform };
}

describe("brand details", () => {
  it("accepts a colour code and a public https logo, and refuses anything else", () => {
    expect(cleanBrand({ name: "Kestrel", colour: "#1F7A3D", logoUrl: "https://kestrel.co/logo.png", tagline: " Fresh  roast " })).toEqual({ name: "Kestrel", colour: "#1f7a3d", logoUrl: "https://kestrel.co/logo.png", tagline: "Fresh roast" });
    expect(() => cleanBrand({ colour: "green" })).toThrow(VideoError);
    expect(() => cleanBrand({ logoUrl: "http://kestrel.co/logo.png" })).toThrow(VideoError);
    expect(() => cleanBrand({ logoUrl: "javascript:alert(1)" })).toThrow(VideoError);
  });
});

describe("client video over the API", () => {
  it("shows the cost first, makes a practice video when no service is connected, and waits for approval", async () => {
    const s = await site();
    const c = await s.client();
    await s.call("POST", "/api/video/brand", { name: "Kestrel Coffee", colour: "#1f7a3d", tagline: "Fresh roast" }, c.auth);
    const view = (await s.call("GET", "/api/video", undefined, c.auth)).body as any;
    const creatomate = view.services.find((x: any) => x.key === "creatomate");
    expect(creatomate).toMatchObject({ connected: false, quote: { energy: 200, multiplier: 2, simulated: true, charge: 0 } });
    expect(view.listed.some((x: any) => x.key === "canva")).toBe(true);

    const body = { employeeId: c.marketing, title: "Autumn blend", service: "creatomate", templateId: TEMPLATE, fields: { Subtitle: "Out Thursday" }, brandSlots: { Title: "name", Accent: "colour" } };
    const ask = await s.call("POST", "/api/video", body, c.auth);
    expect(ask.status).toBe(409);
    expect((ask.body as any).quote.energy).toBe(200);

    const made = await s.call("POST", "/api/video", { ...body, confirmEnergy: 0 }, c.auth);
    expect(made.status).toBe(201);
    const draft = (made.body as any).draft;
    expect(draft).toMatchObject({ status: "ready", simulated: true, energy: 0, fields: { Title: "Kestrel Coffee", Accent: "#1f7a3d", Subtitle: "Out Thursday" } });
    expect(s.calls.filter((x) => x.url.includes("creatomate"))).toHaveLength(0);

    const approved = await s.call("POST", `/api/video/${draft.id}/decide`, { approve: true }, c.auth);
    expect((approved.body as any).draft.status).toBe("approved");
    // Decided once only.
    expect((await s.call("POST", `/api/video/${draft.id}/decide`, { approve: false }, c.auth)).status).toBe(400);
  });

  it("charges double energy from the team pool once a key is saved, and refuses a wrong figure", async () => {
    const s = await site({ key: true });
    const c = await s.client();
    const before = ((await s.call("GET", "/api/video", undefined, c.auth)).body as any).team;
    const body = { employeeId: c.marketing, title: "Sale", service: "creatomate", templateId: TEMPLATE, fields: { Title: "Sale" } };
    expect((await s.call("POST", "/api/video", { ...body, confirmEnergy: 100 }, c.auth)).status).toBe(409);
    const made = await s.call("POST", "/api/video", { ...body, confirmEnergy: 200 }, c.auth);
    expect(made.status).toBe(201);
    expect((made.body as any).draft).toMatchObject({ energy: 200, simulated: false, status: "rendering" });
    expect(s.calls.filter((x) => x.url.includes("creatomate")).length).toBeGreaterThan(0);
    const after = (made.body as any).team;
    expect(after.left ?? after.poolLeft).toBeLessThan(before.left ?? before.poolLeft);
    const id = (made.body as any).draft.id;
    const done = await s.call("POST", `/api/video/${id}/refresh`, {}, c.auth);
    expect((done.body as any).draft).toMatchObject({ status: "ready", url: "https://cdn.test/v.mp4" });
  });

  it("refuses a brand slot that has no saved detail, a rejected video, and another business's employee", async () => {
    const s = await site();
    const ann = await s.client();
    const bob = await s.client("bob@other.co", "Other Shop");
    const body = { employeeId: ann.marketing, service: "creatomate", templateId: TEMPLATE, confirmEnergy: 0 };
    expect((await s.call("POST", "/api/video", { ...body, brandSlots: { Logo: "logo" } }, ann.auth)).status).toBe(400);
    expect((await s.call("POST", "/api/video", { ...body, fields: { T: "x" } }, bob.auth)).status).toBe(400);
    const made = await s.call("POST", "/api/video", { ...body, fields: { T: "x" } }, ann.auth);
    const id = (made.body as any).draft.id;
    expect((await s.call("POST", `/api/video/${id}/decide`, { approve: false, note: "Too busy" }, bob.auth)).status).toBe(400);
    const no = await s.call("POST", `/api/video/${id}/decide`, { approve: false, note: "Too busy" }, ann.auth);
    expect((no.body as any).draft).toMatchObject({ status: "rejected" });
    // Saying no teaches the team: the note becomes a preference.
    const learned = ((await s.call("GET", "/api/learning", undefined, ann.auth)).body as any).lessons.map((l: any) => l.text);
    expect(learned).toContain("Too busy");
    expect(((await s.call("GET", "/api/video", undefined, bob.auth)).body as any).videos).toEqual([]);
    expect((await s.call("DELETE", `/api/video/${id}`, undefined, ann.auth)).status).toBe(200);
  });
});
