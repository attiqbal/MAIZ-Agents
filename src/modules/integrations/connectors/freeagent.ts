import { IntegrationError, type AccountsMonth, type Connector, type ConnectorContext, type DateRange, type Records } from "../types.js";
import { exchange, makeRefresh } from "./oauth-util.js";
import { toMinor } from "./util.js";
import { monthsIn } from "./xero.js";

/**
 * FreeAgent (accounting, mostly UK sole traders and small companies), public OAuth 2.0 API.
 * Reads the profit and loss summary month by month, as for Xero and QuickBooks: the books stay in FreeAgent and are
 * never copied into our own ledger.
 *
 * Checked against FreeAgent's own developer pages on 2026-11-17:
 *  - https://dev.freeagent.com/docs/oauth: authorize at /v2/approve_app, tokens at /v2/token_endpoint with the Client ID
 *    and secret as HTTP Basic, access token one hour, the refresh answer carries a new refresh token. No scopes. The page
 *    names no review before other businesses can connect.
 *  - https://dev.freeagent.com/docs/profit_and_loss: GET /v2/accounting/profit_and_loss/summary?from_date&to_date answers
 *    income, expenses and operating_profit as decimal strings in the company's own currency. It has no cost of sales line,
 *    so that stays 0 and expenses carry the whole cost.
 */
const API = "https://api.freeagent.com";
const TOKEN = `${API}/v2/token_endpoint`;
const AGENT = "MAIZ Agents";

interface Summary { profit_and_loss_summary?: { income?: string; expenses?: string; operating_profit?: string } }

export function freeAgentMonth(body: Summary, month: string, currency: string): AccountsMonth {
  const s = body.profit_and_loss_summary ?? {};
  const income = toMinor(s.income);
  const expenses = toMinor(s.expenses);
  return { month, currency, income, costOfSales: 0, expenses, netProfit: s.operating_profit === undefined ? income - expenses : toMinor(s.operating_profit) };
}

async function readFreeAgent(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const c = ctx.credentials;
  if (c.kind !== "oauth2") throw new IntegrationError("Please connect FreeAgent again.");
  const accounts: AccountsMonth[] = [];
  for (const month of monthsIn(range)) {
    const [y, m] = month.split("-").map(Number) as [number, number];
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    let res: Response;
    try {
      res = await ctx.http(`${API}/v2/accounting/profit_and_loss/summary?from_date=${month}-01&to_date=${last}`, { redirect: "error", signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${c.accessToken}`, accept: "application/json", "user-agent": AGENT } });
    } catch { throw new IntegrationError("FreeAgent could not be reached. Try again in a minute."); }
    if (res.status === 401 || res.status === 403) throw new IntegrationError("FreeAgent refused access. Please connect FreeAgent again.");
    if (res.status === 429) throw new IntegrationError("FreeAgent asked us to slow down. Try again in a few minutes.");
    if (!res.ok) throw new IntegrationError(`FreeAgent answered ${res.status}`);
    accounts.push(freeAgentMonth((await res.json().catch(() => ({}))) as Summary, month, ctx.currency));
  }
  return { accounts };
}

export const freeagent: Connector = {
  key: "freeagent", name: "FreeAgent", category: "accounting", availability: "live", capabilities: ["accounts.read"],
  summary: "Your books in FreeAgent: income, expenses and profit month by month, so your team works from real numbers.",
  note: "Read-only. Your books stay in FreeAgent; we never change them. FreeAgent gives no cost of sales line, so costs show under expenses. Figures are in the currency of your FreeAgent company.",
  regions: ["GB", "IE", "US"],
  auth: { kind: "oauth2", authorizeUrl: `${API}/v2/approve_app`, tokenUrl: TOKEN, scopes: [], envPrefix: "FREEAGENT", tokenAuth: "basic" },
  setup: {
    console: { href: "https://dev.freeagent.com/", label: "FreeAgent Developer Dashboard" },
    steps: [
      "Sign in to the FreeAgent Developer Dashboard with your FreeAgent login and create a new app.",
      "Add this page's Redirect URI as the app's OAuth redirect URI.",
      "Copy the OAuth identifier (Client ID) and OAuth secret into the boxes here, click Save, then Test connection.",
    ],
    approval: "FreeAgent's own page names no review before other businesses connect. This was not tried with a real account.",
  },
  authorizeUrl(app, state) {
    const url = new URL(`${API}/v2/approve_app`);
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", app.redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  },
  async exchangeCode(http, app, code) {
    const { credentials } = await exchange(http, "FreeAgent", TOKEN, app, code, undefined, { basic: true });
    return { credentials };
  },
  refresh: makeRefresh("FreeAgent", TOKEN, { basic: true }),
  read: readFreeAgent,
};
