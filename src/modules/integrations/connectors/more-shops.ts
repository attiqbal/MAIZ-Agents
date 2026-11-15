import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records, type SalesDay } from "../types.js";
import { dayOf, getJson, keys, safeHost, sameHttpsHost, toMinor } from "./util.js";

/** BigCommerce and Squarespace shops: orders become day-by-day sales, like Shopify. Customer details are never read. */
const MAX_PAGES = 40;
const CUR = /^[A-Za-z]{3}$/;
const blank = (date: string, currency: string): SalesDay => ({ date, currency, gross: 0, tax: 0, tips: 0, fees: 0, refunds: 0, transactions: 0 });
const cur = (v: unknown, fb: string) => (typeof v === "string" && CUR.test(v) ? v.toUpperCase() : fb);

// ---------- BigCommerce ----------

interface BcOrder { date_created?: string; total_inc_tax?: string; total_tax?: string; currency_code?: string; refunded_amount?: string; status_id?: number }
/** BigCommerce order statuses that are not a sale: 0 incomplete, 1 pending, 5 cancelled, 6 declined. */
const BC_NOT_SALES = new Set([0, 1, 5, 6]);

async function readBigCommerce(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "BigCommerce");
  if (!/^[a-z0-9]{3,20}$/.test(k.storeHash ?? "")) throw new IntegrationError("The store hash looks wrong.");
  const days = new Map<string, SalesDay>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.bigcommerce.com/stores/${k.storeHash}/v2/orders?limit=250&page=${page}&min_date_created=${encodeURIComponent(new Date(`${range.from}T00:00:00Z`).toUTCString())}&max_date_created=${encodeURIComponent(new Date(`${range.to}T23:59:59Z`).toUTCString())}`;
    const rows: BcOrder[] = await getJson(ctx, url, { "x-auth-token": k.accessToken! }, "BigCommerce");
    const list = Array.isArray(rows) ? rows : [];
    for (const o of list) {
      const t = o.date_created ? Date.parse(o.date_created) : NaN;
      if (!Number.isFinite(t) || BC_NOT_SALES.has(o.status_id ?? 0)) continue;
      const date = dayOf(t), c = cur(o.currency_code, ctx.currency);
      const d = days.get(`${date}|${c}`) ?? blank(date, c);
      d.gross += toMinor(o.total_inc_tax); d.tax += toMinor(o.total_tax); d.refunds += toMinor(o.refunded_amount); d.transactions += 1;
      days.set(`${date}|${c}`, d);
    }
    if (list.length < 250) break;
  }
  return { sales: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export const bigcommerce: Connector = {
  key: "bigcommerce", name: "BigCommerce", category: "ecommerce", availability: "live", capabilities: ["sales.read"],
  summary: "Orders from your BigCommerce shop, day by day.",
  note: "Read-only: make the API account with Orders set to read-only. Customer details are never read.",
  auth: { kind: "api_key", fields: [
    { key: "storeHash", label: "Store hash", help: "The letters and numbers in your API path: https://api.bigcommerce.com/stores/THIS-PART/v3/." },
    { key: "accessToken", label: "Access token", help: "In BigCommerce: Settings, API, Store-level API accounts, Create API account. Orders: read-only, everything else None. Copy the Access token." },
  ] },
  read: readBigCommerce,
  validate(v) {
    if (!/^[a-z0-9]{3,20}$/.test(v.storeHash ?? "")) return "The store hash is 3 to 20 lower-case letters and numbers.";
    if (!/^[A-Za-z0-9]{20,100}$/.test(v.accessToken ?? "")) return "The access token is one code of letters and numbers with no spaces.";
    return undefined;
  },
};

// ---------- Squarespace ----------

interface SqOrder { createdOn?: string; grandTotal?: { value?: string; currency?: string }; taxTotal?: { value?: string }; refundedTotal?: { value?: string }; fulfillmentStatus?: string }

async function readSquarespace(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "Squarespace");
  const host = "api.squarespace.com";
  const days = new Map<string, SalesDay>();
  let url: string | undefined = `https://${host}/1.0/commerce/orders?modifiedAfter=${range.from}T00:00:00Z&modifiedBefore=${range.to}T23:59:59Z`;
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const body: { result?: SqOrder[]; pagination?: { hasNextPage?: boolean; nextPageUrl?: string } } = await getJson(ctx, url, { authorization: `Bearer ${k.apiKey}`, "user-agent": "MAIZ-Agents" }, "Squarespace");
    for (const o of body.result ?? []) {
      const t = o.createdOn ? Date.parse(o.createdOn) : NaN;
      if (!Number.isFinite(t) || dayOf(t) < range.from || dayOf(t) > range.to || o.fulfillmentStatus === "CANCELED") continue;
      const date = dayOf(t), c = cur(o.grandTotal?.currency, ctx.currency);
      const d = days.get(`${date}|${c}`) ?? blank(date, c);
      d.gross += toMinor(o.grandTotal?.value); d.tax += toMinor(o.taxTotal?.value); d.refunds += toMinor(o.refundedTotal?.value); d.transactions += 1;
      days.set(`${date}|${c}`, d);
    }
    url = body.pagination?.hasNextPage ? sameHttpsHost(body.pagination.nextPageUrl, host) : undefined;
  }
  return { sales: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export const squarespace: Connector = {
  key: "squarespace", name: "Squarespace", category: "ecommerce", availability: "live", capabilities: ["sales.read"],
  summary: "Orders from your Squarespace shop, day by day.",
  note: "Read-only: make the key with the Orders permission set to read. Squarespace's Commerce API needs a Commerce Advanced plan or an eligible Business plan. Customer details are never read.",
  auth: { kind: "api_key", fields: [{ key: "apiKey", label: "Squarespace API key", help: "In Squarespace: Settings, Developer tools, API keys, Generate key. Permission: Orders (read). Copy the key." }] },
  read: readSquarespace,
  validate: (v) => (/^[A-Za-z0-9_-]{20,200}$/.test(v.apiKey ?? "") ? undefined : "A Squarespace key is one code with no spaces."),
};

void safeHost;
