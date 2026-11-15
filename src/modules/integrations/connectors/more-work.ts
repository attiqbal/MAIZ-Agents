import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records } from "../types.js";
import { DayBook, dayOf, getJson, inRange, keys, oauth, standardRefresh } from "./util.js";

/** ClickUp (tasks), Constant Contact (email list) and Twilio (text messages). Counts only. */
const MAX_PAGES = 20;

// ---------- ClickUp ----------

async function readClickUp(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "ClickUp");
  const headers = { authorization: k.token! };
  const teams: { teams?: { id?: string }[] } = await getJson(ctx, "https://api.clickup.com/api/v2/team", headers, "ClickUp");
  const team = teams.teams?.[0]?.id;
  if (!team || !/^\d{1,20}$/.test(team)) throw new IntegrationError("ClickUp did not show a workspace for this token.");
  const book = new DayBook("tasks", ctx.currency);
  const now = ctx.now().getTime();
  let open = 0, overdue = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: { tasks?: { due_date?: string | null; date_closed?: string | null; status?: { type?: string } }[] } = await getJson(ctx, `https://api.clickup.com/api/v2/team/${team}/task?include_closed=true&page=${page}&date_updated_gt=${Date.parse(`${range.from}T00:00:00Z`) - 60 * 86_400_000}`, headers, "ClickUp");
    const tasks = body.tasks ?? [];
    for (const t of tasks) {
      const closed = t.status?.type === "closed" || !!t.date_closed;
      if (closed) { if (t.date_closed && inRange(Number(t.date_closed), range.from, range.to)) book.add(dayOf(Number(t.date_closed)), "completed"); continue; }
      open++;
      if (t.due_date && Number(t.due_date) < now) overdue++;
    }
    if (tasks.length < 100) break;
  }
  book.set(range.to, "open", open);
  book.set(range.to, "overdue", overdue);
  return { activity: book.list() };
}

export const clickup: Connector = {
  key: "clickup", name: "ClickUp", category: "teamwork", availability: "live", capabilities: ["tasks.read"],
  summary: "Open, overdue and finished tasks in your ClickUp workspace.",
  note: "Read-only counts. Task names and descriptions are never read. Counts cover tasks updated in the last 60 days.",
  auth: { kind: "api_key", fields: [{ key: "token", label: "ClickUp personal API token", help: "In ClickUp: your avatar, Settings, Apps, API Token, Generate. It starts with pk_." }] },
  read: readClickUp,
  validate: (v) => (/^pk_[A-Za-z0-9_]{10,100}$/.test(v.token ?? "") ? undefined : "A ClickUp personal token starts with pk_ and has no spaces."),
};

// ---------- Constant Contact ----------

const CC_TOKEN = "https://authz.constantcontact.com/oauth2/default/v1/token";

async function readConstantContact(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken } = oauth(ctx, "Constant Contact");
  const headers = { authorization: `Bearer ${accessToken}` };
  const book = new DayBook("audience", ctx.currency);
  const contacts: { contacts_count?: number } = await getJson(ctx, "https://api.cc.email/v3/contacts?limit=1&status=all&include_count=true", headers, "Constant Contact");
  book.set(range.to, "subscribers", Number(contacts.contacts_count) || 0);
  const camps: { campaigns?: { updated_at?: string; current_status?: string }[] } = await getJson(ctx, "https://api.cc.email/v3/emails?limit=50", headers, "Constant Contact");
  for (const c of camps.campaigns ?? []) if (c.current_status === "Done" && inRange(c.updated_at, range.from, range.to)) book.add(dayOf(c.updated_at!), "campaignsSent");
  return { activity: book.list() };
}

export const constantContact: Connector = {
  key: "constant-contact", name: "Constant Contact", category: "marketing", availability: "live", capabilities: ["audience.read"],
  summary: "Your email list size and the campaigns you sent.",
  note: "Read-only counts. Contacts' details are never read. Open and click rates are not read yet.",
  auth: { kind: "oauth2", authorizeUrl: "https://authz.constantcontact.com/oauth2/default/v1/authorize", tokenUrl: CC_TOKEN, scopes: ["contact_data", "campaign_data", "offline_access"], envPrefix: "CONSTANTCONTACT", tokenAuth: "basic" },
  setup: {
    console: { href: "https://app.constantcontact.com/pages/dma/portal/", label: "Constant Contact developer portal" },
    steps: [
      "Sign in to the developer portal, My Applications, New Application. Choose Authorization Code Flow and Rotating Refresh Tokens.",
      "Paste the Redirect URI shown on this page. Generate a client secret and copy it at once (it is shown once).",
      "Copy the API key (this is the Client ID) and the secret into the boxes here.",
    ],
    approval: "No review for connecting accounts; a free developer account is enough.",
  },
  read: readConstantContact,
  refresh: standardRefresh(CC_TOKEN, true),
  async exchangeCode(http, app, code) {
    const res = await http(CC_TOKEN, { method: "POST", redirect: "error", headers: { authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: app.redirectUri }) });
    const o = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!res.ok || !o.access_token) throw new IntegrationError("Constant Contact did not approve the connection");
    return { credentials: { kind: "oauth2", accessToken: o.access_token, refreshToken: o.refresh_token, expiresAt: new Date(Date.now() + (o.expires_in ?? 7200) * 1000).toISOString() } };
  },
};

// ---------- Twilio ----------

async function readTwilio(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "Twilio");
  const headers = { authorization: `Basic ${Buffer.from(`${k.accountSid}:${k.authToken}`).toString("base64")}` };
  const book = new DayBook("inbox", ctx.currency);
  let url: string | undefined = `https://api.twilio.com/2010-04-01/Accounts/${k.accountSid}/Messages.json?DateSent%3E=${range.from}&PageSize=1000`;
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const body: { messages?: { date_sent?: string; direction?: string }[]; next_page_uri?: string | null } = await getJson(ctx, url, headers, "Twilio");
    for (const m of body.messages ?? []) if (m.direction === "inbound" && inRange(m.date_sent, range.from, range.to)) book.add(dayOf(m.date_sent!), "received");
    url = body.next_page_uri && /^\/2010-04-01\/Accounts\/AC[a-f0-9]{32}\/Messages\.json\?[\w%=&.:+-]+$/i.test(body.next_page_uri) ? `https://api.twilio.com${body.next_page_uri}` : undefined;
  }
  return { activity: book.list() };
}

export const twilio: Connector = {
  key: "twilio", name: "Twilio (text messages)", category: "messaging", availability: "live", capabilities: ["inbox.read"],
  summary: "How many text messages customers send to your Twilio numbers each day.",
  note: "Read-only counts of inbound texts. Message text and phone numbers are never read. Sending texts needs sender registration and is not part of this.",
  auth: { kind: "api_key", fields: [
    { key: "accountSid", label: "Account SID", help: "On the Twilio Console home page. Starts with AC." },
    { key: "authToken", label: "Auth token", help: "Next to the Account SID on the Console home page (click to show)." },
  ] },
  read: readTwilio,
  validate(v) {
    if (!/^AC[a-f0-9]{32}$/i.test(v.accountSid ?? "")) return "The Account SID starts with AC followed by 32 letters and numbers.";
    if (!/^[a-f0-9]{32}$/i.test(v.authToken ?? "")) return "The auth token is 32 letters and numbers.";
    return undefined;
  },
};
