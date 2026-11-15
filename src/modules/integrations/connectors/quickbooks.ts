import { IntegrationError, type AccountsMonth, type Connector, type ConnectorContext, type DateRange, type OAuthApp, type Records, type Credentials } from "../types.js";
import { monthsIn } from "./xero.js";
import { getJson, oauth, toMinor } from "./util.js";

/**
 * QuickBooks Online (accounting), public OAuth 2.0 API. Reads the Profit and Loss report month by month, the same
 * shape as Xero, so employees work from the owner's real books. Read-only; the books stay in QuickBooks.
 * Access tokens last an hour and the refresh token rotates. QuickBooks sends the company id (realmId) beside the code.
 */
const TOKEN = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const base = () => process.env.QUICKBOOKS_BASE_URL ?? "https://quickbooks.api.intuit.com";
const basic = (app: OAuthApp) => `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;

async function token(http: typeof fetch, app: OAuthApp, form: Record<string, string>) {
  const res = await http(TOKEN, { method: "POST", redirect: "error", headers: { authorization: basic(app), "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form) });
  const o = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!res.ok || !o.access_token) throw new IntegrationError("QuickBooks did not approve the connection. Please connect QuickBooks again.");
  return { accessToken: o.access_token, refreshToken: o.refresh_token, expiresAt: new Date(Date.now() + (o.expires_in ?? 3600) * 1000).toISOString() };
}

interface QbRow { group?: string; Summary?: { ColData?: { value?: string }[] }; Rows?: { Row?: QbRow[] } }

/** Picks the group totals (Income, COGS, Expenses, NetIncome) out of QuickBooks' report rows. */
export function parseQuickBooksProfitAndLoss(report: { Rows?: { Row?: QbRow[] } }, month: string, currency: string): AccountsMonth {
  const total = (g: string) => {
    const row = (report.Rows?.Row ?? []).find((r) => r.group === g);
    return toMinor(row?.Summary?.ColData?.[1]?.value);
  };
  const income = total("Income") + total("OtherIncome");
  const costOfSales = total("COGS");
  const expenses = total("Expenses") + total("OtherExpenses");
  const hasNet = (report.Rows?.Row ?? []).some((r) => r.group === "NetIncome");
  return { month, currency, income, costOfSales, expenses, netProfit: hasNet ? total("NetIncome") : income - costOfSales - expenses };
}

async function readQuickBooks(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken, tenant } = oauth(ctx, "QuickBooks");
  if (!tenant) throw new IntegrationError("Please connect QuickBooks again so we can see which company you chose.");
  const accounts: AccountsMonth[] = [];
  for (const month of monthsIn(range)) {
    const [y, m] = month.split("-").map(Number) as [number, number];
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const url = `${base()}/v3/company/${encodeURIComponent(tenant)}/reports/ProfitAndLoss?start_date=${month}-01&end_date=${last}&accounting_method=Accrual&minorversion=75`;
    const body = await getJson(ctx, url, { authorization: `Bearer ${accessToken}` }, "QuickBooks");
    const currency = typeof body?.Header?.Currency === "string" ? body.Header.Currency : ctx.currency;
    accounts.push(parseQuickBooksProfitAndLoss(body, month, currency));
  }
  return { accounts };
}

export const quickbooks: Connector = {
  key: "quickbooks", name: "QuickBooks Online", category: "accounting", availability: "live", capabilities: ["accounts.read"],
  summary: "Your books in QuickBooks: profit and loss month by month, so your team works from real numbers.",
  note: "Read-only. Your books stay in QuickBooks; we never change them.",
  auth: { kind: "oauth2", authorizeUrl: "https://appcenter.intuit.com/connect/oauth2", tokenUrl: TOKEN, scopes: ["com.intuit.quickbooks.accounting"], envPrefix: "QUICKBOOKS", tokenAuth: "basic" },
  setup: {
    console: { href: "https://developer.intuit.com/app/developer/dashboard", label: "Intuit developer dashboard" },
    steps: [
      "Create a free Intuit developer account and create an app (choose QuickBooks Online and Payments, with the Accounting scope).",
      "Under Keys and credentials, switch to Production keys. Intuit asks a short questionnaire about your app (privacy page, terms, where data is stored) before it shows them. Use your own privacy and terms pages.",
      "Add the Redirect URI shown on this page, then copy the Client ID and Client secret into the boxes here.",
    ],
    approval: "Intuit reviews the production questionnaire. It is usually a few days. Until then the sandbox keys work for testing only.",
  },
  read: readQuickBooks,
  async exchangeCode(http, app, code, params) {
    const realm = params?.realmId;
    if (!realm) throw new IntegrationError("QuickBooks did not say which company you chose. Please try again.");
    const t = await token(http, app, { grant_type: "authorization_code", code, redirect_uri: app.redirectUri });
    return { credentials: { kind: "oauth2", ...t, tenant: realm }, externalAccount: `Company ${realm}` };
  },
  async refresh(http, app, creds: Credentials) {
    if (creds.kind !== "oauth2" || !creds.refreshToken) throw new IntegrationError("Please connect QuickBooks again.");
    const t = await token(http, app, { grant_type: "refresh_token", refresh_token: creds.refreshToken });
    return { ...creds, ...t, refreshToken: t.refreshToken ?? creds.refreshToken };
  },
};
