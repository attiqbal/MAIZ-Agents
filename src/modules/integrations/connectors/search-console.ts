import { googleApi, googleExchange, googleRefresh, plainWords, GOOGLE_AUTHORIZE, GOOGLE_PARAMS, GOOGLE_TOKEN } from "./google.js";
import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records, type SearchDay } from "../types.js";

/**
 * Google Search Console: how often the site appears in Google, how many click, the average position and the
 * searches that bring the most clicks. Read-only. Google's figures run about three days behind.
 */
const API = "https://www.googleapis.com/webmasters/v3";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
/** A domain property or a full address; it goes into a URL path (percent-encoded), so no spaces or control characters. */
export const SITE = /^(sc-domain:[a-z0-9.-]{1,253}|https?:\/\/[^\s]{1,300})$/i;
const DAY_MS = 86_400_000;
const LAG_DAYS = 3;
const TOP_DAYS = 28;

interface Rows { rows?: { keys?: string[]; clicks?: number; impressions?: number; position?: number }[] }
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const addDays = (date: string, k: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + k * DAY_MS).toISOString().slice(0, 10);

/** One record per day, and the top searches on the newest day. Exported for tests. */
export function parseSearch(byDay: Rows, byQuery: Rows): SearchDay[] {
  const days: SearchDay[] = [];
  for (const r of byDay.rows ?? []) {
    const date = r.keys?.[0];
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) days.push({ date, clicks: n(r.clicks), impressions: n(r.impressions), position: Math.round(n(r.position) * 10) / 10 });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  const top = (byQuery.rows ?? []).map((r) => ({ query: plainWords(r.keys?.[0], 60), clicks: n(r.clicks), impressions: n(r.impressions), position: Math.round(n(r.position) * 10) / 10 })).filter((q) => q.query).slice(0, 10);
  if (days.length && top.length) days[days.length - 1]!.topQueries = top;
  return days;
}

async function readSearch(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const c = ctx.credentials;
  if (c.kind !== "oauth2" || !c.tenant || !SITE.test(c.tenant)) throw new IntegrationError("Choose which Search Console site to use first.");
  const latest = new Date(ctx.now().getTime() - LAG_DAYS * DAY_MS).toISOString().slice(0, 10);
  const end = range.to > latest ? latest : range.to;
  if (range.from > end) return { search: [] };
  const url = `${API}/sites/${encodeURIComponent(c.tenant)}/searchAnalytics/query`;
  const byDay = await googleApi<Rows>(ctx.http, c.accessToken, url, { method: "POST", body: { startDate: range.from, endDate: end, dimensions: ["date"], rowLimit: 1000 } });
  const byQuery = await googleApi<Rows>(ctx.http, c.accessToken, url, { method: "POST", body: { startDate: addDays(end, -(TOP_DAYS - 1)), endDate: end, dimensions: ["query"], rowLimit: 10 } });
  return { search: parseSearch(byDay, byQuery) };
}

/** Sites the login can read, leaving out the ones it only sees as an unverified user. */
async function searchChoices(ctx: ConnectorContext): Promise<{ id: string; name: string }[]> {
  const c = ctx.credentials;
  if (c.kind !== "oauth2") return [];
  const r = await googleApi<{ siteEntry?: { siteUrl?: string; permissionLevel?: string }[] }>(ctx.http, c.accessToken, `${API}/sites`);
  return (r.siteEntry ?? []).filter((s) => s.siteUrl && SITE.test(s.siteUrl) && s.permissionLevel !== "siteUnverifiedUser").map((s) => ({ id: s.siteUrl!, name: s.siteUrl!.replace(/^sc-domain:/, "").slice(0, 120) }));
}

export const searchConsole: Connector = {
  key: "search-console",
  name: "Google Search Console",
  category: "marketing",
  summary: "How your website shows up in Google: how often, how many click, and which searches bring people. Your Marketing manager uses it to improve your pages.",
  availability: "live",
  capabilities: ["search.read"],
  note: "Read-only. Google's figures run about three days behind.",
  auth: { kind: "oauth2", authorizeUrl: GOOGLE_AUTHORIZE, tokenUrl: GOOGLE_TOKEN, scopes: [SCOPE], envPrefix: "GOOGLE_DATA", authorizeParams: GOOGLE_PARAMS },
  read: readSearch,
  choices: searchChoices,
  exchangeCode: async (http, app, code) => ({ credentials: await googleExchange(http, app, code) }),
  refresh: googleRefresh,
};
