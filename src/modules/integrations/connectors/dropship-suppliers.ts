import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records } from "../types.js";
import { DayBook, dayOf, getJson, inRange, keys } from "./util.js";

/**
 * Suppliers for the Dropshipping agent. Each client pastes their own supplier token, so the platform owner has
 * nothing to register. Only counts are read (open orders, orders with a problem, fulfilled orders, products out of
 * stock). Shopper names and addresses sit inside supplier orders and are never read or kept.
 *
 * Interfaces checked against the providers' own developer pages on 2026-11-17:
 *  - Printful: https://developers.printful.com/docs/ (Bearer private token, GET /orders, GET /store/products)
 *  - Printify: https://developers.printify.com/ and its openapi.json (Bearer personal access token, shops, orders, products)
 *  - CJ Dropshipping: https://developers.cjdropshipping.com/ (API key swapped for an access token); only the sign-in page
 *    was read, so it stays "planned".
 * Spocket, Zendrop and AliExpress Dropshipping were looked for and left out: no public developer page that could be read
 * and confirmed was found.
 */
const MAX_PAGES = 6;
const PRINTFUL = "https://api.printful.com";
const PRINTIFY = "https://api.printify.com/v1";
const TOKEN = /^[\x21-\x7e]{20,2000}$/;
const TOKEN_HELP = "A single code with no spaces. Copy it again in full.";

// ---------- Printful ----------

interface PrintfulList { paging?: { total?: number }; result?: { id?: number; status?: string; created?: number }[] }

/** Printful: live orders are counted straight from its totals; failed and held orders from the last 30 days. */
async function readPrintful(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "Printful");
  const headers = { authorization: `Bearer ${k.token}` };
  const get = (path: string): Promise<PrintfulList> => getJson(ctx, `${PRINTFUL}${path}`, headers, "Printful");
  const total = async (path: string): Promise<number> => Number((await get(path)).paging?.total) || 0;
  const book = new DayBook("supply", ctx.currency);
  let open = 0;
  for (const status of ["pending", "inprocess", "partial"]) open += await total(`/orders?status=${status}&limit=1`);
  let problem = 0;
  for (const status of ["failed", "onhold"]) {
    const rows = (await get(`/orders?status=${status}&limit=100`)).result ?? [];
    problem += rows.filter((o) => inRange((o.created ?? 0) * 1000, range.from, range.to)).length;
  }
  let outOfStock = 0;
  for (const status of ["out_of_stock", "discontinued"]) outOfStock += await total(`/store/products?status=${status}&limit=1`);
  for (const o of (await get("/orders?status=fulfilled&limit=100")).result ?? []) {
    if (inRange((o.created ?? 0) * 1000, range.from, range.to)) book.add(dayOf((o.created ?? 0) * 1000), "ordersFulfilled");
  }
  book.set(range.to, "ordersOpen", open);
  book.set(range.to, "ordersProblem", problem);
  book.set(range.to, "outOfStock", outOfStock);
  return { activity: book.list() };
}

export const printful: Connector = {
  key: "printful", name: "Printful", category: "ecommerce", availability: "live", capabilities: ["suppliers.read"],
  summary: "How many of your Printful orders are open, held or fulfilled, and how many products are out of stock.",
  note: "Read-only counts. Make the token with only the permission to view orders and products. Fulfilled orders are counted on the day they were placed. Shoppers' names and addresses are never read.",
  auth: { kind: "api_key", fields: [{ key: "token", label: "Printful private token", help: "In Printful: Developer Portal, Private tokens, then create one for your store with only the view orders and view products permissions. It is shown once." }] },
  read: readPrintful,
  validate: (v) => (TOKEN.test(v.token ?? "") ? undefined : `A Printful token ${TOKEN_HELP}`),
};

// ---------- Printify ----------

interface PrintifyOrder { status?: string; created_at?: string; line_items?: { status_details?: unknown }[] }
interface PrintifyProduct { variants?: { is_enabled?: boolean; is_available?: boolean }[] }
interface PrintifyPage<T> { data?: T[]; last_page?: number }

const hasIssue = (o: PrintifyOrder): boolean => (o.line_items ?? []).some((l) => (Array.isArray(l.status_details) ? l.status_details.length > 0 : typeof l.status_details === "string" && l.status_details !== ""));

async function pages<T>(ctx: ConnectorContext, url: string, headers: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body: PrintifyPage<T> = await getJson(ctx, `${url}${url.includes("?") ? "&" : "?"}limit=50&page=${page}`, headers, "Printify");
    out.push(...(body.data ?? []));
    if (page >= (Number(body.last_page) || 1)) break;
  }
  return out;
}

async function readPrintify(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "Printify");
  // Printify asks every caller to name itself in a User-Agent header.
  const headers = { authorization: `Bearer ${k.token}`, "user-agent": "MAIZ-Agents" };
  const shops: { id?: number }[] = await getJson(ctx, `${PRINTIFY}/shops.json`, headers, "Printify");
  if (!Array.isArray(shops) || !shops.length) throw new IntegrationError("Printify shows no shop on this token. Check you made the token on the right account.");
  const book = new DayBook("supply", ctx.currency);
  let open = 0, problem = 0, outOfStock = 0;
  for (const shop of shops.slice(0, 5)) {
    const id = Number(shop.id);
    if (!Number.isInteger(id) || id < 1) continue;
    for (const o of await pages<PrintifyOrder>(ctx, `${PRINTIFY}/shops/${id}/orders.json`, headers)) {
      if (!inRange(o.created_at, range.from, range.to)) continue;
      const status = (o.status ?? "").toLowerCase();
      if (status === "fulfilled") book.add(dayOf(o.created_at!), "ordersFulfilled");
      else if (!status.includes("cancel")) open++;
      if (hasIssue(o)) problem++;
    }
    for (const p of await pages<PrintifyProduct>(ctx, `${PRINTIFY}/shops/${id}/products.json`, headers)) {
      if ((p.variants ?? []).some((v) => v.is_enabled === true && v.is_available === false)) outOfStock++;
    }
  }
  book.set(range.to, "ordersOpen", open);
  book.set(range.to, "ordersProblem", problem);
  book.set(range.to, "outOfStock", outOfStock);
  return { activity: book.list() };
}

export const printify: Connector = {
  key: "printify", name: "Printify", category: "ecommerce", availability: "live", capabilities: ["suppliers.read"],
  summary: "How many of your Printify orders are open, have a problem or are fulfilled, and how many products have a variant that is unavailable.",
  note: "Read-only counts from the last 30 days. Make the token with only the permission to view orders and products. Shoppers' names and addresses are never read.",
  auth: { kind: "api_key", fields: [{ key: "token", label: "Printify personal access token", maxLength: 2000, help: "In Printify: your profile, Connections, API token, Generate. It is a very long code shown once, so copy all of it." }] },
  read: readPrintify,
  validate: (v) => (TOKEN.test(v.token ?? "") ? undefined : `A Printify token ${TOKEN_HELP}`),
};

// ---------- Listed, not connected yet ----------

export const cjDropshipping: Connector = {
  key: "cj-dropshipping", name: "CJ Dropshipping", category: "ecommerce", availability: "planned", capabilities: ["suppliers.read"],
  summary: "Supplier orders and stock from CJ Dropshipping.",
  note: "CJ Dropshipping has a public developer interface that swaps an API key from your CJ account for an access token. Direct connection is planned. Until then, connect it through Zapier or Make.",
  auth: { kind: "bridge" },
};

export const DROPSHIP_SUPPLIERS: readonly Connector[] = [printful, printify, cjDropshipping];
