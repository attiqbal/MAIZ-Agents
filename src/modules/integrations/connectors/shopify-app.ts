import { IntegrationError, type Connector, type ConnectorContext, type Credentials, type DateRange, type OAuthApp, type Records, type SalesDay } from "../types.js";
import { dayOf, toMinor } from "./util.js";

/**
 * Shopify as a one-click app (the shop owner approves MAIZ on Shopify's own page), beside the paste-a-key `shopify`
 * connector, which keeps working for shops that made their own app.
 *
 * Safety rules this file keeps:
 *  - The shop address must be exactly `<name>.myshopify.com`. It is checked when typed, again when the owner comes
 *    back, and again before every call, so a key never reaches any other host.
 *  - The comeback is only trusted when Shopify's HMAC over the whole query checks out with our secret.
 *  - Read-only: the only permission asked for is read_orders. Customer names and addresses are never requested.
 *  - Shopify's expiring offline tokens: the access token is short, the refresh token rotates on every renewal.
 */
const SHOP = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const API_VERSION = "2026-10";
const SCOPE = "read_orders";
const MAX_PAGES = 40;
const TIMEOUT_MS = 20_000;
const SKIP_STATUS = new Set(["VOIDED", "PENDING", "AUTHORIZED"]);

/** A bare shop name, a .myshopify.com address or a pasted admin link all become `name.myshopify.com`, or an error. */
export function shopAddress(input: unknown): string {
  const raw = typeof input === "string" ? input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "") : "";
  const host = /^[a-z0-9][a-z0-9-]{0,60}$/.test(raw) ? `${raw}.myshopify.com` : raw;
  if (!SHOP.test(host)) throw new IntegrationError("Use your shop's .myshopify.com address, for example my-shop.myshopify.com (not your own domain).");
  return host;
}

/** Shopify signs the comeback: HMAC-SHA256, hex, over the other query values sorted by name (no hmac), keyed with our secret. */
export async function shopifyQueryIsGenuine(query: string, secret: string): Promise<boolean> {
  // Loaded here, not at the top, because the website bundle also reads the connector list and has no node:crypto.
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const params = new URLSearchParams(query);
  const given = params.get("hmac") ?? "";
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  params.delete("hmac");
  const escValue = (s: string) => s.replace(/%/g, "%25").replace(/&/g, "%26");
  const escKey = (s: string) => escValue(s).replace(/=/g, "%3D");
  const message = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${escKey(k)}=${escValue(v)}`).join("&");
  const want = createHmac("sha256", secret).update(message).digest();
  return timingSafeEqual(want, Buffer.from(given, "hex"));
}

interface TokenReply { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }

async function tokenCall(http: typeof fetch, shop: string, body: Record<string, unknown>): Promise<TokenReply> {
  let res: Response;
  try {
    res = await http(`https://${shop}/admin/oauth/access_token`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  } catch { throw new IntegrationError("Shopify could not be reached. Try again in a minute."); }
  if (res.status === 429) throw new IntegrationError("Shopify asked us to slow down. Try again in a few minutes.");
  const o = (await res.json().catch(() => ({}))) as TokenReply;
  if (!res.ok || !o.access_token) throw new IntegrationError("Shopify did not approve the connection. Check the Client ID and secret on this site's Connections page, then connect again.");
  return o;
}

const expiry = (s: unknown): string | undefined => (typeof s === "number" && s > 0 ? new Date(Date.now() + s * 1000).toISOString() : undefined);

async function exchangeCode(http: typeof fetch, app: OAuthApp, code: string, params: Record<string, string> = {}) {
  const shop = shopAddress(params.shop);
  const query = new URLSearchParams(params.query ?? "");
  if (!params.query || !(await shopifyQueryIsGenuine(params.query, app.clientSecret)) || query.get("shop") !== shop) {
    throw new IntegrationError("Shopify's reply could not be checked, so it was refused. Please connect Shopify again from this site.");
  }
  const o = await tokenCall(http, shop, { client_id: app.clientId, client_secret: app.clientSecret, code, expiring: 1 });
  if (!(o.scope ?? "").split(",").map((s) => s.trim()).includes(SCOPE)) throw new IntegrationError("Shopify did not give permission to read orders. Connect again and approve reading orders.");
  const credentials: Credentials = { kind: "oauth2", accessToken: o.access_token!, refreshToken: o.refresh_token, expiresAt: expiry(o.expires_in), tenant: shop };
  return { credentials, externalAccount: shop };
}

async function refresh(http: typeof fetch, app: OAuthApp, creds: Credentials): Promise<Credentials> {
  if (creds.kind !== "oauth2" || !creds.refreshToken || !creds.tenant) throw new IntegrationError("Please connect Shopify again.");
  let o: TokenReply;
  try {
    o = await tokenCall(http, shopAddress(creds.tenant), { client_id: app.clientId, client_secret: app.clientSecret, grant_type: "refresh_token", refresh_token: creds.refreshToken });
  } catch (e) {
    throw new IntegrationError(e instanceof IntegrationError && /slow down|reached/.test(e.message) ? e.message : "Shopify did not renew the connection. Please connect Shopify again.");
  }
  // The refresh token rotates: the new one replaces the old one.
  return { ...creds, accessToken: o.access_token!, refreshToken: o.refresh_token ?? creds.refreshToken, expiresAt: expiry(o.expires_in) };
}

const ORDERS = `query($q:String!,$after:String){orders(first:100,after:$after,query:$q,sortKey:CREATED_AT){pageInfo{hasNextPage endCursor}nodes{createdAt cancelledAt displayFinancialStatus totalPriceSet{shopMoney{amount currencyCode}} totalTaxSet{shopMoney{amount}} totalTipReceivedSet{shopMoney{amount}} totalRefundedSet{shopMoney{amount}}}}}`;

interface Money { shopMoney?: { amount?: string; currencyCode?: string } }
interface OrderNode { createdAt?: string; cancelledAt?: string | null; displayFinancialStatus?: string; totalPriceSet?: Money; totalTaxSet?: Money; totalTipReceivedSet?: Money; totalRefundedSet?: Money }
interface Page { data?: { orders?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: OrderNode[] } }; errors?: { message?: string; extensions?: { code?: string } }[] }

async function graphql(ctx: ConnectorContext, shop: string, token: string, variables: Record<string, unknown>): Promise<Page> {
  let res: Response;
  try {
    res = await ctx.http(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "content-type": "application/json", accept: "application/json", "x-shopify-access-token": token }, body: JSON.stringify({ query: ORDERS, variables }) });
  } catch { throw new IntegrationError("Shopify could not be reached. Try again in a minute."); }
  if (res.status === 401 || res.status === 403) throw new IntegrationError("Shopify refused access. Please connect Shopify again.");
  if (res.status === 429) throw new IntegrationError("Shopify asked us to slow down. Try again in a few minutes.");
  if (!res.ok) throw new IntegrationError(`Shopify answered ${res.status}`);
  let page: Page;
  try { page = (await res.json()) as Page; } catch { throw new IntegrationError("Shopify sent something we could not read"); }
  const codes = (page.errors ?? []).map((e) => e.extensions?.code);
  if (codes.includes("THROTTLED")) throw new IntegrationError("Shopify asked us to slow down. Try again in a few minutes.");
  if (codes.includes("ACCESS_DENIED")) throw new IntegrationError("Shopify did not allow reading orders. Please connect Shopify again and approve reading orders.");
  if (page.errors?.length) throw new IntegrationError("Shopify could not read the orders. Try again later.");
  return page;
}

const blank = (date: string, currency: string): SalesDay => ({ date, currency, gross: 0, tax: 0, tips: 0, fees: 0, refunds: 0, transactions: 0 });

async function readOrders(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const c = ctx.credentials;
  if (c.kind !== "oauth2" || !c.tenant) throw new IntegrationError("Please connect Shopify again.");
  const shop = shopAddress(c.tenant);
  const q = `created_at:>=${range.from}T00:00:00Z created_at:<=${range.to}T23:59:59Z`;
  const days = new Map<string, SalesDay>();
  let after: string | undefined;
  for (let n = 0; n < MAX_PAGES; n++) {
    const orders = (await graphql(ctx, shop, c.accessToken, { q, after })).data?.orders;
    for (const o of orders?.nodes ?? []) {
      if (!o.createdAt || o.cancelledAt || SKIP_STATUS.has(o.displayFinancialStatus ?? "")) continue;
      const cur = /^[A-Za-z]{3}$/.test(o.totalPriceSet?.shopMoney?.currencyCode ?? "") ? o.totalPriceSet!.shopMoney!.currencyCode!.toUpperCase() : ctx.currency;
      const key = `${dayOf(o.createdAt)}|${cur}`;
      const d = days.get(key) ?? blank(dayOf(o.createdAt), cur);
      d.gross += toMinor(o.totalPriceSet?.shopMoney?.amount); d.tax += toMinor(o.totalTaxSet?.shopMoney?.amount);
      d.tips += toMinor(o.totalTipReceivedSet?.shopMoney?.amount); d.refunds += toMinor(o.totalRefundedSet?.shopMoney?.amount); d.transactions += 1;
      days.set(key, d);
    }
    if (!orders?.pageInfo?.hasNextPage || !orders.pageInfo.endCursor) break;
    after = orders.pageInfo.endCursor;
  }
  return { sales: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export const shopifyApp: Connector = {
  key: "shopify-app", name: "Shopify (one click)", category: "ecommerce", availability: "live", capabilities: ["sales.read"],
  summary: "Online shop orders, tax, tips and refunds from Shopify, day by day, connected by approving MAIZ on Shopify's own page.",
  note: "Read-only: only the read_orders permission is asked for. Without Shopify's extra approval to read old orders, Shopify only shares the last 60 days. Card fees are not in orders, so fees show 0. Customer details are never read.",
  auth: { kind: "oauth2", authorizeUrl: "https://my-shop.myshopify.com/admin/oauth/authorize", tokenUrl: "https://my-shop.myshopify.com/admin/oauth/access_token", scopes: [SCOPE], envPrefix: "SHOPIFY_APP" },
  connectFields: [{ key: "shop", label: "Shop address", help: "Your .myshopify.com address, for example my-shop.myshopify.com (not your own domain)." }],
  setup: {
    console: { href: "https://dev.shopify.com/dashboard", label: "Shopify Dev Dashboard" },
    steps: [
      "Open the Shopify Dev Dashboard and create an app for MAIZ.",
      "In the app's settings, add this page's Redirect URI as an allowed redirection URL, and give the app only the read_orders access.",
      "Copy the Client ID and Client secret from the app's settings into the boxes here, click Save, then Test connection.",
      "Choose how the app is offered to other shops. A listing in the Shopify App Store goes through Shopify's review. Until it is approved, only shops you install it on can connect.",
    ],
    approval: "Shopify's own review for a public listing. The time was not checked. Until then, shops can still connect with the paste-a-key Shopify card.",
  },
  validate(v) {
    try { shopAddress(v.shop); return undefined; } catch (e) { return e instanceof IntegrationError ? e.message : "That shop address does not look right."; }
  },
  authorizeUrl(app, state, _challenge, values) {
    const url = new URL(`https://${shopAddress(values?.shop)}/admin/oauth/authorize`);
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("redirect_uri", app.redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  },
  exchangeCode,
  refresh,
  read: readOrders,
};
