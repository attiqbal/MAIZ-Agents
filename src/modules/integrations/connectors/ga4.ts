import { googleApi, googleExchange, googleRefresh, plainWords, GOOGLE_AUTHORIZE, GOOGLE_PARAMS, GOOGLE_TOKEN } from "./google.js";
import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records, type TrafficDay } from "../types.js";

/**
 * Google Analytics 4: visits, visitors, goals, revenue and where visits came from, a day at a time. Read-only.
 * Two reports per sync (daily totals, then daily visits by channel) so visitors are never double counted.
 * Today's figures are still being processed, so the newest day read is yesterday.
 */
const DATA = "https://analyticsdata.googleapis.com/v1beta";
const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
/** "properties/" and digits only: it goes into a URL path. */
export const PROPERTY = /^properties\/\d{1,15}$/;
const DAY_MS = 86_400_000;

interface Report { rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[]; metadata?: { currencyCode?: string } }

const isoDay = (ga: string | undefined): string | undefined => (ga && /^\d{8}$/.test(ga) ? `${ga.slice(0, 4)}-${ga.slice(4, 6)}-${ga.slice(6)}` : undefined);
const num = (v: string | undefined): number => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };

/** Turns GA4's two reports into one record per day. Exported for tests. */
export function parseGa4(totals: Report, channels: Report, fallbackCurrency: string): TrafficDay[] {
  const currency = (totals.metadata?.currencyCode ?? fallbackCurrency).toUpperCase();
  const days = new Map<string, TrafficDay>();
  for (const r of totals.rows ?? []) {
    const date = isoDay(r.dimensionValues?.[0]?.value);
    const m = r.metricValues ?? [];
    if (!date) continue;
    days.set(date, { date, currency, sessions: num(m[0]?.value), users: num(m[1]?.value), newUsers: num(m[2]?.value), engagedSessions: num(m[3]?.value), conversions: num(m[4]?.value), revenue: Math.round(num(m[5]?.value) * 100), channels: [] });
  }
  for (const r of channels.rows ?? []) {
    const date = isoDay(r.dimensionValues?.[0]?.value);
    const name = plainWords(r.dimensionValues?.[1]?.value, 60) || "Unassigned";
    const d = date ? days.get(date) : undefined;
    if (d) d.channels.push({ name, sessions: num(r.metricValues?.[0]?.value), conversions: num(r.metricValues?.[1]?.value) });
  }
  for (const d of days.values()) d.channels.sort((a, b) => b.sessions - a.sessions);
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function readGa4(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const c = ctx.credentials;
  if (c.kind !== "oauth2" || !c.tenant || !PROPERTY.test(c.tenant)) throw new IntegrationError("Choose which Google Analytics property to use first.");
  const yesterday = new Date(ctx.now().getTime() - DAY_MS).toISOString().slice(0, 10);
  const end = range.to > yesterday ? yesterday : range.to;
  if (range.from > end) return { traffic: [] };
  const url = `${DATA}/${c.tenant}:runReport`;
  const dateRanges = [{ startDate: range.from, endDate: end }];
  const totals = await googleApi<Report>(ctx.http, c.accessToken, url, { method: "POST", body: { dateRanges, dimensions: [{ name: "date" }], metrics: ["sessions", "activeUsers", "newUsers", "engagedSessions", "keyEvents", "totalRevenue"].map((name) => ({ name })), limit: 1000 } });
  const channels = await googleApi<Report>(ctx.http, c.accessToken, url, { method: "POST", body: { dateRanges, dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }], metrics: ["sessions", "keyEvents"].map((name) => ({ name })), limit: 10000 } });
  return { traffic: parseGa4(totals, channels, ctx.currency) };
}

/** The properties this Google login can read, newest accounts last as Google lists them. */
async function ga4Choices(ctx: ConnectorContext): Promise<{ id: string; name: string }[]> {
  const c = ctx.credentials;
  if (c.kind !== "oauth2") return [];
  const out: { id: string; name: string }[] = [];
  let page = "";
  for (let i = 0; i < 5; i++) {
    const r = await googleApi<{ accountSummaries?: { displayName?: string; propertySummaries?: { property?: string; displayName?: string }[] }[]; nextPageToken?: string }>(ctx.http, c.accessToken, `${ADMIN}/accountSummaries?pageSize=200${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
    for (const a of r.accountSummaries ?? []) for (const p of a.propertySummaries ?? []) if (p.property && PROPERTY.test(p.property)) out.push({ id: p.property, name: `${(p.displayName ?? p.property).slice(0, 80)}${a.displayName ? ` (${a.displayName.slice(0, 60)})` : ""}` });
    if (!r.nextPageToken) break;
    page = r.nextPageToken;
  }
  return out;
}

export const ga4: Connector = {
  key: "ga4",
  name: "Google Analytics",
  category: "marketing",
  summary: "Who visits your website, where they come from and what they do. Your Marketing manager writes you a weekly report and warns you when something changes.",
  availability: "live",
  capabilities: ["traffic.read"],
  note: "Read-only. We never change your Analytics. Google asks you to tick the box for viewing your Analytics data. Your AI team is given weekly totals to answer your questions, and they are never used to train AI. Disconnect deletes them.",
  auth: { kind: "oauth2", authorizeUrl: GOOGLE_AUTHORIZE, tokenUrl: GOOGLE_TOKEN, scopes: [SCOPE], envPrefix: "GOOGLE_DATA", authorizeParams: GOOGLE_PARAMS },
  read: readGa4,
  choices: ga4Choices,
  exchangeCode: async (http, app, code) => ({ credentials: await googleExchange(http, app, code) }),
  refresh: googleRefresh,
};
