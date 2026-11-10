import { toMinor } from "../csv.js";
import { IntegrationError, type AccountsMonth, type Connector, type ConnectorContext, type Credentials, type DateRange, type OAuthApp, type Records } from "../types.js";

/**
 * Xero (accounting), public OAuth 2.0 API.
 * Reads the Profit and Loss report month by month, so employees work from the owner's real books.
 * The owner's books stay in Xero: we never copy Xero figures into our own ledger (that would count them twice).
 *
 * Facts checked 2026-11: apps created on or after 2 March 2026 must ask for granular scopes
 * (accounting.reports.profitandloss.read). Access tokens last 30 minutes, so we refresh before reading.
 * Xero now prices developer apps by number of connected organisations: check the tier before launch.
 */
const LOGIN = "https://login.xero.com/identity/connect/authorize";
const TOKEN = "https://identity.xero.com/connect/token";
const API = "https://api.xero.com";
/** At most a year of months per sync, to stay well inside Xero's 60 calls a minute. */
const MAX_MONTHS = 12;

const basic = (app: OAuthApp) => `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;

async function token(http: typeof fetch, app: OAuthApp, form: Record<string, string>) {
  const res = await http(TOKEN, { method: "POST", headers: { authorization: basic(app), "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form) });
  const o = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!res.ok || !o.access_token) throw new IntegrationError("Xero did not approve the connection. Please connect Xero again.");
  return { accessToken: o.access_token, refreshToken: o.refresh_token, expiresAt: new Date(Date.now() + (o.expires_in ?? 1800) * 1000).toISOString() };
}

/** Months (YYYY-MM) touched by a date range, newest last. */
export function monthsIn(range: DateRange): string[] {
  const out: string[] = [];
  let [y, m] = range.from.slice(0, 7).split("-").map(Number) as [number, number];
  const end = range.to.slice(0, 7);
  for (let guard = 0; guard < 240; guard++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= end) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out.slice(-MAX_MONTHS);
}

interface Row { RowType?: string; Title?: string; Cells?: { Value?: string }[]; Rows?: Row[] }

/** Picks totals out of Xero's report rows by their labels ("Total Income", "Net Profit"). */
export function parseXeroProfitAndLoss(report: { Rows?: Row[] }, month: string, currency: string): AccountsMonth {
  const totals = new Map<string, number>();
  const walk = (rows: Row[] | undefined) => {
    for (const r of rows ?? []) {
      const label = r.Cells?.[0]?.Value?.trim().toLowerCase();
      const value = toMinor(r.Cells?.[r.Cells.length - 1]?.Value);
      if (label && value !== undefined && (r.RowType === "SummaryRow" || r.RowType === "Row")) totals.set(label, value);
      walk(r.Rows);
    }
  };
  walk(report.Rows);
  const get = (...labels: string[]) => labels.reduce((n, l) => n + (totals.get(l) ?? 0), 0);
  const income = get("total income", "total trading income", "total other income");
  const costOfSales = get("total cost of sales", "total direct costs");
  const expenses = get("total operating expenses", "total expenses", "total overheads");
  const net = totals.get("net profit") ?? income - costOfSales - expenses;
  return { month, currency, income, costOfSales, expenses, netProfit: net };
}

async function readXero(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const c = ctx.credentials;
  if (c.kind !== "oauth2" || !c.tenant) throw new IntegrationError("Please connect Xero again and pick your organisation.");
  const accounts: AccountsMonth[] = [];
  for (const month of monthsIn(range)) {
    const [y, m] = month.split("-").map(Number) as [number, number];
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const url = `${API}/api.xro/2.0/Reports/ProfitAndLoss?fromDate=${month}-01&toDate=${last}`;
    const res = await ctx.http(url, { headers: { authorization: `Bearer ${c.accessToken}`, "xero-tenant-id": c.tenant, accept: "application/json" } });
    if (res.status === 401 || res.status === 403) throw new IntegrationError("Xero refused access. Please connect Xero again.");
    if (res.status === 429) throw new IntegrationError("Xero asked us to slow down. Try again in a minute.");
    if (!res.ok) throw new IntegrationError(`Xero answered ${res.status}`);
    const body = (await res.json()) as { Reports?: { Rows?: Row[] }[] };
    accounts.push(parseXeroProfitAndLoss(body.Reports?.[0] ?? {}, month, ctx.currency));
  }
  return { accounts };
}

export const xero: Connector = {
  key: "xero",
  name: "Xero",
  category: "accounting",
  summary: "Your books in Xero: profit and loss month by month, so your team works from real numbers.",
  availability: "live",
  capabilities: ["accounts.read"],
  note: "Read-only. Your books stay in Xero; we never change them. If BrightPay or your till posts into Xero, that shows up here too.",
  auth: {
    kind: "oauth2",
    authorizeUrl: LOGIN,
    tokenUrl: TOKEN,
    scopes: ["openid", "offline_access", "accounting.reports.profitandloss.read"],
    envPrefix: "XERO",
  },
  read: readXero,
  async exchangeCode(http, app, code) {
    const t = await token(http, app, { grant_type: "authorization_code", code, redirect_uri: app.redirectUri });
    // One Xero login can reach several organisations. We take the one the owner just approved (the most recent).
    const res = await http(`${API}/connections`, { headers: { authorization: `Bearer ${t.accessToken}`, accept: "application/json" } });
    const list = (await res.json().catch(() => [])) as { tenantId?: string; tenantName?: string; updatedDateUtc?: string }[];
    const org = [...(Array.isArray(list) ? list : [])].sort((a, b) => String(b.updatedDateUtc ?? "").localeCompare(String(a.updatedDateUtc ?? "")))[0];
    if (!org?.tenantId) throw new IntegrationError("Xero did not share an organisation. Please try again and pick one.");
    return { credentials: { kind: "oauth2", ...t, tenant: org.tenantId }, externalAccount: org.tenantName ?? org.tenantId };
  },
  async refresh(http, app, creds: Credentials) {
    if (creds.kind !== "oauth2" || !creds.refreshToken) throw new IntegrationError("Please connect Xero again.");
    const t = await token(http, app, { grant_type: "refresh_token", refresh_token: creds.refreshToken });
    // Xero rotates refresh tokens: the new one must replace the old one.
    return { ...creds, ...t, refreshToken: t.refreshToken ?? creds.refreshToken };
  },
};
