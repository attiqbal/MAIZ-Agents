import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";

// The four outside-service cards on the owner Connections page: typed keys, tests and what the toolbox reads back.
const OWNER = "atif@maiz.test";
const now = new Date("2026-11-20T09:00:00Z");
const KEYS = {
  elevenlabs: { apiKey: "sk_abcdef0123456789abcdef0123456789" },
  "brave-search": { apiKey: "BSAabcdef0123456789abcdef" },
  pexels: { apiKey: "abcdefghij0123456789abcdefghij0123456789" },
  unsplash: { accessKey: "abcdefghij0123456789-_abcdefghij" },
} as const;

interface Call { url: string; headers: Record<string, string> }

function setup(answer: (c: Call) => { status?: number; json?: unknown } = () => ({ json: {} })) {
  const calls: Call[] = [];
  const http = (async (url: any, init: any = {}) => {
    const c: Call = { url: String(url), headers: init.headers ?? {} };
    calls.push(c);
    const a = answer(c);
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  }) as typeof fetch;
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, platformOwners: [OWNER], appUrl: "https://maizagents.com", now: () => now, http });
  const app = createApp(platform);
  const owner = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(OWNER), e: OWNER }, 86400, now.getTime())}` };
  const call = (method: string, path: string, body?: unknown) =>
    app({ method, path, query: new URLSearchParams(), headers: owner, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const card = async (key: string) => ((await call("GET", "/api/owner/connections")).body as any).connections.find((c: any) => c.key === key);
  return { platform, call, calls, card };
}

describe("Toolbox cards on the Connections page", () => {
  it("lists all four as optional platform cards that can be edited in the browser", async () => {
    const { card } = setup();
    for (const key of Object.keys(KEYS)) {
      const c = await card(key);
      expect(c, key).toBeTruthy();
      expect(c.editable).toBe(true);
      expect(c.tier).toBe("optional");
    }
  });

  it("refuses a key of the wrong shape and says what it should look like", async () => {
    const { call } = setup();
    const bad = await call("PUT", "/api/owner/connections/elevenlabs", { fields: { apiKey: "not a key" } });
    expect(bad.status).toBe(400);
    expect((bad.body as any).error).toMatch(/sk_/);
    expect((await call("PUT", "/api/owner/connections/unsplash", { fields: { accessKey: "short" } })).status).toBe(400);
  });

  it("stores typed keys, never echoes them, and hands them to the toolbox", async () => {
    const { platform, call, card } = setup();
    for (const [key, fields] of Object.entries(KEYS)) {
      const r = await call("PUT", `/api/owner/connections/${key}`, { fields });
      expect(r.status, key).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain(Object.values(fields)[0]);
      expect((await card(key)).status).toBe("connected");
    }
    expect(platform.connections.toolKeys()).toEqual({
      elevenlabs: KEYS.elevenlabs.apiKey, braveSearch: KEYS["brave-search"].apiKey, pexels: KEYS.pexels.apiKey, unsplash: KEYS.unsplash.accessKey,
    });
  });

  it("tests each key with one small read and reports success", async () => {
    const { call, calls, card } = setup((c) => {
      if (c.url.includes("elevenlabs")) return { json: { voices: [{ voice_id: "v1", name: "Ada" }] } };
      if (c.url.includes("brave")) return { json: { web: { results: [{ title: "Coffee", url: "https://example.com/c", description: "x" }] } } };
      if (c.url.includes("pexels")) return { json: { photos: [{ id: 1, url: "https://www.pexels.com/photo/1/", photographer: "A", photographer_url: "https://www.pexels.com/@a", src: { large: "https://images.pexels.com/1.jpg" } }] } };
      return { json: { results: [{ id: "u1", links: { html: "https://unsplash.com/photos/u1", download_location: "https://api.unsplash.com/photos/u1/download" }, urls: { regular: "https://images.unsplash.com/u1" }, user: { name: "B", links: { html: "https://unsplash.com/@b" } } }] } };
    });
    for (const [key, fields] of Object.entries(KEYS)) {
      await call("PUT", `/api/owner/connections/${key}`, { fields });
      await call("POST", `/api/owner/connections/${key}/test`);
      expect((await card(key)).lastTest.ok, key).toBe(true);
    }
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it("reports a wrong key plainly and without the key in the message", async () => {
    const { call, card } = setup(() => ({ status: 401, json: { detail: "invalid" } }));
    await call("PUT", "/api/owner/connections/brave-search", { fields: KEYS["brave-search"] });
    await call("POST", "/api/owner/connections/brave-search/test");
    const c = await card("brave-search");
    expect(c.lastTest.ok).toBe(false);
    expect(JSON.stringify(c)).not.toContain(KEYS["brave-search"].apiKey);
  });

  it("reports a rate limit or provider error as a failed test, not a crash", async () => {
    const { call, card } = setup(() => ({ status: 429, json: {} }));
    await call("PUT", "/api/owner/connections/pexels", { fields: KEYS.pexels });
    await call("POST", "/api/owner/connections/pexels/test");
    expect((await card("pexels")).lastTest.ok).toBe(false);
  });
});
