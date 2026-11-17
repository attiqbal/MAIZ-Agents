import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type OAuthApp, type Records, type SalesDay } from "../types.js";
import { DAY_MS, DayBook, dayOf, getJson, inRange, oauth, toMinor } from "./util.js";
import { asCredentials, exchange, expiresIn, makeRefresh, tokenCall } from "./oauth-util.js";

/**
 * Meta Ads (read-only spend and results), and the three marketplaces: Amazon, Etsy and eBay (orders as sales days, like
 * Shopify). Only totals are read: no buyer names, addresses or order contents.
 */
const MAX_PAGES = 10;

// ---------- Meta Ads ----------

const GRAPH = "https://graph.facebook.com/v25.0";
const META_TOKEN = `${GRAPH}/oauth/access_token`;
const AD_ACCOUNT = /^act_\d{5,25}$/;

async function metaAdsChoices(ctx: ConnectorContext): Promise<{ id: string; name: string }[]> {
  const { accessToken } = oauth(ctx, "Meta Ads");
  const body: { data?: { id?: string; name?: string }[] } = await getJson(ctx, `${GRAPH}/me/adaccounts?fields=name&limit=50`, { authorization: `Bearer ${accessToken}` }, "Meta Ads");
  return (body.data ?? []).filter((a) => a.id && AD_ACCOUNT.test(a.id)).map((a) => ({ id: a.id!, name: (a.name ?? a.id!).replace(/[^\p{L}\p{N} .,&'-]/gu, " ").slice(0, 80) }));
}

async function readMetaAds(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken, tenant } = oauth(ctx, "Meta Ads");
  if (!tenant || !AD_ACCOUNT.test(tenant)) throw new IntegrationError("Choose which ad account to read first.");
  const book = new DayBook("ads", ctx.currency);
  const q = new URLSearchParams({ fields: "spend,impressions,clicks,actions", time_increment: "1", time_range: JSON.stringify({ since: range.from, until: range.to }), limit: "100" });
  let url: string | undefined = `${GRAPH}/${tenant}/insights?${q}`;
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const body: { data?: { date_start?: string; spend?: string; impressions?: string; clicks?: string; actions?: { action_type?: string; value?: string }[] }[]; paging?: { next?: string } } = await getJson(ctx, url, { authorization: `Bearer ${accessToken}` }, "Meta Ads");
    for (const r of body.data ?? []) {
      const d = r.date_start;
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      book.add(d, "spend", toMinor(r.spend));
      book.add(d, "impressions", Number(r.impressions) || 0);
      book.add(d, "clicks", Number(r.clicks) || 0);
      book.add(d, "conversions", (r.actions ?? []).filter((a) => a.action_type === "lead" || a.action_type === "purchase" || a.action_type === "omni_purchase").reduce((n, a) => n + (Number(a.value) || 0), 0));
    }
    const next = body.paging?.next;
    url = next && next.startsWith(`${GRAPH}/`) ? next : undefined;
  }
  return { activity: book.list() };
}

export const metaAds: Connector = {
  key: "meta-ads", name: "Meta Ads", category: "marketing", availability: "approval", capabilities: ["ads.read"],
  summary: "What you spent on Facebook and Instagram adverts each day, the clicks, and the results (read-only).",
  note: "Read-only reporting. Meta reviews the ads_read permission before other businesses can connect.",
  auth: { kind: "oauth2", authorizeUrl: "https://www.facebook.com/v25.0/dialog/oauth", tokenUrl: META_TOKEN, scopes: ["ads_read"], envPrefix: "METAADS" },
  setup: {
    console: { href: "https://developers.facebook.com/apps/", label: "Meta for Developers: your apps" },
    steps: [
      "Use the Meta app you already made for Facebook and Instagram, or a new Business app. Open Facebook Login for Business (or Facebook Login), and paste the Redirect URI shown on this page under Valid OAuth Redirect URIs.",
      "In App settings, Basic, copy the App ID and App secret into the boxes here.",
      "In App Review, Permissions and features, request Advanced Access to ads_read. Meta asks for a screen recording of a person connecting and the figures appearing, and for your privacy page. See docs/META-APP-REVIEW.md for the wording used for the other permissions.",
      "Until Meta approves, only people with a role on the app (admins, developers, testers) can connect.",
    ],
    approval: "Usually a few days to two weeks.",
  },
  choices: metaAdsChoices,
  read: readMetaAds,
  async exchangeCode(http, app, code) {
    const short = await tokenCall(http, "Meta", META_TOKEN, { code, redirect_uri: app.redirectUri }, app, { get: true });
    // The first token lasts about an hour. Trade it for the long one (about 60 days).
    const long = await tokenCall(http, "Meta", META_TOKEN, { grant_type: "fb_exchange_token", fb_exchange_token: short.access_token! }, app, { get: true });
    return { credentials: asCredentials(long, 5_184_000) };
  },
  async refresh(http, app, creds) {
    if (creds.kind !== "oauth2") throw new IntegrationError("Please connect Meta Ads again.");
    try {
      const long = await tokenCall(http, "Meta", META_TOKEN, { grant_type: "fb_exchange_token", fb_exchange_token: creds.accessToken }, app, { get: true });
      return { ...creds, accessToken: long.access_token!, expiresAt: expiresIn(long.expires_in, 5_184_000) };
    } catch { throw new IntegrationError("Meta did not renew the connection. Please connect Meta Ads again."); }
  },
};

// ---------- Amazon Seller Central ----------

const LWA = "https://api.amazon.com/auth/o2/token";
const AMAZON_HOSTS: Record<string, { sellerCentral: string; api: string }> = {
  na: { sellerCentral: "https://sellercentral.amazon.com", api: "https://sellingpartnerapi-na.amazon.com" },
  eu: { sellerCentral: "https://sellercentral-europe.amazon.com", api: "https://sellingpartnerapi-eu.amazon.com" },
  fe: { sellerCentral: "https://sellercentral.amazon.co.jp", api: "https://sellingpartnerapi-fe.amazon.com" },
};
const region = (app?: OAuthApp): { sellerCentral: string; api: string } => AMAZON_HOSTS[app?.extra?.region ?? "eu"] ?? AMAZON_HOSTS.eu!;

async function readAmazon(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken } = oauth(ctx, "Amazon");
  const h = { "x-amz-access-token": accessToken };
  const api = region(ctx.app).api;
  const part: { payload?: { marketplace?: { id?: string }; participation?: { isParticipating?: boolean } }[] } = await getJson(ctx, `${api}/sellers/v1/marketplaceParticipations`, h, "Amazon");
  const ids = (part.payload ?? []).filter((p) => p.participation?.isParticipating !== false).map((p) => p.marketplace?.id).filter((id): id is string => !!id && /^[A-Z0-9]{8,16}$/.test(id));
  const sales: SalesDay[] = [];
  // One marketplace per call; the first few keep within Amazon's slow allowance.
  for (const m of ids.slice(0, 3)) {
    const interval = `${range.from}T00:00:00Z--${dayOf(Date.parse(range.to) + DAY_MS)}T00:00:00Z`;
    const q = new URLSearchParams({ marketplaceIds: m, interval, granularity: "Day", granularityTimeZone: "UTC" });
    const body: { payload?: { interval?: string; orderCount?: number; totalSales?: { amount?: string; currencyCode?: string } }[] } = await getJson(ctx, `${api}/sales/v1/orderMetrics?${q}`, h, "Amazon");
    for (const p of body.payload ?? []) {
      const date = p.interval?.slice(0, 10);
      const cur = p.totalSales?.currencyCode;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !cur || !/^[A-Z]{3}$/.test(cur) || !inRange(date, range.from, range.to)) continue;
      const existing = sales.find((s) => s.date === date && s.currency === cur);
      const gross = toMinor(p.totalSales?.amount), n = Number(p.orderCount) || 0;
      if (existing) { existing.gross += gross; existing.transactions += n; } else sales.push({ date, currency: cur, gross, tax: 0, tips: 0, fees: 0, refunds: 0, transactions: n });
    }
  }
  return { sales };
}

export const amazonSeller: Connector = {
  key: "amazon-seller", name: "Amazon Seller Central", category: "ecommerce", availability: "approval", capabilities: ["sales.read"],
  summary: "Orders and sales from your Amazon seller account.",
  note: "Read-only sales totals. No buyer details are asked for. Amazon needs a developer profile and reviews the app before other sellers can connect.",
  auth: { kind: "oauth2", authorizeUrl: "https://sellercentral.amazon.com/apps/authorize/consent", tokenUrl: LWA, scopes: [], envPrefix: "AMAZONSELLER" },
  ownerFields: [
    { key: "applicationId", label: "Application ID", secret: false, required: true, placeholder: "amzn1.sp.solution.…", help: "Shown on your app in Seller Central, Develop Apps. It is different from the Client ID.", pattern: /^amzn1\.sp\.solution\.[a-z0-9-]{8,60}$/i },
    { key: "region", label: "Amazon region (na, eu or fe)", secret: false, required: false, placeholder: "eu", help: "eu for the UK and Europe, na for the US, Canada and Mexico, fe for Japan and Australia. Leave empty for eu.", pattern: /^(na|eu|fe)$/ },
  ],
  setup: {
    console: { href: "https://developer-docs.amazon.com/sp-api/", label: "Amazon Selling Partner API" },
    steps: [
      "In Seller Central open Apps and Services, then Develop Apps. Register as a developer and describe the use: read-only order totals for businesses that connect. Choose only the order and report roles, never buyer personal data.",
      "Create the app. Add the Redirect URI shown on this page as an OAuth Redirect URI, and the app's Login URI (your home page address).",
      "Copy the LWA Client identifier and Client secret into the boxes here, and the Application ID (starts amzn1.sp.solution) into its box.",
      "While the app is a draft, only your own seller account can authorize it. To let other sellers connect, publish it in the Selling Partner Appstore, or have each seller authorise it from your private link: confirm which Amazon allows for your app in Seller Central.",
    ],
    approval: "Usually one to four weeks, and Amazon may ask for a security review.",
  },
  regions: ["US", "GB", "DE", "FR", "IT", "ES", "CA"],
  read: readAmazon,
  authorizeUrl(app, state) {
    const u = new URL(`${region(app).sellerCentral}/apps/authorize/consent`);
    u.searchParams.set("application_id", app.extra?.applicationId ?? ""); u.searchParams.set("state", state);
    // Amazon calls an unpublished app a draft and wants this flag to let its owner try it.
    u.searchParams.set("version", "beta");
    return u.toString();
  },
  async exchangeCode(http, app, code, params) {
    const { credentials } = await exchange(http, "Amazon", LWA, app, code, undefined);
    const seller = params?.selling_partner_id && /^[A-Z0-9]{6,20}$/.test(params.selling_partner_id) ? params.selling_partner_id : undefined;
    return { credentials, externalAccount: seller ? `Seller ${seller}` : undefined };
  },
  refresh: makeRefresh("Amazon", LWA),
};

// ---------- Etsy ----------

const ETSY = "https://api.etsy.com/v3";
const ETSY_TOKEN = `${ETSY}/public/oauth/token`;
/** Etsy wants the app's key and its shared secret together in this header on every call. */
const etsyKey = (ctx: ConnectorContext): Record<string, string> => ({ "x-api-key": `${ctx.app?.clientId ?? ""}:${ctx.app?.clientSecret ?? ""}` });

async function readEtsy(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken } = oauth(ctx, "Etsy");
  const h = { ...etsyKey(ctx), authorization: `Bearer ${accessToken}` };
  const me: { shop_id?: number } = await getJson(ctx, `${ETSY}/application/users/me`, h, "Etsy");
  if (!Number.isInteger(me.shop_id)) throw new IntegrationError("Etsy did not name a shop for this login. Connect the account that owns the shop.");
  const days = new Map<string, SalesDay>();
  const min = Math.floor(Date.parse(`${range.from}T00:00:00Z`) / 1000), max = Math.floor(Date.parse(`${range.to}T23:59:59Z`) / 1000);
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ min_created: String(min), max_created: String(max), was_paid: "true", limit: "100", offset: String(page * 100) });
    const body: { results?: { created_timestamp?: number; grandtotal?: { amount?: number; divisor?: number; currency_code?: string }; total_tax_cost?: { amount?: number; divisor?: number } }[] } = await getJson(ctx, `${ETSY}/application/shops/${me.shop_id}/receipts?${q}`, h, "Etsy");
    const rows = body.results ?? [];
    for (const r of rows) {
      const cur = r.grandtotal?.currency_code;
      const div = r.grandtotal?.divisor || 100;
      if (!r.created_timestamp || !cur || !/^[A-Z]{3}$/.test(cur) || typeof r.grandtotal?.amount !== "number") continue;
      const date = dayOf(r.created_timestamp * 1000);
      const d = days.get(`${date}|${cur}`) ?? { date, currency: cur, gross: 0, tax: 0, tips: 0, fees: 0, refunds: 0, transactions: 0 };
      d.gross += Math.round((r.grandtotal.amount / div) * 100);
      d.tax += Math.round(((r.total_tax_cost?.amount ?? 0) / (r.total_tax_cost?.divisor || 100)) * 100);
      d.transactions += 1;
      days.set(`${date}|${cur}`, d);
    }
    if (rows.length < 100) break;
  }
  return { sales: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export const etsy: Connector = {
  key: "etsy", name: "Etsy", category: "ecommerce", availability: "approval", capabilities: ["sales.read"],
  summary: "Orders and sales from your Etsy shop.",
  note: "Read-only sales totals. Etsy gives a personal key quickly but needs approval for commercial access before other sellers can connect.",
  auth: { kind: "oauth2", authorizeUrl: "https://www.etsy.com/oauth/connect", tokenUrl: ETSY_TOKEN, scopes: ["transactions_r"], envPrefix: "ETSY", pkce: true },
  setup: {
    console: { href: "https://www.etsy.com/developers/register", label: "Etsy developers: register an app" },
    steps: [
      "Register an app. Describe it as: reads the sales totals of sellers who connect, nothing is changed. Etsy first gives you a personal key that works only for your own shop.",
      "Add the Redirect URI shown on this page to the app. In the Client ID box paste the app's Keystring, and in the Client secret box its Shared secret.",
      "Ask Etsy for commercial access so other sellers can connect.",
    ],
    approval: "Usually a week or two.",
  },
  read: readEtsy,
  async exchangeCode(http, app, code, params) {
    const { credentials } = await exchange(http, "Etsy", ETSY_TOKEN, app, code, params?.code_verifier, { noSecret: true });
    return { credentials };
  },
  refresh: makeRefresh("Etsy", ETSY_TOKEN, { noSecret: true }),
};

// ---------- eBay ----------

const EBAY_TOKEN = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly";

async function readEbay(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken } = oauth(ctx, "eBay");
  const days = new Map<string, SalesDay>();
  const filter = `creationdate:[${range.from}T00:00:00.000Z..${range.to}T23:59:59.999Z]`;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ filter, limit: "200", offset: String(page * 200) });
    const body: { orders?: { creationDate?: string; orderPaymentStatus?: string; cancelStatus?: { cancelState?: string }; pricingSummary?: { total?: { value?: string; currency?: string } }; totalMarketplaceFee?: { value?: string } }[]; next?: string } = await getJson(ctx, `https://api.ebay.com/sell/fulfillment/v1/order?${q}`, { authorization: `Bearer ${accessToken}` }, "eBay");
    for (const o of body.orders ?? []) {
      const cur = o.pricingSummary?.total?.currency;
      if (o.orderPaymentStatus !== "PAID" || (o.cancelStatus?.cancelState && o.cancelStatus.cancelState !== "NONE_REQUESTED") || !cur || !/^[A-Z]{3}$/.test(cur) || !inRange(o.creationDate, range.from, range.to)) continue;
      const date = dayOf(o.creationDate!);
      const d = days.get(`${date}|${cur}`) ?? { date, currency: cur, gross: 0, tax: 0, tips: 0, fees: 0, refunds: 0, transactions: 0 };
      d.gross += toMinor(o.pricingSummary?.total?.value);
      d.fees += toMinor(o.totalMarketplaceFee?.value);
      d.transactions += 1;
      days.set(`${date}|${cur}`, d);
    }
    if (!body.next) break;
  }
  return { sales: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export const ebay: Connector = {
  key: "ebay", name: "eBay", category: "ecommerce", availability: "approval", capabilities: ["sales.read"],
  summary: "Orders and sales from your eBay account.",
  note: "Read-only sales totals (the sell.fulfillment.readonly permission). eBay checks an app before it gives a production keyset.",
  auth: { kind: "oauth2", authorizeUrl: "https://auth.ebay.com/oauth2/authorize", tokenUrl: EBAY_TOKEN, scopes: [EBAY_SCOPE], envPrefix: "EBAY", tokenAuth: "basic" },
  ownerFields: [{ key: "ruName", label: "RuName (redirect name)", secret: false, required: true, placeholder: "Your_Name-YourApp-PRD-abc123-xyz", help: "eBay uses this name in place of an address. Create it under User Tokens, Get a Token from eBay via Your Application, with the Redirect URI shown on this page as the accepted URL.", pattern: /^[A-Za-z0-9_.-]{10,120}$/ }],
  setup: {
    console: { href: "https://developer.ebay.com/", label: "eBay developers" },
    steps: [
      "Create an eBay developer account and a keyset. Ask for a Production keyset; eBay may ask you to confirm how marketplace account deletion notices are handled or to opt out of them.",
      "Under User Tokens create a RuName. Put the Redirect URI shown on this page as the accept and decline address, then paste the RuName into its box here.",
      "Copy the App ID (Client ID) and Cert ID (Client secret) of the Production keyset into the boxes here.",
    ],
    approval: "Usually a few days.",
  },
  read: readEbay,
  authorizeUrl(app, state) {
    const u = new URL("https://auth.ebay.com/oauth2/authorize");
    u.searchParams.set("client_id", app.clientId); u.searchParams.set("response_type", "code");
    // eBay wants the RuName here, not the address.
    u.searchParams.set("redirect_uri", app.extra?.ruName ?? ""); u.searchParams.set("scope", EBAY_SCOPE); u.searchParams.set("state", state);
    return u.toString();
  },
  async exchangeCode(http, app, code) {
    const { credentials } = await exchange(http, "eBay", EBAY_TOKEN, app, code, undefined, { basic: true, redirect: app.extra?.ruName, fallbackSeconds: 7200 });
    return { credentials };
  },
  refresh: makeRefresh("eBay", EBAY_TOKEN, { basic: true, fallbackSeconds: 7200 }),
};
