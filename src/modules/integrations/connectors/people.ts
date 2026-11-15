import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records } from "../types.js";
import { DayBook, dayOf, getJson, inRange, keys, oauth, sameHttpsHost, standardRefresh } from "./util.js";

/**
 * Customer-facing activity from mail, bookings and email marketing: Outlook, Calendly, Cal.com, Mailchimp, Brevo.
 * Counts only. Subjects, bodies, names and addresses are never read into our records.
 */
const MAX_PAGES = 20;

// ---------- Outlook (Microsoft 365 mail) ----------

const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";

async function readOutlook(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken } = oauth(ctx, "Outlook");
  const headers = { authorization: `Bearer ${accessToken}` };
  const book = new DayBook("inbox", ctx.currency);
  const inbox: { unreadItemCount?: number } = await getJson(ctx, `${GRAPH}/me/mailFolders/inbox?$select=unreadItemCount`, headers, "Outlook");
  book.set(range.to, "unread", Number(inbox.unreadItemCount) || 0);
  let url: string | undefined = `${GRAPH}/me/mailFolders/inbox/messages?$select=receivedDateTime&$filter=${encodeURIComponent(`receivedDateTime ge ${range.from}T00:00:00Z`)}&$top=100`;
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const body: { value?: { receivedDateTime?: string }[]; "@odata.nextLink"?: string } = await getJson(ctx, url, headers, "Outlook");
    for (const m of body.value ?? []) if (inRange(m.receivedDateTime, range.from, range.to)) book.add(dayOf(m.receivedDateTime!), "received");
    const next = body["@odata.nextLink"];
    url = sameHttpsHost(next, "graph.microsoft.com");
  }
  return { activity: book.list() };
}

export const outlook: Connector = {
  key: "outlook", name: "Outlook / Microsoft 365 mail", category: "messaging", availability: "live", capabilities: ["inbox.read"],
  summary: "How many emails reach your inbox each day and how many are unread. Never the emails themselves.",
  note: "Uses the Mail.ReadBasic permission, which cannot open message bodies. Some work accounts need their administrator to allow it.",
  auth: { kind: "oauth2", authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", tokenUrl: MS_TOKEN, scopes: ["offline_access", "Mail.ReadBasic"], envPrefix: "OUTLOOK" },
  setup: {
    console: { href: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade", label: "Microsoft Entra: app registrations" },
    steps: [
      "Create a new app registration named MAIZ Agents Mail. Supported account types: any organizational directory and personal Microsoft accounts.",
      "Add the Redirect URI shown on this page (type Web).",
      "Under API permissions add Microsoft Graph, Delegated, Mail.ReadBasic and offline_access. Do not add anything that can read message bodies.",
      "Under Certificates and secrets create a client secret and copy its Value. Copy the Application (client) ID. Paste both here. Use a different app from your Sign in with Microsoft one.",
    ],
    approval: "Personal and most work accounts can connect straight away. Organisations that block users from approving apps need their IT administrator to approve once.",
  },
  read: readOutlook,
  refresh: standardRefresh(MS_TOKEN),
};

// ---------- Calendly ----------

const CALENDLY = "https://api.calendly.com";

async function readCalendly(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken } = oauth(ctx, "Calendly");
  const headers = { authorization: `Bearer ${accessToken}` };
  const me: { resource?: { uri?: string } } = await getJson(ctx, `${CALENDLY}/users/me`, headers, "Calendly");
  const user = me.resource?.uri;
  if (!user || !user.startsWith(`${CALENDLY}/users/`)) throw new IntegrationError("Calendly did not say who you are. Please connect again.");
  const book = new DayBook("bookings", ctx.currency);
  const today = ctx.now().toISOString();
  for (const status of ["active", "canceled"] as const) {
    let url: string | undefined = `${CALENDLY}/scheduled_events?user=${encodeURIComponent(user)}&status=${status}&count=100&min_start_time=${range.from}T00:00:00Z&max_start_time=${new Date(Date.parse(range.to) + 90 * 86_400_000).toISOString()}`;
    for (let page = 0; page < MAX_PAGES && url; page++) {
      const body: { collection?: { created_at?: string; start_time?: string }[]; pagination?: { next_page?: string | null } } = await getJson(ctx, url, headers, "Calendly");
      for (const e of body.collection ?? []) {
        if (inRange(e.created_at, range.from, range.to)) book.add(dayOf(e.created_at!), status === "active" ? "booked" : "cancelled");
        if (status === "active" && e.start_time && e.start_time > today) book.add(range.to, "upcoming");
      }
      const next = body.pagination?.next_page;
      url = next && next.startsWith(`${CALENDLY}/`) ? next : undefined;
    }
  }
  return { activity: book.list() };
}

export const calendly: Connector = {
  key: "calendly", name: "Calendly", category: "customers", availability: "live", capabilities: ["bookings.read"],
  summary: "Bookings made and cancelled each day, and how many are coming up.",
  note: "Read-only counts. Guest names and answers are never read.",
  auth: { kind: "oauth2", authorizeUrl: "https://auth.calendly.com/oauth/authorize", tokenUrl: "https://auth.calendly.com/oauth/token", scopes: [], envPrefix: "CALENDLY" },
  setup: {
    console: { href: "https://developer.calendly.com/", label: "Calendly developer portal" },
    steps: [
      "Create a Calendly developer account and create an OAuth application (environment: Production).",
      "Add the Redirect URI shown on this page. Copy the Client ID and Client secret into the boxes here.",
    ],
    approval: "Calendly may ask you to request production access before accounts other than your own can connect. Check the status in the developer portal.",
  },
  read: readCalendly,
  refresh: standardRefresh("https://auth.calendly.com/oauth/token"),
};

// ---------- Cal.com ----------

async function readCalCom(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "Cal.com");
  const headers = { authorization: `Bearer ${k.apiKey}`, "cal-api-version": "2024-08-13" };
  const book = new DayBook("bookings", ctx.currency);
  const now = ctx.now().toISOString();
  for (let skip = 0, page = 0; page < MAX_PAGES; page++, skip += 100) {
    const body: { data?: { status?: string; createdAt?: string; start?: string }[] } = await getJson(ctx, `https://api.cal.com/v2/bookings?take=100&skip=${skip}&sortCreated=desc`, headers, "Cal.com");
    const rows = body.data ?? [];
    for (const b of rows) {
      const cancelled = b.status === "cancelled";
      if (inRange(b.createdAt, range.from, range.to)) book.add(dayOf(b.createdAt!), cancelled ? "cancelled" : "booked");
      if (!cancelled && b.start && b.start > now) book.add(range.to, "upcoming");
    }
    if (rows.length < 100 || (rows.at(-1)?.createdAt ?? "9") < range.from) break;
  }
  return { activity: book.list() };
}

export const calcom: Connector = {
  key: "cal-com", name: "Cal.com", category: "customers", availability: "live", capabilities: ["bookings.read"],
  summary: "Bookings made and cancelled each day, and how many are coming up.",
  note: "Read-only counts. Attendee names and answers are never read.",
  auth: { kind: "api_key", fields: [{ key: "apiKey", label: "Cal.com API key", help: "In Cal.com: Settings, Developer, API keys, create a key and copy it (it starts with cal_)." }] },
  read: readCalCom,
  validate: (v) => (/^cal_(live_)?[A-Za-z0-9]{10,100}$/.test(v.apiKey ?? "") ? undefined : "A Cal.com key starts with cal_ and has no spaces."),
};

// ---------- Mailchimp ----------

async function readMailchimp(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "Mailchimp");
  const dc = /-(us\d{1,2})$/.exec(k.apiKey ?? "")?.[1];
  if (!dc) throw new IntegrationError("That Mailchimp key should end with a dash and a code such as -us21.");
  const api = `https://${dc}.api.mailchimp.com/3.0`;
  const headers = { authorization: `Basic ${Buffer.from(`maiz:${k.apiKey}`).toString("base64")}` };
  const book = new DayBook("audience", ctx.currency);
  const lists: { lists?: { id: string; stats?: { member_count?: number } }[] } = await getJson(ctx, `${api}/lists?count=5&fields=lists.id,lists.stats.member_count`, headers, "Mailchimp");
  let subscribers = 0;
  for (const l of lists.lists ?? []) {
    subscribers += Number(l.stats?.member_count) || 0;
    if (!/^[a-f0-9]{6,20}$/.test(l.id)) continue;
    const m: { members?: { timestamp_opt?: string }[] } = await getJson(ctx, `${api}/lists/${l.id}/members?since_timestamp_opt=${range.from}T00:00:00Z&count=1000&fields=members.timestamp_opt`, headers, "Mailchimp");
    for (const x of m.members ?? []) if (inRange(x.timestamp_opt, range.from, range.to)) book.add(dayOf(x.timestamp_opt!), "newSubscribers");
  }
  book.set(range.to, "subscribers", subscribers);
  const c: { campaigns?: { send_time?: string; report_summary?: { open_rate?: number; click_rate?: number } }[] } = await getJson(ctx, `${api}/campaigns?status=sent&since_send_time=${range.from}T00:00:00Z&count=100&fields=campaigns.send_time,campaigns.report_summary.open_rate,campaigns.report_summary.click_rate`, headers, "Mailchimp");
  const perDay = new Map<string, { open: number[]; click: number[] }>();
  for (const x of c.campaigns ?? []) {
    if (!inRange(x.send_time, range.from, range.to)) continue;
    const d = dayOf(x.send_time!);
    book.add(d, "campaignsSent");
    const p = perDay.get(d) ?? { open: [], click: [] };
    if (typeof x.report_summary?.open_rate === "number") p.open.push(x.report_summary.open_rate);
    if (typeof x.report_summary?.click_rate === "number") p.click.push(x.report_summary.click_rate);
    perDay.set(d, p);
  }
  const avg = (a: number[]) => Math.round((a.reduce((n, v) => n + v, 0) / a.length) * 10_000) / 100;
  for (const [d, p] of perDay) { if (p.open.length) book.set(d, "openRate", avg(p.open)); if (p.click.length) book.set(d, "clickRate", avg(p.click)); }
  return { activity: book.list() };
}

export const mailchimp: Connector = {
  key: "mailchimp", name: "Mailchimp", category: "marketing", availability: "live", capabilities: ["audience.read"],
  summary: "Your email list size, new subscribers and how your campaigns performed.",
  note: "Read-only. Subscribers' names and addresses are never read, only counts.",
  auth: { kind: "api_key", fields: [{ key: "apiKey", label: "Mailchimp API key", help: "In Mailchimp: your profile, Extras, API keys, Create A Key. It ends with a dash and a code like -us21." }] },
  read: readMailchimp,
  validate: (v) => (/^[a-f0-9]{32}-us\d{1,2}$/.test(v.apiKey ?? "") ? undefined : "A Mailchimp key is 32 letters and numbers, a dash, then a code such as us21."),
};

// ---------- Brevo ----------

async function readBrevo(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "Brevo");
  const headers = { "api-key": k.apiKey! };
  const book = new DayBook("audience", ctx.currency);
  const contacts: { count?: number } = await getJson(ctx, "https://api.brevo.com/v3/contacts?limit=1", headers, "Brevo");
  book.set(range.to, "subscribers", Number(contacts.count) || 0);
  const c: { campaigns?: { sentDate?: string; statistics?: { globalStats?: { delivered?: number; uniqueViews?: number; uniqueClicks?: number } } }[] } = await getJson(ctx, `https://api.brevo.com/v3/emailCampaigns?status=sent&statistics=globalStats&limit=100&sort=desc`, headers, "Brevo");
  const perDay = new Map<string, { sent: number; delivered: number; views: number; clicks: number }>();
  for (const x of c.campaigns ?? []) {
    if (!inRange(x.sentDate, range.from, range.to)) continue;
    const d = dayOf(x.sentDate!);
    const g = x.statistics?.globalStats ?? {};
    const p = perDay.get(d) ?? { sent: 0, delivered: 0, views: 0, clicks: 0 };
    p.sent++; p.delivered += Number(g.delivered) || 0; p.views += Number(g.uniqueViews) || 0; p.clicks += Number(g.uniqueClicks) || 0;
    perDay.set(d, p);
  }
  for (const [d, p] of perDay) {
    book.set(d, "campaignsSent", p.sent);
    if (p.delivered > 0) { book.set(d, "openRate", Math.round((p.views / p.delivered) * 10_000) / 100); book.set(d, "clickRate", Math.round((p.clicks / p.delivered) * 10_000) / 100); }
  }
  return { activity: book.list() };
}

export const brevo: Connector = {
  key: "brevo", name: "Brevo (Sendinblue)", category: "marketing", availability: "live", capabilities: ["audience.read"],
  summary: "Your contact list size and how your email campaigns performed.",
  note: "Read-only counts. Contacts' details are never read. New-subscriber counts are not available from Brevo's list view.",
  auth: { kind: "api_key", fields: [{ key: "apiKey", label: "Brevo API key", help: "In Brevo: your name, SMTP & API, API keys, Generate a new API key. Starts with xkeysib-." }] },
  read: readBrevo,
  validate: (v) => (/^xkeysib-[A-Za-z0-9-]{20,200}$/.test(v.apiKey ?? "") ? undefined : "A Brevo key starts with xkeysib- and has no spaces."),
};
