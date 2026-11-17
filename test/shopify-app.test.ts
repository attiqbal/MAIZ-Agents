import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { shopAddress, shopifyQueryIsGenuine } from "../src/modules/integrations/connectors/shopify-app.js";

// Shopify as a one-click app, against a FAKE Shopify. Nothing here has touched the real service.
const SECRET = "shpss_fake_secret_value";
const APP = { clientId: "shop-client-id", clientSecret: SECRET, redirectUri: "https://app.test/api/integrations/callback" };
const SHOP = "kestrel-coffee.myshopify.com";

const sign = (params: Record<string, string>, secret = SECRET): string => {
  const msg = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  return createHmac("sha256", secret).update(msg).digest("hex");
};
const signedQuery = (params: Record<string, string>, secret = SECRET): string => new URLSearchParams({ ...params, hmac: sign(params, secret) }).toString();

interface Seen { url: string; method: string; headers: Record<string, string>; body: string }

function world(opts: { token?: () => Response; orders?: () => Response } = {}) {
  const seen: Seen[] = [];
  const http = (async (url: any, init: any = {}) => {
    const s: Seen = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: String(init.body ?? "") };
    seen.push(s);
    if (s.url.endsWith("/admin/oauth/access_token")) return opts.token?.() ?? Response.json({ access_token: "shpat_1", scope: "read_orders", expires_in: 3600, refresh_token: "shprt_1", refresh_token_expires_in: 7776000 });
    if (s.url.includes("/graphql.json")) return opts.orders?.() ?? Response.json({ data: { orders: { pageInfo: { hasNextPage: false }, nodes: [
      { createdAt: "2026-06-08T10:00:00Z", cancelledAt: null, displayFinancialStatus: "PAID", totalPriceSet: { shopMoney: { amount: "50.00", currencyCode: "GBP" } }, totalTaxSet: { shopMoney: { amount: "8.33" } }, totalTipReceivedSet: { shopMoney: { amount: "0.00" } }, totalRefundedSet: { shopMoney: { amount: "10.00" } } },
      { createdAt: "2026-06-08T12:00:00Z", cancelledAt: null, displayFinancialStatus: "PAID", totalPriceSet: { shopMoney: { amount: "20.00", currencyCode: "GBP" } }, totalTaxSet: { shopMoney: { amount: "3.33" } }, totalTipReceivedSet: { shopMoney: { amount: "0" } }, totalRefundedSet: { shopMoney: { amount: "0" } } },
      { createdAt: "2026-06-08T13:00:00Z", cancelledAt: "2026-06-08T14:00:00Z", displayFinancialStatus: "PAID", totalPriceSet: { shopMoney: { amount: "99.00", currencyCode: "GBP" } } },
      { createdAt: "2026-06-08T15:00:00Z", cancelledAt: null, displayFinancialStatus: "PENDING", totalPriceSet: { shopMoney: { amount: "77.00", currencyCode: "GBP" } } },
    ] } } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const clock = { d: new Date() };
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, appUrl: "https://app.test", now: () => clock.d, http, integrationApps: { "shopify-app": APP } });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, query = "") =>
    handle({ method, path, query: new URLSearchParams(query), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  return { platform, call, seen, clock };
}

async function signedIn(w: ReturnType<typeof world>) {
  const r = await w.call("POST", "/api/signup", { email: "ann@kestrel.co", businessName: "Kestrel Coffee", sells: "Coffee", size: "2–10", country: "GB", goal: "More customers" });
  return { authorization: `Bearer ${(r.body as any).token}` };
}

async function begin(w: ReturnType<typeof world>, auth: Record<string, string>, shop = SHOP) {
  const start = await w.call("POST", "/api/integrations/apps/shopify-app/connect", { values: { shop } }, auth);
  if (start.status !== 200) return { start };
  const url = new URL((start.body as any).url);
  return { start, url, state: url.searchParams.get("state")!, cookie: start.headers!["set-cookie"]!.split(";")[0]! };
}

describe("shop addresses and the callback signature", () => {
  it("accepts only a real myshopify.com name", () => {
    expect(shopAddress("My-Shop")).toBe("my-shop.myshopify.com");
    expect(shopAddress("https://my-shop.myshopify.com/admin/orders")).toBe("my-shop.myshopify.com");
    for (const bad of ["evil.com", "my-shop.myshopify.com.evil.com", "a@my-shop.myshopify.com", "10.0.0.1", "", "my shop", "my-shop.myshopify.com:8080", 42]) {
      expect(() => shopAddress(bad), String(bad)).toThrow(/myshopify\.com/);
    }
  });

  it("checks Shopify's HMAC over the sorted query and refuses any change", async () => {
    const q = { code: "abc", shop: SHOP, state: "s", timestamp: "1780000000", host: "YWRtaW4" };
    expect(await shopifyQueryIsGenuine(signedQuery(q), SECRET)).toBe(true);
    expect(await shopifyQueryIsGenuine(signedQuery(q, "other"), SECRET)).toBe(false);
    expect(await shopifyQueryIsGenuine(signedQuery({ ...q, shop: "evil.myshopify.com" }).replace(sign({ ...q, shop: "evil.myshopify.com" }), sign(q)), SECRET)).toBe(false);
    expect(await shopifyQueryIsGenuine(new URLSearchParams(q).toString(), SECRET)).toBe(false);
    expect(await shopifyQueryIsGenuine(`${new URLSearchParams(q).toString()}&hmac=zz`, SECRET)).toBe(false);
  });
});

describe("Shopify one-click connection", () => {
  it("asks for the shop first, and refuses an address that is not a myshopify.com shop", async () => {
    const w = world();
    const auth = await signedIn(w);
    expect((await begin(w, auth, "evil.com")).start.status).toBe(400);
    expect((await w.call("POST", "/api/integrations/apps/shopify-app/connect", {}, auth)).status).toBe(400);
    const ok = await begin(w, auth, "Kestrel-Coffee");
    expect(ok.url!.origin).toBe(`https://${SHOP}`);
    expect(ok.url!.pathname).toBe("/admin/oauth/authorize");
    expect(ok.url!.searchParams.get("scope")).toBe("read_orders");
    expect(ok.url!.searchParams.get("client_id")).toBe("shop-client-id");
    expect(ok.url!.searchParams.get("redirect_uri")).toBe(APP.redirectUri);
  });

  it("connects with a signed comeback, asks for an expiring token, and reads sales without cancelled or unpaid orders", async () => {
    const w = world();
    const auth = await signedIn(w);
    const b = await begin(w, auth);
    const q = signedQuery({ code: "the-code", shop: SHOP, state: b.state!, timestamp: "1780000000" });
    const back = await w.call("GET", "/api/integrations/callback", undefined, { cookie: b.cookie! }, q);
    expect(back.status).toBe(302);
    expect(back.headers!.location).not.toMatch(/failed/);
    const tokenCall = w.seen.find((s) => s.url === `https://${SHOP}/admin/oauth/access_token`)!;
    expect(JSON.parse(tokenCall.body)).toMatchObject({ code: "the-code", expiring: 1, client_id: "shop-client-id" });
    const list = (await w.call("GET", "/api/integrations", undefined, auth)).body as any;
    const conn = list.connections.find((c: any) => c.connectorKey === "shopify-app");
    expect(conn.externalAccount).toBe(SHOP);
    expect(JSON.stringify(list)).not.toContain("shpat_1");
    const sync = await w.call("POST", `/api/integrations/connections/${conn.id}/sync`, {}, auth);
    expect(sync.status).toBe(200);
    const gql = w.seen.find((s) => s.url === `https://${SHOP}/admin/api/2026-10/graphql.json`)!;
    expect(gql.headers["x-shopify-access-token"]).toBe("shpat_1");
    expect((sync.body as any).added).toBe(1);
    const row = w.platform.integrations.recordsOf(conn.workspaceId).find((r) => r.kind === "sales");
    // Two paid orders on the day (50.00 and 20.00); the cancelled and the unpaid ones are left out. Refunds and tax are carried across.
    expect(row?.data).toMatchObject({ date: "2026-06-08", currency: "GBP", gross: 7000, tax: 1166, refunds: 1000, transactions: 2 });
  });

  it("refuses a comeback whose signature is wrong, whose shop was swapped, or with no signature", async () => {
    for (const make of [
      (state: string) => signedQuery({ code: "c", shop: SHOP, state, timestamp: "1" }, "not-our-secret"),
      (state: string) => new URLSearchParams({ code: "c", shop: SHOP, state, timestamp: "1" }).toString(),
      (state: string) => signedQuery({ code: "c", shop: "other-shop.myshopify.com", state, timestamp: "1" }),
    ]) {
      const w = world();
      const auth = await signedIn(w);
      const b = await begin(w, auth);
      const back = await w.call("GET", "/api/integrations/callback", undefined, { cookie: b.cookie! }, make(b.state!));
      expect(back.headers!.location).toMatch(/connect=failed/);
      expect(w.seen.some((s) => s.url.endsWith("/access_token"))).toBe(false);
      expect(((await w.call("GET", "/api/integrations", undefined, auth)).body as any).problem).toMatch(/could not be checked/);
    }
  });

  it("explains a provider error at the token address without echoing the secret", async () => {
    const w = world({ token: () => Response.json({ error: "invalid_request" }, { status: 400 }) });
    const auth = await signedIn(w);
    const b = await begin(w, auth);
    const back = await w.call("GET", "/api/integrations/callback", undefined, { cookie: b.cookie! }, signedQuery({ code: "c", shop: SHOP, state: b.state!, timestamp: "1" }));
    expect(back.headers!.location).toMatch(/connect=failed/);
    const problem = ((await w.call("GET", "/api/integrations", undefined, auth)).body as any).problem as string;
    expect(problem).toMatch(/Shopify did not approve/);
    expect(problem).not.toContain(SECRET);
  });

  it("refuses a connection that was not given permission to read orders", async () => {
    const w = world({ token: () => Response.json({ access_token: "shpat_x", scope: "read_products" }) });
    const auth = await signedIn(w);
    const b = await begin(w, auth);
    await w.call("GET", "/api/integrations/callback", undefined, { cookie: b.cookie! }, signedQuery({ code: "c", shop: SHOP, state: b.state!, timestamp: "1" }));
    expect(((await w.call("GET", "/api/integrations", undefined, auth)).body as any).problem).toMatch(/read orders/);
  });

  async function connected(w: ReturnType<typeof world>, auth: Record<string, string>) {
    const b = await begin(w, auth);
    await w.call("GET", "/api/integrations/callback", undefined, { cookie: b.cookie! }, signedQuery({ code: "c", shop: SHOP, state: b.state!, timestamp: "1" }));
    return ((await w.call("GET", "/api/integrations", undefined, auth)).body as any).connections.find((c: any) => c.connectorKey === "shopify-app");
  }

  it("renews an expired token with the rotating refresh token and keeps the new one", async () => {
    let n = 0;
    const w = world({ token: () => Response.json(n++ === 0 ? { access_token: "shpat_old", scope: "read_orders", expires_in: 3600, refresh_token: "shprt_old" } : { access_token: "shpat_new", refresh_token: "shprt_new", expires_in: 3600 }) });
    const auth = await signedIn(w);
    const conn = await connected(w, auth);
    w.clock.d = new Date(w.clock.d.getTime() + 2 * 3600_000);
    expect((await w.call("POST", `/api/integrations/connections/${conn.id}/sync`, {}, auth)).status).toBe(200);
    const refreshCall = w.seen.filter((s) => s.url.endsWith("/access_token"))[1]!;
    expect(JSON.parse(refreshCall.body)).toMatchObject({ grant_type: "refresh_token", refresh_token: "shprt_old" });
    const gql = w.seen.filter((s) => s.url.includes("/graphql.json")).at(-1)!;
    expect(gql.headers["x-shopify-access-token"]).toBe("shpat_new");
    // The next renewal must use the rotated token, not the first one.
    w.clock.d = new Date(w.clock.d.getTime() + 2 * 3600_000);
    await w.call("POST", `/api/integrations/connections/${conn.id}/sync`, {}, auth);
    expect(JSON.parse(w.seen.filter((s) => s.url.endsWith("/access_token")).at(-1)!.body).refresh_token).toBe("shprt_new");
  });

  it("asks the owner to connect again when Shopify has expired the token, and on a rate limit says to wait", async () => {
    for (const [status, words] of [[401, /connect Shopify again/], [429, /slow down/]] as const) {
      const w = world({ orders: () => new Response("{}", { status }) });
      const auth = await signedIn(w);
      const conn = await connected(w, auth);
      const sync = await w.call("POST", `/api/integrations/connections/${conn.id}/sync`, {}, auth);
      expect(JSON.stringify(sync.body)).toMatch(words);
    }
  });

  it("reports Shopify's own throttling and permission errors plainly", async () => {
    for (const [code, words] of [["THROTTLED", /slow down/], ["ACCESS_DENIED", /approve reading orders/]] as const) {
      const w = world({ orders: () => Response.json({ errors: [{ message: "x", extensions: { code } }] }) });
      const auth = await signedIn(w);
      const conn = await connected(w, auth);
      expect(JSON.stringify((await w.call("POST", `/api/integrations/connections/${conn.id}/sync`, {}, auth)).body)).toMatch(words);
    }
  });
});
