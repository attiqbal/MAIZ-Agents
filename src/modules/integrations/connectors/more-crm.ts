import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records } from "../types.js";
import { DayBook, dayOf, getJson, inRange, oauth, postJson, sameHttpsHost, standardRefresh, toMinor } from "./util.js";

/**
 * Salesforce (leads and deals), Intercom and Help Scout (support). Read-only counts and deal values; names, emails,
 * subjects and messages are never read into our records.
 */
const MAX_PAGES = 20;

// ---------- Salesforce ----------

const SF_TOKEN = "https://login.salesforce.com/services/oauth2/token";
const SF_VERSION = "v62.0";
/** Salesforce tells us the customer's own address after sign-in; only Salesforce's domains are accepted. */
const SF_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(salesforce|force|salesforce-setup)\.com$/;

async function soql<T>(ctx: ConnectorContext, instance: string, token: string, q: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = `${instance}/services/data/${SF_VERSION}/query?q=${encodeURIComponent(q)}`;
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const body: { records?: T[]; nextRecordsUrl?: string; done?: boolean } = await getJson(ctx, url, { authorization: `Bearer ${token}` }, "Salesforce");
    out.push(...(body.records ?? []));
    url = body.done === false && body.nextRecordsUrl && /^\/services\/data\/[\w./-]+$/.test(body.nextRecordsUrl) ? `${instance}${body.nextRecordsUrl}` : undefined;
  }
  return out;
}

async function readSalesforce(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken, tenant } = oauth(ctx, "Salesforce");
  if (!tenant || !SF_HOST.test(new URL(tenant).hostname) || new URL(tenant).protocol !== "https:") throw new IntegrationError("Please connect Salesforce again.");
  const book = new DayBook("crm", ctx.currency);
  const from = `${range.from}T00:00:00Z`, to = `${range.to}T23:59:59Z`;
  for (const object of ["Lead", "Contact"]) {
    const rows = await soql<{ CreatedDate?: string }>(ctx, tenant, accessToken, `SELECT CreatedDate FROM ${object} WHERE CreatedDate >= ${from} AND CreatedDate <= ${to} LIMIT 5000`);
    for (const r of rows) if (inRange(r.CreatedDate, range.from, range.to)) book.add(dayOf(r.CreatedDate!), "newContacts");
  }
  const closed = await soql<{ CloseDate?: string; Amount?: number | null; IsWon?: boolean }>(ctx, tenant, accessToken, `SELECT CloseDate, Amount, IsWon FROM Opportunity WHERE IsClosed = true AND CloseDate >= ${range.from} AND CloseDate <= ${range.to} LIMIT 5000`);
  for (const o of closed) {
    if (!o.CloseDate || !/^\d{4}-\d{2}-\d{2}$/.test(o.CloseDate)) continue;
    if (o.IsWon) { book.add(o.CloseDate, "dealsWon"); book.add(o.CloseDate, "wonValue", toMinor(o.Amount)); } else book.add(o.CloseDate, "dealsLost");
  }
  const open = await soql<{ Amount?: number | null }>(ctx, tenant, accessToken, "SELECT Amount FROM Opportunity WHERE IsClosed = false LIMIT 5000");
  book.set(range.to, "openDeals", open.length);
  book.set(range.to, "pipelineValue", open.reduce((n, o) => n + toMinor(o.Amount), 0));
  return { activity: book.list() };
}

export const salesforce: Connector = {
  key: "salesforce", name: "Salesforce", category: "customers", availability: "live", capabilities: ["crm.read"],
  summary: "New leads and contacts, deals won and lost, and your open pipeline from Salesforce.",
  note: "Read-only (the api scope with a read-only connected app). We count records and add up deal amounts; names and notes are never read. Counts stop at 5,000 records per type per update.",
  auth: { kind: "oauth2", authorizeUrl: "https://login.salesforce.com/services/oauth2/authorize", tokenUrl: SF_TOKEN, scopes: ["api", "refresh_token"], envPrefix: "SALESFORCE" },
  setup: {
    console: { href: "https://login.salesforce.com/", label: "Salesforce: sign in, then Setup, App Manager" },
    steps: [
      "In a Salesforce org (a free Developer Edition is fine) open Setup, App Manager, New Connected App. Turn on Enable OAuth Settings.",
      "Paste the Redirect URI shown on this page. Selected OAuth scopes: Manage user data via APIs (api) and Perform requests at any time (refresh_token).",
      "Save, wait a few minutes, then open the app's Manage Consumer Details and copy the Consumer Key (Client ID) and Consumer Secret into the boxes here.",
      "Clients from other Salesforce orgs can connect to a Connected App created in your org; Salesforce may ask them to approve it once.",
    ],
    approval: "No review needed for a Connected App. Salesforce can take 2 to 10 minutes to activate it.",
  },
  read: readSalesforce,
  refresh: standardRefresh(SF_TOKEN),
  async exchangeCode(http, app, code) {
    const res = await http(SF_TOKEN, { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: app.redirectUri }) });
    const o = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; instance_url?: string };
    if (!res.ok || !o.access_token || !o.instance_url) throw new IntegrationError("Salesforce did not approve the connection");
    const host = (() => { try { const u = new URL(o.instance_url!); return u.protocol === "https:" && SF_HOST.test(u.hostname) ? u.origin : undefined; } catch { return undefined; } })();
    if (!host) throw new IntegrationError("Salesforce sent an address we do not trust. Please try again.");
    return { credentials: { kind: "oauth2", accessToken: o.access_token, refreshToken: o.refresh_token, expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(), tenant: host }, externalAccount: new URL(host).hostname };
  },
};

// ---------- Intercom ----------

const INTERCOM = "https://api.intercom.io";

async function readIntercom(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken } = oauth(ctx, "Intercom");
  const headers = { authorization: `Bearer ${accessToken}`, "intercom-version": "2.11" };
  const book = new DayBook("support", ctx.currency);
  const since = Math.floor(Date.parse(`${range.from}T00:00:00Z`) / 1000);
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: { conversations?: { created_at?: number; updated_at?: number; state?: string }[]; pages?: { next?: { starting_after?: string } } } = await postJson(ctx, `${INTERCOM}/conversations/search`, { query: { field: "updated_at", operator: ">", value: since }, pagination: { per_page: 150, ...(after ? { starting_after: after } : {}) } }, headers, "Intercom");
    for (const c of body.conversations ?? []) {
      const created = c.created_at ? c.created_at * 1000 : undefined, updated = c.updated_at ? c.updated_at * 1000 : undefined;
      if (inRange(created, range.from, range.to)) book.add(dayOf(created!), "opened");
      if (c.state === "closed" && inRange(updated, range.from, range.to)) book.add(dayOf(updated!), "solved");
    }
    after = body.pages?.next?.starting_after;
    if (!after) break;
  }
  const open: { total_count?: number } = await postJson(ctx, `${INTERCOM}/conversations/search`, { query: { field: "state", operator: "=", value: "open" }, pagination: { per_page: 1 } }, headers, "Intercom");
  book.set(range.to, "open", Number(open.total_count) || 0);
  book.set(range.to, "waiting", Number(open.total_count) || 0);
  return { activity: book.list() };
}

export const intercom: Connector = {
  key: "intercom", name: "Intercom", category: "customers", availability: "live", capabilities: ["support.read"],
  summary: "Conversations opened and closed each day, and how many are still open.",
  note: "Read-only counts. Message text and customer details are never read.",
  auth: { kind: "oauth2", authorizeUrl: "https://app.intercom.com/oauth", tokenUrl: `${INTERCOM}/auth/eagle/token`, scopes: [], envPrefix: "INTERCOM" },
  setup: {
    console: { href: "https://app.intercom.com/a/apps/_/developer-hub", label: "Intercom Developer Hub" },
    steps: [
      "In the Developer Hub create an app (type: public, or internal to test). Under Authentication turn on OAuth and paste the Redirect URI shown on this page.",
      "Under Permissions tick only Read conversations. Do not tick anything that writes or reads users' details.",
      "Copy the Client ID and Client secret from Basic information into the boxes here.",
    ],
    approval: "Intercom reviews apps only if you list them in its App Store. Connecting through OAuth without listing needs no review.",
  },
  read: readIntercom,
  async exchangeCode(http, app, code) {
    const res = await http(`${INTERCOM}/auth/eagle/token`, { method: "POST", redirect: "error", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ code, client_id: app.clientId, client_secret: app.clientSecret }) });
    const o = (await res.json().catch(() => ({}))) as { token?: string };
    if (!res.ok || !o.token) throw new IntegrationError("Intercom did not approve the connection");
    // Intercom tokens do not expire, so there is no refresh token.
    return { credentials: { kind: "oauth2", accessToken: o.token } };
  },
};

// ---------- Help Scout ----------

const HS = "https://api.helpscout.net";

async function readHelpScout(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken } = oauth(ctx, "Help Scout");
  const headers = { authorization: `Bearer ${accessToken}` };
  const book = new DayBook("support", ctx.currency);
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const q = encodeURIComponent(`(modifiedAt:[${range.from}T00:00:00Z TO ${range.to}T23:59:59Z])`);
    const body: { _embedded?: { conversations?: { createdAt?: string; closedAt?: string; status?: string }[] }; page?: { totalPages?: number } } = await getJson(ctx, `${HS}/v2/conversations?status=all&query=${q}&page=${pageNo}`, headers, "Help Scout");
    for (const c of body._embedded?.conversations ?? []) {
      if (inRange(c.createdAt, range.from, range.to)) book.add(dayOf(c.createdAt!), "opened");
      if (c.status === "closed" && inRange(c.closedAt, range.from, range.to)) book.add(dayOf(c.closedAt!), "solved");
    }
    if (pageNo >= (body.page?.totalPages ?? 1)) break;
  }
  const act: { page?: { totalElements?: number } } = await getJson(ctx, `${HS}/v2/conversations?status=active&page=1`, headers, "Help Scout");
  const pend: { page?: { totalElements?: number } } = await getJson(ctx, `${HS}/v2/conversations?status=pending&page=1`, headers, "Help Scout");
  book.set(range.to, "waiting", Number(act.page?.totalElements) || 0);
  book.set(range.to, "open", (Number(act.page?.totalElements) || 0) + (Number(pend.page?.totalElements) || 0));
  return { activity: book.list() };
}

export const helpscout: Connector = {
  key: "helpscout", name: "Help Scout", category: "customers", availability: "live", capabilities: ["support.read"],
  summary: "Support conversations opened and closed each day, and how many are open.",
  note: "Read-only counts. Message text and customer details are never read.",
  auth: { kind: "oauth2", authorizeUrl: "https://secure.helpscout.net/authentication/authorizeClientApplication", tokenUrl: `${HS}/v2/oauth2/token`, scopes: [], envPrefix: "HELPSCOUT" },
  setup: {
    console: { href: "https://secure.helpscout.com/users/apps/", label: "Help Scout: My apps" },
    steps: [
      "In Help Scout open your profile, My apps, Create My App. Name it MAIZ Agents and paste the Redirect URL shown on this page.",
      "Copy the App ID (Client ID) and App Secret (Client secret) into the boxes here.",
    ],
    approval: "No review needed to connect accounts; listing in Help Scout's app directory is optional.",
  },
  read: readHelpScout,
  refresh: standardRefresh(`${HS}/v2/oauth2/token`),
};

void sameHttpsHost;
