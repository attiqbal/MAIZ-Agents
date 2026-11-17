import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records } from "../types.js";
import { DAY_MS, DayBook, dayOf, getJson, inRange, oauth } from "./util.js";
import { asCredentials, exchange, expiresIn, makeRefresh, tokenCall } from "./oauth-util.js";

/**
 * LinkedIn Pages, TikTok, Pinterest (followers and post counts) and Trustpilot (reviews). Read-only numbers.
 * Nothing is posted, and the words of a post or a review are never kept.
 */
const MAX_PAGES = 5;

// ---------- LinkedIn Pages ----------

const LI = "https://api.linkedin.com/rest";
const LI_TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";
const LI_ORG = /^urn:li:organization:\d{1,20}$/;
/** LinkedIn versions its API by month. This is a month its documentation lists; bump it when LinkedIn retires it. */
const LI_VERSION = "202610";
const liHeaders = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, "linkedin-version": LI_VERSION, "x-restli-protocol-version": "2.0.0" });

async function linkedinChoices(ctx: ConnectorContext): Promise<{ id: string; name: string }[]> {
  const { accessToken } = oauth(ctx, "LinkedIn");
  const body: { elements?: { organization?: string; organizationTarget?: string }[] } = await getJson(ctx, `${LI}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`, liHeaders(accessToken), "LinkedIn");
  return (body.elements ?? []).map((e) => e.organization ?? e.organizationTarget).filter((u): u is string => !!u && LI_ORG.test(u)).slice(0, 50).map((u) => ({ id: u, name: `LinkedIn Page ${u.split(":").pop()}` }));
}

async function readLinkedin(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken, tenant } = oauth(ctx, "LinkedIn");
  if (!tenant || !LI_ORG.test(tenant)) throw new IntegrationError("Choose which LinkedIn Page to read first.");
  const h = liHeaders(accessToken);
  const book = new DayBook("social", ctx.currency);
  const size: { firstDegreeSize?: number } = await getJson(ctx, `${LI}/networkSizes/${encodeURIComponent(tenant)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, h, "LinkedIn");
  book.set(range.to, "followers", Number(size.firstDegreeSize) || 0);
  // LinkedIn has these figures from a year ago up to two days ago.
  const newest = Date.parse(dayOf(ctx.now().getTime() - 2 * DAY_MS));
  const start = Math.max(Date.parse(range.from), newest - 364 * DAY_MS), end = Math.min(Date.parse(range.to) + DAY_MS, newest + DAY_MS);
  if (end > start) {
    const q = `q=organizationalEntity&organizationalEntity=${encodeURIComponent(tenant)}&timeIntervals=(timeRange:(start:${start},end:${end}),timeGranularityType:DAY)`;
    const gains: { elements?: { timeRange?: { start?: number }; followerGains?: { organicFollowerGain?: number; paidFollowerGain?: number } }[] } = await getJson(ctx, `${LI}/organizationalEntityFollowerStatistics?${q}`, h, "LinkedIn");
    for (const e of gains.elements ?? []) {
      const t = e.timeRange?.start;
      if (typeof t === "number" && inRange(t, range.from, range.to)) book.add(dayOf(t), "newFollowers", Math.max(0, Number(e.followerGains?.organicFollowerGain ?? 0) + Number(e.followerGains?.paidFollowerGain ?? 0)));
    }
  }
  return { activity: book.list() };
}

export const linkedinPages: Connector = {
  key: "linkedin-pages", name: "LinkedIn Pages", category: "marketing", availability: "approval", capabilities: ["social.read"],
  summary: "How many people follow your company Page and how many joined each day (read-only).",
  note: "Read-only. LinkedIn only opens its Page APIs to approved apps and never offers other people's profiles.",
  auth: { kind: "oauth2", authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization", tokenUrl: LI_TOKEN, scopes: ["r_organization_admin"], envPrefix: "LINKEDIN" },
  setup: {
    console: { href: "https://www.linkedin.com/developers/apps", label: "LinkedIn developer apps" },
    steps: [
      "Create a LinkedIn app and tie it to your company Page (the app page asks you to pick the Page and have its admin verify it).",
      "On the app's Products tab request the Community Management API. LinkedIn asks what you will use it for and for a short demo video: say you only read follower numbers for clients' Pages and post nothing.",
      "On the Auth tab paste the Redirect URL shown on this page, then copy the Client ID and Primary Client Secret into the boxes here.",
      "Once LinkedIn approves the product, the permissions it grants show on the Auth tab. If it offers rw_organization_admin only, that is what LinkedIn requires for follower figures: MAIZ still only reads.",
    ],
    approval: "Usually two to six weeks, and LinkedIn can say no. A connection lasts 60 days; the client then presses Connect again.",
  },
  choices: linkedinChoices,
  read: readLinkedin,
  async exchangeCode(http, app, code) {
    const { credentials, raw } = await exchange(http, "LinkedIn", LI_TOKEN, app, code, undefined, { fallbackSeconds: 5_184_000 });
    void raw;
    return { credentials };
  },
};

// ---------- TikTok ----------

const TT = "https://open.tiktokapis.com/v2";

async function readTiktok(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken } = oauth(ctx, "TikTok");
  const body: { data?: { user?: { follower_count?: number; video_count?: number } }; error?: { code?: string } } = await getJson(ctx, `${TT}/user/info/?fields=follower_count,video_count`, { authorization: `Bearer ${accessToken}` }, "TikTok");
  if (body.error?.code && body.error.code !== "ok") throw new IntegrationError(`TikTok said no (${/^[\w.-]{1,40}$/.test(body.error.code) ? body.error.code : "error"}). Please connect TikTok again.`);
  const book = new DayBook("social", ctx.currency);
  book.set(range.to, "followers", Number(body.data?.user?.follower_count) || 0);
  book.set(range.to, "posts", Number(body.data?.user?.video_count) || 0);
  return { activity: book.list() };
}

export const tiktok: Connector = {
  key: "tiktok", name: "TikTok", category: "marketing", availability: "approval", capabilities: ["social.read"],
  summary: "Your TikTok followers and how many videos you have posted (read-only).",
  note: "Read-only numbers for your own account. TikTok reviews every app before other people can connect.",
  auth: { kind: "oauth2", authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/", tokenUrl: `${TT}/oauth/token/`, scopes: ["user.info.basic", "user.info.stats"], envPrefix: "TIKTOK" },
  setup: {
    console: { href: "https://developers.tiktok.com/", label: "TikTok for Developers" },
    steps: [
      "Create an app, add the Login Kit product and ask for the scopes user.info.basic and user.info.stats. In TikTok's screens the Client ID is called the Client key.",
      "List your website, privacy page and terms page, and paste the Redirect URI shown on this page under Login Kit.",
      "Submit the app for review with a short demo video showing a person pressing Connect and the follower figures appearing. Say nothing is posted.",
      "Copy the Client key and Client secret into the boxes here.",
    ],
    approval: "Review takes days to weeks. Until it passes, only the TikTok accounts you add as app testers can connect.",
  },
  read: readTiktok,
  authorizeUrl(app, state) {
    const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
    u.searchParams.set("client_key", app.clientId); u.searchParams.set("scope", "user.info.basic,user.info.stats");
    u.searchParams.set("response_type", "code"); u.searchParams.set("redirect_uri", app.redirectUri); u.searchParams.set("state", state);
    return u.toString();
  },
  async exchangeCode(http, app, code) {
    const o = await tokenCall(http, "TikTok", `${TT}/oauth/token/`, { grant_type: "authorization_code", code, redirect_uri: app.redirectUri }, app, { idField: "client_key" });
    return { credentials: asCredentials(o, 86_400) };
  },
  refresh: async (http, app, creds) => {
    if (creds.kind !== "oauth2" || !creds.refreshToken) throw new IntegrationError("Please connect TikTok again.");
    try {
      const o = await tokenCall(http, "TikTok", `${TT}/oauth/token/`, { grant_type: "refresh_token", refresh_token: creds.refreshToken }, app, { idField: "client_key" });
      return { ...creds, accessToken: o.access_token!, refreshToken: typeof o.refresh_token === "string" ? o.refresh_token : creds.refreshToken, expiresAt: expiresIn(o.expires_in, 86_400) };
    } catch { throw new IntegrationError("TikTok did not renew the connection. Please connect TikTok again."); }
  },
};

// ---------- Pinterest ----------

const PIN = "https://api.pinterest.com/v5";

async function readPinterest(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken } = oauth(ctx, "Pinterest");
  const me: { follower_count?: number; pin_count?: number } = await getJson(ctx, `${PIN}/user_account`, { authorization: `Bearer ${accessToken}` }, "Pinterest");
  const book = new DayBook("social", ctx.currency);
  book.set(range.to, "followers", Number(me.follower_count) || 0);
  book.set(range.to, "posts", Number(me.pin_count) || 0);
  return { activity: book.list() };
}

export const pinterest: Connector = {
  key: "pinterest", name: "Pinterest", category: "marketing", availability: "approval", capabilities: ["social.read"],
  summary: "Your Pinterest followers and how many Pins you have (read-only).",
  note: "Read-only numbers for your business account. Pinterest gives Trial access first; Standard access needs a demo video.",
  auth: { kind: "oauth2", authorizeUrl: "https://www.pinterest.com/oauth/", tokenUrl: `${PIN}/oauth/token`, scopes: ["user_accounts:read"], envPrefix: "PINTEREST", tokenAuth: "basic" },
  setup: {
    console: { href: "https://developers.pinterest.com/apps/", label: "Pinterest developer apps" },
    steps: [
      "Create an app. Pinterest starts you on Trial access, which only works for your own account and the testers you add.",
      "Paste the Redirect URI shown on this page into the app, then copy the App id and App secret into the boxes here.",
      "Apply for Standard access. Pinterest asks for a screen recording of the sign-in flow and a short description: say MAIZ only reads follower and Pin counts.",
    ],
    approval: "Usually a few days to two weeks.",
  },
  read: readPinterest,
  async exchangeCode(http, app, code) {
    const { credentials } = await exchange(http, "Pinterest", `${PIN}/oauth/token`, app, code, undefined, { basic: true, fallbackSeconds: 2_592_000 });
    return { credentials };
  },
  refresh: makeRefresh("Pinterest", `${PIN}/oauth/token`, { basic: true, fallbackSeconds: 2_592_000 }),
};

// ---------- Trustpilot (the client pastes a key) ----------

const TP = "https://api.trustpilot.com/v1";
const DOMAIN = /^(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}$/;

async function readTrustpilot(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  if (ctx.credentials.kind !== "api_key") throw new IntegrationError("Trustpilot needs a key");
  const { apiKey, domain } = ctx.credentials.values;
  const host = (domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!apiKey || !DOMAIN.test(host)) throw new IntegrationError("Please connect Trustpilot again with your key and web address.");
  const h = { apikey: apiKey };
  const found: { id?: string } = await getJson(ctx, `${TP}/business-units/find?name=${encodeURIComponent(host)}`, h, "Trustpilot");
  if (!found.id || !/^[a-f0-9]{24}$/i.test(found.id)) throw new IntegrationError("Trustpilot has no business with that web address.");
  const book = new DayBook("reviews", ctx.currency);
  const info: { numberOfReviews?: { total?: number }; score?: { trustScore?: number } } = await getJson(ctx, `${TP}/business-units/${found.id}`, h, "Trustpilot");
  book.set(range.to, "averageRating", Number(info.score?.trustScore) || 0);
  book.set(range.to, "totalReviews", Number(info.numberOfReviews?.total) || 0);
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body: { reviews?: { createdAt?: string }[] } = await getJson(ctx, `${TP}/business-units/${found.id}/reviews?perPage=100&page=${page}&orderBy=${encodeURIComponent("createdat.desc")}`, h, "Trustpilot");
    const rows = body.reviews ?? [];
    for (const r of rows) if (inRange(r.createdAt, range.from, range.to)) book.add(dayOf(r.createdAt!), "newReviews");
    if (rows.length < 100 || (rows.at(-1)?.createdAt ?? "9") < range.from) break;
  }
  return { activity: book.list() };
}

export const trustpilot: Connector = {
  key: "trustpilot", name: "Trustpilot", category: "customers", availability: "live", capabilities: ["reviews.read"],
  summary: "New Trustpilot reviews and your TrustScore.",
  note: "Read-only. We count reviews and read the score; the words of a review are never kept. Needs a Trustpilot API key from your own Trustpilot developer account.",
  auth: { kind: "api_key", fields: [
    { key: "apiKey", label: "Trustpilot API key", help: "From your Trustpilot developer account, Apps. Needs no MAIZ approval." },
    { key: "domain", label: "Your Trustpilot web address name", help: "The name in your Trustpilot page address, for example www.mybusiness.co.uk." },
  ] },
  validate: (v) => (DOMAIN.test((v.domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")) ? (/^[A-Za-z0-9]{16,64}$/.test(v.apiKey ?? "") ? undefined : "That does not look like a Trustpilot API key. Copy it again in full.") : "Type the web address name of your Trustpilot page, for example www.mybusiness.co.uk."),
  read: readTrustpilot,
};

void DAY_MS;
