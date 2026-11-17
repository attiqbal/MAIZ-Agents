import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records } from "../types.js";
import { GOOGLE_AUTHORIZE, GOOGLE_PARAMS, GOOGLE_TOKEN, googleApi, googleExchange, googleRefresh, plainWords } from "./google.js";
import { DayBook, dayOf, getJson, inRange, oauth, postJson } from "./util.js";

/**
 * Google Business Profile (reviews) and Google Ads (spend and results). Both are read-only counts and totals; the text
 * of a review is never read into our records. Both need Google's own approval of the MAIZ app before every client can
 * connect (Business Profile API access request; Google Ads developer token), which the owner's card explains.
 */
const MAX_PAGES = 10;
const RADIX_ID = /^accounts\/\d{1,25}\/locations\/\d{1,25}$/;

// ---------- Google Business Profile ----------

const BP_ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const BP_INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
const BP_REVIEWS = "https://mybusiness.googleapis.com/v4";

async function businessChoices(ctx: ConnectorContext): Promise<{ id: string; name: string }[]> {
  const { accessToken } = oauth(ctx, "Google Business Profile");
  const accounts = await googleApi<{ accounts?: { name?: string; accountName?: string }[] }>(ctx.http, accessToken, BP_ACCOUNTS);
  const out: { id: string; name: string }[] = [];
  for (const a of (accounts.accounts ?? []).slice(0, 5)) {
    if (!a.name || !/^accounts\/\d{1,25}$/.test(a.name)) continue;
    const l = await googleApi<{ locations?: { name?: string; title?: string }[] }>(ctx.http, accessToken, `${BP_INFO}/${a.name}/locations?readMask=name,title&pageSize=100`);
    for (const loc of l.locations ?? []) {
      const id = `${a.name}/${loc.name}`;
      if (RADIX_ID.test(id)) out.push({ id, name: plainWords(loc.title, 80) || id });
    }
  }
  return out;
}

async function readBusiness(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken, tenant } = oauth(ctx, "Google Business Profile");
  if (!tenant || !RADIX_ID.test(tenant)) throw new IntegrationError("Choose which business location to read first.");
  const book = new DayBook("reviews", ctx.currency);
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${BP_REVIEWS}/${tenant}/reviews?pageSize=50&orderBy=${encodeURIComponent("updateTime desc")}${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
    const body = await googleApi<{ reviews?: { createTime?: string }[]; averageRating?: number; totalReviewCount?: number; nextPageToken?: string }>(ctx.http, accessToken, url);
    if (page === 0) {
      book.set(range.to, "averageRating", Number(body.averageRating) || 0);
      book.set(range.to, "totalReviews", Number(body.totalReviewCount) || 0);
    }
    for (const r of body.reviews ?? []) if (inRange(r.createTime, range.from, range.to)) book.add(dayOf(r.createTime!), "newReviews");
    token = body.nextPageToken;
    if (!token) break;
  }
  return { activity: book.list() };
}

export const googleBusinessProfile: Connector = {
  key: "google-business-profile", name: "Google Business Profile", category: "customers", availability: "approval", capabilities: ["reviews.read"],
  summary: "New Google reviews and your average star rating.",
  note: "Read-only: we count reviews and read the star rating. The words of a review are never kept. Google gives Business Profile API access only after it reviews a request.",
  auth: { kind: "oauth2", authorizeUrl: GOOGLE_AUTHORIZE, tokenUrl: GOOGLE_TOKEN, scopes: ["https://www.googleapis.com/auth/business.manage"], envPrefix: "GBP", authorizeParams: GOOGLE_PARAMS },
  setup: {
    console: { href: "https://developers.google.com/my-business/content/prereqs", label: "Business Profile API: request access" },
    steps: [
      "Check your own Business Profile has been verified and active for 60 days or more. Google asks for this before it grants API access.",
      "In the Google Cloud project for this card (keep it apart from the sign-in and Analytics ones) note the Project number, then fill in Google's Business Profile API access request form with it.",
      "When Google approves, turn on three APIs in the project: My Business Account Management API, My Business Business Information API and Google My Business API.",
      "Under Google Auth Platform, Data access, add the business.manage scope. Under Clients create a Web application client and paste the Redirect URI shown on this page.",
    ],
    approval: "Usually one to two weeks. Until Google approves, only test users listed in Audience can connect.",
  },
  choices: businessChoices,
  read: readBusiness,
  exchangeCode: async (http, app, code) => ({ credentials: await googleExchange(http, app, code) }),
  refresh: googleRefresh,
};

// ---------- Google Ads ----------

const ADS = "https://googleads.googleapis.com/v26";
const ADS_ID = /^\d{10}$/;
const adsHeaders = (ctx: ConnectorContext, token: string): Record<string, string> => {
  const dev = ctx.app?.extra?.developerToken;
  if (!dev) throw new IntegrationError("Google Ads is not fully set up on MAIZ's side yet (the developer token is missing).");
  return { authorization: `Bearer ${token}`, "developer-token": dev };
};

async function adsChoices(ctx: ConnectorContext): Promise<{ id: string; name: string }[]> {
  const { accessToken } = oauth(ctx, "Google Ads");
  const body: { resourceNames?: string[] } = await getJson(ctx, `${ADS}/customers:listAccessibleCustomers`, adsHeaders(ctx, accessToken), "Google Ads");
  return (body.resourceNames ?? []).map((n) => /^customers\/(\d{10})$/.exec(n)?.[1]).filter((id): id is string => !!id).slice(0, 50).map((id) => ({ id, name: `Ads account ${id.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")}` }));
}

interface AdsRow { segments?: { date?: string }; metrics?: { costMicros?: string | number; impressions?: string | number; clicks?: string | number; conversions?: number } }

async function readAds(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken, tenant } = oauth(ctx, "Google Ads");
  if (!tenant || !ADS_ID.test(tenant)) throw new IntegrationError("Choose which Google Ads account to read first.");
  const headers = adsHeaders(ctx, accessToken);
  const query = `SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM customer WHERE segments.date BETWEEN '${range.from}' AND '${range.to}'`;
  const book = new DayBook("ads", ctx.currency);
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: { results?: AdsRow[]; nextPageToken?: string } = await postJson(ctx, `${ADS}/customers/${tenant}/googleAds:search`, { query, ...(pageToken ? { pageToken } : {}) }, headers, "Google Ads");
    for (const r of body.results ?? []) {
      const d = r.segments?.date;
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      // Money is in millionths of the account's currency; our records use hundredths.
      book.add(d, "spend", Math.round(Number(r.metrics?.costMicros ?? 0) / 10_000));
      book.add(d, "impressions", Number(r.metrics?.impressions ?? 0));
      book.add(d, "clicks", Number(r.metrics?.clicks ?? 0));
      book.add(d, "conversions", Math.round(Number(r.metrics?.conversions ?? 0)));
    }
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return { activity: book.list().map((d) => ({ ...d })) };
}

export const googleAds: Connector = {
  key: "google-ads", name: "Google Ads", category: "marketing", availability: "approval", capabilities: ["ads.read"],
  summary: "What you spent on Google Ads each day, the clicks, and the results they brought (read-only).",
  note: "Read-only reporting. Google Ads needs a developer token that Google approves.",
  auth: { kind: "oauth2", authorizeUrl: GOOGLE_AUTHORIZE, tokenUrl: GOOGLE_TOKEN, scopes: ["https://www.googleapis.com/auth/adwords"], envPrefix: "GOOGLEADS", authorizeParams: GOOGLE_PARAMS },
  ownerFields: [{ key: "developerToken", label: "Developer token", secret: true, required: true, placeholder: "22 letters and numbers", help: "From your Google Ads manager account, Admin, API Center. Needs at least Basic access.", pattern: /^[A-Za-z0-9_-]{16,40}$/ }],
  setup: {
    console: { href: "https://ads.google.com/aw/apicenter", label: "Google Ads: API Center (manager account)" },
    steps: [
      "Open (or create) a Google Ads manager account, then Admin, API Center, and apply for a developer token. Ask for Basic access, which is enough for read-only reporting.",
      "Paste the developer token into its box on this card. Never share it in a chat or an email.",
      "In your Google Cloud project turn on the Google Ads API, add the adwords scope under Data access, and create a Web application client with the Redirect URI shown on this page. Paste its Client ID and secret here.",
      "Until the token has Basic access, it only works with test accounts, so a client's real account will be refused.",
    ],
    approval: "Basic access is usually decided within a few working days.",
  },
  choices: adsChoices,
  read: readAds,
  exchangeCode: async (http, app, code) => ({ credentials: await googleExchange(http, app, code) }),
  refresh: googleRefresh,
};
