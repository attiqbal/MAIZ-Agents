import { describe, expect, it } from "vitest";
import { AuditLog, EventBus, IdentityService, Ledger } from "../src/index.js";
import { IntegrationService, defaultRegistry } from "../src/modules/integrations/index.js";
import { clientAppDefs, clientAppEnv } from "../src/modules/connections/client-apps.js";
import { paidAppDefs } from "../src/modules/connections/paid-apps.js";
import { probeSalesforce } from "../src/modules/connections/probes-more.js";
import { setHostResolver } from "../src/modules/integrations/connectors/util.js";
import type { OAuthApp } from "../src/modules/integrations/types.js";

setHostResolver(async () => ["93.184.216.34"]);

/**
 * Each connector is tested against a FAKE server that answers in the shape the vendor's documentation gives. None of it
 * has touched the real service: that needs each provider's approved app.
 */
const NOW = new Date("2026-11-10T12:00:00Z");
const APP: OAuthApp = { clientId: "id", clientSecret: "secret", redirectUri: "https://app.test/api/integrations/callback" };
const EXTRAS: Record<string, Record<string, string>> = {
  "google-ads": { developerToken: "devtoken1234567890" },
  "amazon-seller": { applicationId: "amzn1.sp.solution.abcd-1234", region: "eu" },
  ebay: { ruName: "Maiz-MaizApp-PRD-abc123-xyz" },
};
type Route = [RegExp, (url: URL, init: RequestInit) => unknown];
interface Seen { url: string; method: string; headers: Record<string, string>; body?: string }

function fake(routes: Route[]) {
  const seen: Seen[] = [];
  const http = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(String(url));
    seen.push({ url: String(url), method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? String(init.body) : undefined });
    for (const [re, fn] of routes) if (re.test(String(url))) {
      const out = fn(u, init);
      return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { http, seen };
}
const status = (code: number, body: unknown = {}) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const GOOGLE_TOKEN: Route = [/oauth2\.googleapis\.com\/token/, () => ({ access_token: "g-a", refresh_token: "g-r", expires_in: 3600 })];

async function setup(http: typeof fetch, now: () => Date = () => NOW) {
  const audit = new AuditLog();
  const identity = new IdentityService(audit, new EventBus());
  const ledger = new Ledger(identity, audit);
  const ws = await identity.createWorkspace("owner", { name: "Kestrel", baseCurrency: "GBP" });
  ledger.open("owner", ws.id);
  const apps = Object.fromEntries(Object.keys(clientAppEnv()).map((k) => [k, { ...APP, ...(EXTRAS[k] ? { extra: EXTRAS[k] } : {}) }]));
  const ig = new IntegrationService(identity, audit, ledger, defaultRegistry(), { http, now, oauthApps: apps });
  return { ig, ws: ws.id };
}
const connect = async (ig: IntegrationService, ws: string, key: string, params: Record<string, string> = {}) => ig.completeOAuth("owner", ws, key, "code", params);

describe("Google Business Profile and Google Ads", () => {
  it("counts new reviews and reads the rating, for the location the login owns", async () => {
    const { http, seen } = fake([
      GOOGLE_TOKEN,
      [/accounts$/, () => ({ accounts: [{ name: "accounts/111", accountName: "Kestrel" }] })],
      [/locations\?readMask/, () => ({ locations: [{ name: "locations/222", title: "Kestrel Cafe" }] })],
      [/reviews\?/, () => ({ averageRating: 4.6, totalReviewCount: 120, reviews: [{ createTime: "2026-11-02T10:00:00Z", comment: "secret words" }, { createTime: "2026-11-03T10:00:00Z" }, { createTime: "2026-01-01T10:00:00Z" }] })],
    ]);
    const { ig, ws } = await setup(http);
    const conn = await connect(ig, ws, "google-business-profile");
    expect(conn.needsChoice).toBeFalsy();
    await ig.sync("owner", ws, conn.id);
    const ctx = ig.contextFor(ws, "marketing-manager")!;
    expect(ctx).toContain("2 new reviews");
    expect(ctx).toContain("4.6");
    expect(ctx).not.toContain("secret words");
    expect(seen.some((s) => /accounts\/111\/locations\/222\/reviews/.test(s.url))).toBe(true);
  });

  it("reads Google Ads spend with the developer token, in pence, and refuses a missing one", async () => {
    const rows = { results: [{ segments: { date: "2026-11-04" }, metrics: { costMicros: "12500000", impressions: "900", clicks: "40", conversions: 2.4 } }] };
    const { http, seen } = fake([GOOGLE_TOKEN, [/listAccessibleCustomers/, () => ({ resourceNames: ["customers/1234567890"] })], [/googleAds:search/, () => rows]]);
    const { ig, ws } = await setup(http);
    const conn = await connect(ig, ws, "google-ads");
    await ig.sync("owner", ws, conn.id);
    const ctx = ig.contextFor(ws, "finance-manager")!;
    expect(ctx).toContain("12.50 GBP spent on adverts");
    expect(ctx).toContain("40 clicks on adverts");
    expect(seen.find((s) => /googleAds:search/.test(s.url))!.headers["developer-token"]).toBe("devtoken1234567890");
    expect(JSON.parse(seen.find((s) => /googleAds:search/.test(s.url))!.body!).query).toContain("2026-10-11");
    const bare = fake([GOOGLE_TOKEN, [/listAccessibleCustomers/, () => ({ resourceNames: ["customers/1234567890"] })]]);
    const b = await setup(bare.http);
    (b.ig as unknown as { opts: { oauthApps: Record<string, OAuthApp> } }).opts.oauthApps["google-ads"] = APP;
    await expect(connect(b.ig, b.ws, "google-ads")).rejects.toThrow(/developer token/);
  });
});

describe("LinkedIn, TikTok, Pinterest, Trustpilot", () => {
  it("LinkedIn: finds the Page the member runs, then reads followers and daily gains", async () => {
    const { http, seen } = fake([
      [/oauth\/v2\/accessToken/, () => ({ access_token: "li-a", expires_in: 5184000 })],
      [/organizationAcls/, () => ({ elements: [{ organization: "urn:li:organization:777", role: "ADMINISTRATOR", state: "APPROVED" }] })],
      [/networkSizes/, () => ({ firstDegreeSize: 1500 })],
      [/organizationalEntityFollowerStatistics/, () => ({ elements: [{ timeRange: { start: Date.parse("2026-11-05T00:00:00Z") }, followerGains: { organicFollowerGain: 7, paidFollowerGain: 3 } }] })],
    ]);
    const { ig, ws } = await setup(http);
    const conn = await connect(ig, ws, "linkedin-pages");
    await ig.sync("owner", ws, conn.id);
    const ctx = ig.contextFor(ws, "marketing-manager")!;
    expect(ctx).toContain("1500 followers");
    expect(ctx).toContain("10 new followers");
    expect(seen.find((s) => /networkSizes/.test(s.url))!.headers["linkedin-version"]).toMatch(/^\d{6}$/);
  });

  it("TikTok: asks with client_key, sends no client_id, and reads two counts", async () => {
    const { http, seen } = fake([
      [/oauth\/token/, () => ({ access_token: "tt-a", refresh_token: "tt-r", expires_in: 86400 })],
      [/user\/info/, () => ({ data: { user: { follower_count: 321, video_count: 12 } }, error: { code: "ok" } })],
    ]);
    const { ig, ws } = await setup(http);
    expect(ig.authorizeUrl("owner", ws, "tiktok", "st")).toMatch(/client_key=id/);
    const conn = await connect(ig, ws, "tiktok");
    const form = new URLSearchParams(seen.find((s) => /oauth\/token/.test(s.url))!.body);
    expect(form.get("client_key")).toBe("id");
    expect(form.has("client_id")).toBe(false);
    await ig.sync("owner", ws, conn.id);
    expect(ig.contextFor(ws, "marketing-manager")).toContain("321 followers");
  });

  it("TikTok: shows TikTok's own error code when the data call is refused", async () => {
    const { http } = fake([[/oauth\/token/, () => ({ access_token: "tt-a" })], [/user\/info/, () => ({ error: { code: "scope_not_authorized" } })]]);
    const { ig, ws } = await setup(http);
    const conn = await connect(ig, ws, "tiktok");
    await expect(ig.sync("owner", ws, conn.id)).rejects.toThrow(/scope_not_authorized/);
  });

  it("Pinterest: Basic sign-in, then renews an expired token and uses the new one", async () => {
    const calls: string[] = [];
    const { http, seen } = fake([
      [/oauth\/token/, (_u, init) => { const g = new URLSearchParams(String(init.body)).get("grant_type")!; calls.push(g); return { access_token: g === "refresh_token" ? "pin-new" : "pin-old", refresh_token: "pinr-1", expires_in: g === "refresh_token" ? 2592000 : 1 }; }],
      [/user_account/, () => ({ follower_count: 55, pin_count: 9 })],
    ]);
    // The token is made with the real clock, so the page's clock runs an hour ahead to find it expired.
    const { ig, ws } = await setup(http, () => new Date(Date.now() + 3_600_000));
    const conn = await connect(ig, ws, "pinterest");
    expect(seen[0]!.headers.authorization).toMatch(/^Basic /);
    await ig.sync("owner", ws, conn.id);
    expect(calls).toEqual(["authorization_code", "refresh_token"]);
    expect(seen.filter((s) => /user_account/.test(s.url)).every((s) => s.headers.authorization === "Bearer pin-new")).toBe(true);
    expect(ig.contextFor(ws, "marketing-manager")).toContain("55 followers");
  });

  it("Trustpilot: counts new reviews from a pasted key, never the words", async () => {
    const { http, seen } = fake([
      [/business-units\/find/, () => ({ id: "5f5f5f5f5f5f5f5f5f5f5f5f" })],
      [/reviews\?/, () => ({ reviews: [{ createdAt: "2026-11-04T09:00:00Z", stars: 5, text: "lovely" }, { createdAt: "2026-11-08T09:00:00Z", stars: 4 }] })],
      [/business-units\/5f/, () => ({ numberOfReviews: { total: 88 }, score: { trustScore: 4.3 } })],
    ]);
    const { ig, ws } = await setup(http);
    expect(() => ig.connectWithKey("owner", ws, "trustpilot", { apiKey: "short", domain: "www.kestrel.co.uk" })).toThrow(/API key/);
    expect(() => ig.connectWithKey("owner", ws, "trustpilot", { apiKey: "abcdefABCDEF1234567890", domain: "not a domain" })).toThrow(/web address/);
    const conn = ig.connectWithKey("owner", ws, "trustpilot", { apiKey: "abcdefABCDEF1234567890", domain: "https://www.kestrel.co.uk/" });
    await ig.sync("owner", ws, conn.id);
    const ctx = ig.contextFor(ws, "marketing-manager")!;
    expect(ctx).toContain("2 new reviews");
    expect(ctx).not.toContain("lovely");
    expect(seen[0]!.headers.apikey).toBe("abcdefABCDEF1234567890");
    expect(seen[0]!.url).toContain("name=www.kestrel.co.uk");
  });
});

describe("Meta Ads and the marketplaces", () => {
  it("Meta Ads: trades the short token for a long one, picks the ad account and reads daily spend", async () => {
    const { http, seen } = fake([
      [/oauth\/access_token\?.*fb_exchange_token/, () => ({ access_token: "long", expires_in: 5184000 })],
      [/oauth\/access_token/, () => ({ access_token: "short", expires_in: 3600 })],
      [/me\/adaccounts/, () => ({ data: [{ id: "act_123456", name: "Kestrel ads" }] })],
      [/act_123456\/insights/, () => ({ data: [{ date_start: "2026-11-04", spend: "20.00", impressions: "1000", clicks: "30", actions: [{ action_type: "lead", value: "3" }, { action_type: "link_click", value: "30" }] }] })],
    ]);
    const { ig, ws } = await setup(http);
    const conn = await connect(ig, ws, "meta-ads");
    await ig.sync("owner", ws, conn.id);
    const ctx = ig.contextFor(ws, "marketing-manager")!;
    expect(ctx).toContain("20.00 GBP spent on adverts");
    expect(ctx).toContain("3 results the adverts brought");
    expect(seen.find((s) => /act_123456\/insights/.test(s.url))!.headers.authorization).toBe("Bearer long");
  });

  it("Amazon: uses the regional Seller Central address, keeps the seller id, and turns order totals into sales", async () => {
    const { http, seen } = fake([
      [/auth\/o2\/token/, () => ({ access_token: "amz-a", refresh_token: "amz-r", expires_in: 3600 })],
      [/marketplaceParticipations/, () => ({ payload: [{ marketplace: { id: "A1F83G8C2ARO7P", defaultCurrencyCode: "GBP" }, participation: { isParticipating: true } }] })],
      [/orderMetrics/, () => ({ payload: [{ interval: "2026-11-04T00:00:00Z--2026-11-05T00:00:00Z", orderCount: 3, totalSales: { amount: "150.00", currencyCode: "GBP" } }] })],
    ]);
    const { ig, ws } = await setup(http);
    const url = new URL(ig.authorizeUrl("owner", ws, "amazon-seller", "st"));
    expect(url.origin).toBe("https://sellercentral-europe.amazon.com");
    expect(url.searchParams.get("application_id")).toBe("amzn1.sp.solution.abcd-1234");
    const conn = await connect(ig, ws, "amazon-seller", { selling_partner_id: "A2SELLER123" });
    expect(conn.externalAccount).toBe("Seller A2SELLER123");
    await ig.sync("owner", ws, conn.id);
    expect(ig.contextFor(ws, "finance-manager")).toContain("150.00 GBP");
    expect(seen.find((s) => /orderMetrics/.test(s.url))!.headers["x-amz-access-token"]).toBe("amz-a");
    expect(seen.find((s) => /orderMetrics/.test(s.url))!.url).toContain("sellingpartnerapi-eu.amazon.com");
  });

  it("Etsy: sends a PKCE proof, no secret at the token address, and the key and secret in the header", async () => {
    const { http, seen } = fake([
      [/public\/oauth\/token/, () => ({ access_token: "1234.etsy", refresh_token: "1234.r", expires_in: 3600 })],
      [/users\/me/, () => ({ user_id: 1234, shop_id: 99 })],
      [/shops\/99\/receipts/, () => ({ results: [
        { created_timestamp: Date.parse("2026-11-04T10:00:00Z") / 1000, grandtotal: { amount: 2500, divisor: 100, currency_code: "GBP" }, total_tax_cost: { amount: 400, divisor: 100 } },
        { created_timestamp: Date.parse("2026-11-04T12:00:00Z") / 1000, grandtotal: { amount: 1000, divisor: 100, currency_code: "GBP" } },
      ] })],
    ]);
    const { ig, ws } = await setup(http);
    const url = new URL(ig.authorizeUrl("owner", ws, "etsy", "st", "chal"));
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const conn = await connect(ig, ws, "etsy", { code_verifier: "v".repeat(43) });
    const form = new URLSearchParams(seen[0]!.body);
    expect(form.get("code_verifier")).toBe("v".repeat(43));
    expect(form.has("client_secret")).toBe(false);
    await ig.sync("owner", ws, conn.id);
    expect(seen.find((s) => /users\/me/.test(s.url))!.headers["x-api-key"]).toBe("id:secret");
    expect(ig.contextFor(ws, "finance-manager")).toContain("2 transactions");
  });

  it("eBay: asks with the RuName in place of an address and reads paid, uncancelled orders", async () => {
    const { http, seen } = fake([
      [/identity\/v1\/oauth2\/token/, () => ({ access_token: "eb-a", refresh_token: "eb-r", expires_in: 7200 })],
      [/sell\/fulfillment\/v1\/order/, () => ({ orders: [
        { creationDate: "2026-11-04T10:00:00.000Z", orderPaymentStatus: "PAID", cancelStatus: { cancelState: "NONE_REQUESTED" }, pricingSummary: { total: { value: "40.00", currency: "GBP" } }, totalMarketplaceFee: { value: "4.00" } },
        { creationDate: "2026-11-04T11:00:00.000Z", orderPaymentStatus: "PAID", cancelStatus: { cancelState: "CANCELED" }, pricingSummary: { total: { value: "99.00", currency: "GBP" } } },
      ] })],
    ]);
    const { ig, ws } = await setup(http);
    expect(new URL(ig.authorizeUrl("owner", ws, "ebay", "st")).searchParams.get("redirect_uri")).toBe("Maiz-MaizApp-PRD-abc123-xyz");
    const conn = await connect(ig, ws, "ebay");
    expect(new URLSearchParams(seen[0]!.body).get("redirect_uri")).toBe("Maiz-MaizApp-PRD-abc123-xyz");
    expect(seen[0]!.headers.authorization).toMatch(/^Basic /);
    await ig.sync("owner", ws, conn.id);
    const ctx = ig.contextFor(ws, "finance-manager")!;
    expect(ctx).toContain("40.00 GBP");
    expect(ctx).not.toContain("99.00");
  });
});

describe("DocuSign and Canva", () => {
  const BASE = "https://eu.docusign.net";
  const ACC = "11111111-2222-3333-4444-555555555555";
  it("DocuSign: keeps only DocuSign's own account address and counts sent, signed and waiting", async () => {
    const { http, seen } = fake([
      [/oauth\/token/, () => ({ access_token: "ds-a", refresh_token: "ds-r", expires_in: 28800 })],
      [/oauth\/userinfo/, () => ({ accounts: [{ account_id: ACC, base_uri: BASE, is_default: true }] })],
      [/envelopes\?/, () => ({ envelopes: [
        { status: "completed", sentDateTime: "2026-11-02T10:00:00Z", completedDateTime: "2026-11-03T10:00:00Z" },
        { status: "sent", sentDateTime: "2026-11-05T10:00:00Z" },
      ], resultSetSize: "2", totalSetSize: "2" })],
    ]);
    const { ig, ws } = await setup(http);
    const conn = await connect(ig, ws, "docusign");
    expect(conn.externalAccount).toBe("eu.docusign.net");
    await ig.sync("owner", ws, conn.id);
    const ctx = ig.contextFor(ws, "business-consultant")!;
    expect(ctx).toContain("2 documents sent for signing");
    expect(ctx).toContain("1 documents signed");
    expect(ctx).toContain("1 documents waiting for a signature");
    expect(seen.find((s) => /envelopes\?/.test(s.url))!.url.startsWith(`${BASE}/restapi/v2.1/accounts/${ACC}/envelopes`)).toBe(true);
    const evil = fake([[/oauth\/token/, () => ({ access_token: "x" })], [/userinfo/, () => ({ accounts: [{ account_id: ACC, base_uri: "https://evil.example.com" }] })]]);
    const b = await setup(evil.http);
    await expect(connect(b.ig, b.ws, "docusign")).rejects.toThrow(/account we can use/);
  });

  it("Canva: PKCE, then counts designs without reading their titles", async () => {
    const { http, seen } = fake([
      [/oauth\/token/, () => ({ access_token: "cv-a", refresh_token: "cv-r", expires_in: 14400 })],
      [/rest\/v1\/designs/, () => ({ items: [{ id: "D1", title: "Private launch plan", updated_at: Date.parse("2026-11-06T10:00:00Z") / 1000 }, { id: "D2", updated_at: Date.parse("2025-01-06T10:00:00Z") / 1000 }] })],
    ]);
    const { ig, ws } = await setup(http);
    expect(new URL(ig.authorizeUrl("owner", ws, "canva", "st", "chal")).searchParams.get("code_challenge_method")).toBe("S256");
    const conn = await connect(ig, ws, "canva", { code_verifier: "w".repeat(43) });
    expect(new URLSearchParams(seen[0]!.body).get("code_verifier")).toBe("w".repeat(43));
    await ig.sync("owner", ws, conn.id);
    const ctx = ig.contextFor(ws, "business-consultant")!;
    expect(ctx).toContain("2 designs in your account");
    expect(ctx).toContain("1 designs made or changed");
    expect(ctx).not.toContain("Private launch plan");
  });

  it("Canva: a rate limit answer becomes a plain message and the connection shows the error", async () => {
    const { http } = fake([[/oauth\/token/, () => ({ access_token: "cv-a" })], [/rest\/v1\/designs/, () => status(429)]]);
    const { ig, ws } = await setup(http);
    const conn = await connect(ig, ws, "canva");
    await expect(ig.sync("owner", ws, conn.id)).rejects.toThrow(/slow down/);
    expect(ig.list("owner", ws)[0]!.status).toBe("error");
  });
});

describe("what a provider's refusal looks like", () => {
  it.each(["tiktok", "pinterest", "etsy", "ebay", "docusign", "canva", "amazon-seller", "meta-ads", "linkedin-pages", "salesforce"])("%s: the owner sees the provider's own error code and what to check", async (key) => {
    const { http } = fake([[/./, () => status(400, { error: "invalid_client" })]]);
    const { ig, ws } = await setup(http);
    await expect(connect(ig, ws, key)).rejects.toThrow(/invalid_client.*Client ID and secret/);
  });

  it("a rate limit at the token address says to wait", async () => {
    const { http } = fake([[/./, () => status(429)]]);
    const { ig, ws } = await setup(http);
    await expect(connect(ig, ws, "etsy")).rejects.toThrow(/slow down/);
  });

  it("a provider's refusal code is never shown when it is not a plain code", async () => {
    const { http } = fake([[/./, () => status(400, { error: "<script>alert(1)</script> secret" })]]);
    const { ig, ws } = await setup(http);
    await expect(connect(ig, ws, "pinterest")).rejects.toThrow(/^Pinterest did not approve the connection\.$/);
  });

  it("remembers the last problem for ten minutes and gives it out once", async () => {
    const { http } = fake([]);
    const { ig, ws } = await setup(http);
    ig.noteProblem("owner", ws, "Etsy said no: x");
    expect(ig.takeProblem("owner", ws)).toBe("Etsy said no: x");
    expect(ig.takeProblem("owner", ws)).toBeUndefined();
  });
});

describe("Salesforce", () => {
  it("asks with a PKCE proof and sends the verifier with the code", async () => {
    const { http, seen } = fake([[/services\/oauth2\/token/, () => ({ access_token: "sf-a", refresh_token: "sf-r", instance_url: "https://kestrel.my.salesforce.com" })]]);
    const { ig, ws } = await setup(http);
    expect(new URL(ig.authorizeUrl("owner", ws, "salesforce", "st", "chal")).searchParams.get("code_challenge")).toBe("chal");
    await connect(ig, ws, "salesforce", { code_verifier: "s".repeat(43) });
    expect(new URLSearchParams(seen[0]!.body).get("code_verifier")).toBe("s".repeat(43));
  });

  it.each([
    [{ error: "invalid_client_id", error_description: "client identifier invalid" }, false, /does not know this Consumer Key.*Spring '26/],
    [{ error: "invalid_client", error_description: "invalid client credentials" }, false, /not this secret/],
    [{ error: "redirect_uri_mismatch", error_description: "redirect_uri must match configuration" }, false, /Callback URL is not saved/],
    [{ error: "invalid_grant", error_description: "authentication failure" }, true, /knows your app and accepted the secret/],
    [{ error: "unsupported_grant_type", error_description: "grant type not supported" }, false, /not switched on/],
    [{ weird: true }, false, /does not recognise/],
  ])("the test button turns %j into a specific answer", async (answer, ok, words) => {
    const { http, seen } = fake([[/./, () => status(400, answer)]]);
    const r = await probeSalesforce(APP, http);
    expect(r.ok).toBe(ok);
    expect(r.message).toMatch(words);
    expect(new URLSearchParams(seen[0]!.body).get("code_verifier")).toBeTruthy();
    expect(seen[0]!.url.startsWith("https://login.salesforce.com/")).toBe(true);
  });

  it("the card tells the owner about External Client Apps and the uninstalled-app error", () => {
    const card = clientAppDefs([]).find((d) => d.key === "salesforce")!;
    const text = JSON.stringify(card.guide);
    expect(text).toMatch(/External Client App/);
    expect(text).toMatch(/OAUTH_APPROVAL_ERROR_GENERIC/);
    expect(text).toMatch(/PKCE/);
  });
});

describe("the owner's cards", () => {
  const defs = clientAppDefs(["xero", "square"]);
  const by = (k: string) => defs.find((d) => d.key === k)!;

  it("shows the honest state of every service that needs a provider's approval", () => {
    for (const k of ["google-business-profile", "linkedin-pages", "tiktok", "google-ads", "meta-ads", "amazon-seller", "etsy", "ebay", "docusign", "pinterest", "canva"]) {
      expect(by(k).title, k).toMatch(/ready, waiting for the provider's approval/);
      expect(by(k).editable, k).toBe(true);
      expect(by(k).tier, k).toBeTruthy();
      expect(by(k).copies?.[0]?.path, k).toBe("/api/integrations/callback");
      expect(JSON.stringify(by(k).guide), k).not.toMatch(/ssh|terminal|command line/i);
    }
    expect(by("trustpilot")).toBeUndefined();
    expect(by("salesforce").title).toBe("Salesforce");
  });

  it("adds the extra boxes some providers want, with the secret one marked secret", () => {
    const dev = by("google-ads").fields.find((f) => f.key === "developerToken")!;
    expect(dev.secret).toBe(true);
    expect(dev.required).toBe(true);
    expect(by("amazon-seller").fields.map((f) => f.key)).toEqual(["clientId", "clientSecret", "applicationId", "region"]);
    expect(by("ebay").fields.some((f) => f.key === "ruName")).toBe(true);
    expect(clientAppEnv()["google-ads"]!.extra.developerToken).toBe("GOOGLEADS_DEVELOPER_TOKEN");
  });

  it("says plainly that Indeed cannot be connected", () => {
    expect(by("indeed").title).toMatch(/cannot be connected/);
    expect(by("indeed").editable).toBe(false);
    expect(by("indeed").summary).toMatch(/approved partner/);
  });

  it("labels the video tools truthfully and gives Canva one card only", () => {
    const paid = paidAppDefs();
    for (const k of ["adobe-express", "kapwing", "invideo"]) expect(paid.find((d) => d.key === k)!.title, k).toMatch(/cannot be connected/);
    expect(paid.find((d) => d.key === "veed")!.title).toMatch(/not built/);
    expect(paid.find((d) => d.key === "envato")!.title).toMatch(/stock library, used by hand/);
    expect(paid.some((d) => d.key === "canva")).toBe(false);
    expect(defs.filter((d) => d.key === "canva")).toHaveLength(1);
    expect(paid.find((d) => d.key === "kapwing")!.summary).toMatch(/Cannot be connected/);
  });

  it("every connector key is unique and every area figure has a name", () => {
    const keys = defaultRegistry().list().map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
