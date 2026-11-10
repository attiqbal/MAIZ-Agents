import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records, type SalesDay } from "../types.js";
import { parseTillCsv } from "./till-csv.js";

/**
 * Square (till and card payments), public OAuth API.
 * Reads completed payments and adds them up per day. Square keeps sales tax on orders, not
 * payments, so tax is 0 here and flagged; reading the Orders API is the next step.
 * Days are UTC days; a shop far from UTC may see late sales on the next day.
 */
const BASE = process.env.SQUARE_BASE_URL ?? "https://connect.squareup.com";
const SQUARE_VERSION = "2025-01-23";
/** Safety stop: 50 pages of 100 payments per sync. */
const MAX_PAGES = 50;

interface Money { amount?: number; currency?: string }
interface Payment {
  status?: string;
  created_at?: string;
  amount_money?: Money;
  tip_money?: Money;
  refunded_money?: Money;
  processing_fee?: { amount_money?: Money }[];
}

async function readSquare(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  if (ctx.credentials.kind !== "oauth2") throw new IntegrationError("square needs an OAuth connection");
  const days = new Map<string, SalesDay>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${BASE}/v2/payments`);
    url.searchParams.set("begin_time", `${range.from}T00:00:00Z`);
    url.searchParams.set("end_time", `${range.to}T23:59:59Z`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await ctx.http(url.toString(), {
      headers: { authorization: `Bearer ${ctx.credentials.accessToken}`, "square-version": SQUARE_VERSION, accept: "application/json" },
    });
    if (res.status === 401) throw new IntegrationError("Square says the connection has expired. Please connect Square again.");
    if (!res.ok) throw new IntegrationError(`Square answered ${res.status}`);
    const body = (await res.json()) as { payments?: Payment[]; cursor?: string };
    for (const p of body.payments ?? []) addPayment(days, p, ctx.currency);
    cursor = body.cursor;
    if (!cursor) break;
  }
  return { sales: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

function addPayment(days: Map<string, SalesDay>, p: Payment, fallbackCurrency: string): void {
  if (p.status !== "COMPLETED" || !p.created_at) return;
  const date = p.created_at.slice(0, 10);
  const currency = p.amount_money?.currency ?? fallbackCurrency;
  const day = days.get(date) ?? { date, currency, gross: 0, tax: 0, tips: 0, fees: 0, refunds: 0, transactions: 0 };
  day.gross += p.amount_money?.amount ?? 0;
  day.tips += p.tip_money?.amount ?? 0;
  day.refunds += p.refunded_money?.amount ?? 0;
  day.fees += (p.processing_fee ?? []).reduce((n, f) => n + Math.abs(f.amount_money?.amount ?? 0), 0);
  day.transactions += 1;
  days.set(date, day);
}

export const square: Connector = {
  key: "square",
  name: "Square",
  category: "till",
  summary: "Card payments and till sales from Square, read every day.",
  availability: "live",
  capabilities: ["sales.read"],
  note: "Read-only. We can see payments, never take or move money.",
  auth: {
    kind: "oauth2",
    authorizeUrl: `${BASE}/oauth2/authorize`,
    tokenUrl: `${BASE}/oauth2/token`,
    scopes: ["PAYMENTS_READ", "MERCHANT_PROFILE_READ"],
    envPrefix: "SQUARE",
    authorizeParams: { session: "false" },
  },
  read: readSquare,
  // Square's own transactions export also works when the owner prefers a file.
  parseFile: parseTillCsv,
  async exchangeCode(http, app, code) {
    const res = await http(`${BASE}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "square-version": SQUARE_VERSION },
      body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code, grant_type: "authorization_code", redirect_uri: app.redirectUri }),
    });
    const o = (await res.json()) as { access_token?: string; refresh_token?: string; expires_at?: string; merchant_id?: string };
    if (!res.ok || !o.access_token) throw new IntegrationError("Square did not approve the connection");
    return { credentials: { kind: "oauth2", accessToken: o.access_token, refreshToken: o.refresh_token, expiresAt: o.expires_at }, externalAccount: o.merchant_id };
  },
};
