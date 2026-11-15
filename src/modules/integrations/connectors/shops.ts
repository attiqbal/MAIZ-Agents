import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records, type SalesDay } from "../types.js";
import { assertPublicHost, dayOf, keys, publicSite, safeHost, sameHttpsHost, toMinor } from "./util.js";

/**
 * Online shops: Shopify and WooCommerce. Orders become the same day-by-day sales records as a till, so the Finance
 * manager and the books work as they do for Square. Customer names and addresses are never read.
 */
const MAX_PAGES = 40;
const SHOPIFY_VERSION = "2026-07";

const CUR = /^[A-Za-z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const currencyOf = (v: unknown, fallback: string): string => (typeof v === "string" && CUR.test(v) ? v.toUpperCase() : fallback);

const blank = (date: string, currency: string): SalesDay => ({ date, currency, gross: 0, tax: 0, tips: 0, fees: 0, refunds: 0, transactions: 0 });

async function fetchJson(ctx: ConnectorContext, url: string, init: RequestInit, app: string): Promise<{ body: any; link?: string }> {
  let res: Response;
  try { res = await ctx.http(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) }); } catch { throw new IntegrationError(`${app} could not be reached. Try again in a minute.`); }
  if (res.status === 401 || res.status === 403) throw new IntegrationError(`${app} refused access. Check the details you pasted, and that they can read orders.`);
  if (res.status === 429) throw new IntegrationError(`${app} asked us to slow down. Try again in a few minutes.`);
  if (!res.ok) throw new IntegrationError(app === "WooCommerce" ? "WooCommerce could not read orders. Check the address and that the key has Read permission." : `${app} answered ${res.status}`);
  try { return { body: await res.json(), link: res.headers.get("link") ?? undefined }; } catch { throw new IntegrationError(`${app} sent something we could not read`); }
}

// ---------- Shopify ----------

interface ShopifyOrder {
  created_at?: string; cancelled_at?: string | null; financial_status?: string; currency?: string;
  total_price?: string; total_tax?: string; total_tip_received?: string;
  refunds?: { transactions?: { amount?: string; kind?: string }[] }[];
}

/** Shopify now hands new shops an app with a client id and secret; the token it gives lasts a day. */
async function shopifyToken(ctx: ConnectorContext, host: string, id: string, secret: string): Promise<string> {
  const { body } = await fetchJson(ctx, `https://${host}/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: "client_credentials" }) }, "Shopify");
  if (typeof body?.access_token !== "string") throw new IntegrationError("Shopify did not give access. Check the Client ID and Secret, and that the app is installed on your shop.");
  return body.access_token;
}

async function readShopify(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "Shopify");
  const host = safeHost(k.shop!, /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/, "shop address");
  const token = await shopifyToken(ctx, host, k.clientId!, k.clientSecret!);
  const days = new Map<string, SalesDay>();
  let url: string | undefined = `https://${host}/admin/api/${SHOPIFY_VERSION}/orders.json?status=any&limit=250&created_at_min=${range.from}T00:00:00Z&created_at_max=${range.to}T23:59:59Z&fields=created_at,cancelled_at,financial_status,currency,total_price,total_tax,total_tip_received,refunds`;
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const { body, link } = await fetchJson(ctx, url, { headers: { "x-shopify-access-token": token, accept: "application/json" } }, "Shopify");
    for (const o of (body.orders ?? []) as ShopifyOrder[]) {
      if (!o.created_at || o.cancelled_at || ["voided", "pending", "authorized"].includes(o.financial_status ?? "")) continue;
      const date = dayOf(o.created_at);
      const cur = currencyOf(o.currency, ctx.currency);
      const key = `${date}|${cur}`;
      const d = days.get(key) ?? blank(date, cur);
      d.gross += toMinor(o.total_price); d.tax += toMinor(o.total_tax); d.tips += toMinor(o.total_tip_received); d.transactions += 1;
      for (const r of o.refunds ?? []) for (const t of r.transactions ?? []) if (t.kind === "refund") d.refunds += toMinor(t.amount);
      days.set(key, d);
    }
    const next = /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1];
    url = sameHttpsHost(next, host);
  }
  return { sales: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export const shopify: Connector = {
  key: "shopify", name: "Shopify", category: "ecommerce", availability: "live", capabilities: ["sales.read"],
  summary: "Online shop orders, tax, tips and refunds from Shopify, day by day.",
  note: "Read-only: the app you create needs only the read_orders permission. Card fees are not in orders, so fees show 0. Customer details are never read.",
  auth: { kind: "api_key", fields: [
    { key: "shop", label: "Shop address", help: "Your .myshopify.com address, for example my-shop.myshopify.com (not your own domain)." },
    { key: "clientId", label: "Client ID", help: "From the app you made in the Shopify Dev Dashboard (Settings)." },
    { key: "clientSecret", label: "Client secret", help: "Next to the Client ID. Install the app on your shop first, with only the read_orders access." },
  ] },
  read: readShopify,
  validate(v) {
    if (!/^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/i.test((v.shop ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, ""))) return "Use your shop's .myshopify.com address, for example my-shop.myshopify.com.";
    if (!/^[\x21-\x7e]{8,200}$/.test(v.clientId ?? "") || !/^[\x21-\x7e]{8,200}$/.test(v.clientSecret ?? "")) return "The Client ID and secret are single codes with no spaces. Copy them again in full.";
    return undefined;
  },
};

// ---------- WooCommerce ----------

interface WooOrder { date_created_gmt?: string; status?: string; currency?: string; total?: string; total_tax?: string; refunds?: { total?: string }[] }

async function readWoo(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "WooCommerce");
  const site = publicSite(k.siteUrl!, "shop address");
  const auth = `Basic ${Buffer.from(`${k.consumerKey}:${k.consumerSecret}`).toString("base64")}`;
  await assertPublicHost(site.hostname, "WooCommerce");
  const days = new Map<string, SalesDay>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${site.origin}/wp-json/wc/v3/orders?per_page=100&page=${page}&after=${range.from}T00:00:00&before=${range.to}T23:59:59&dates_are_gmt=true&status=any`;
    const { body } = await fetchJson(ctx, url, { headers: { authorization: auth, accept: "application/json" } }, "WooCommerce");
    const rows = Array.isArray(body) ? (body as WooOrder[]) : [];
    for (const o of rows) {
      if (!o.date_created_gmt || !["completed", "processing", "on-hold", "refunded"].includes(o.status ?? "")) continue;
      const date = o.date_created_gmt.slice(0, 10);
      if (!DATE.test(date)) continue;
      const cur = currencyOf(o.currency, ctx.currency);
      const key = `${date}|${cur}`;
      const d = days.get(key) ?? blank(date, cur);
      d.gross += toMinor(o.total); d.tax += toMinor(o.total_tax); d.transactions += 1;
      for (const r of o.refunds ?? []) d.refunds += Math.abs(toMinor(r.total));
      days.set(key, d);
    }
    if (rows.length < 100) break;
  }
  return { sales: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export const woocommerce: Connector = {
  key: "woocommerce", name: "WooCommerce", category: "ecommerce", availability: "live", capabilities: ["sales.read"],
  summary: "Orders from your WooCommerce shop, day by day.",
  note: "Read-only: make the key with Read permission only. Your shop must use https. Customer details are never read.",
  auth: { kind: "api_key", fields: [
    { key: "siteUrl", label: "Shop address", help: "Your shop's web address, for example https://myshop.co.uk." },
    { key: "consumerKey", label: "Consumer key", help: "In WordPress: WooCommerce, Settings, Advanced, REST API, Add key. Permissions: Read. Starts with ck_." },
    { key: "consumerSecret", label: "Consumer secret", help: "Shown once beside the key. Starts with cs_." },
  ] },
  read: readWoo,
  validate(v) {
    try { publicSite(v.siteUrl ?? "", "shop address"); } catch (e) { return e instanceof IntegrationError ? e.message : "That shop address does not look right."; }
    if (!/^ck_[A-Za-z0-9]{20,80}$/.test(v.consumerKey ?? "")) return "The consumer key starts with ck_ and has no spaces.";
    if (!/^cs_[A-Za-z0-9]{20,80}$/.test(v.consumerSecret ?? "")) return "The consumer secret starts with cs_ and has no spaces.";
    return undefined;
  },
};
