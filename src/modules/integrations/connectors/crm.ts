import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records } from "../types.js";
import { DayBook, dayOf, getJson, inRange, keys, oauth, postJson, safeHost, standardRefresh, toMinor } from "./util.js";

/**
 * HubSpot and Pipedrive (leads and deals). Read-only: new contacts, deals won and lost, and the open pipeline now.
 * Names, emails and notes are never read into our records, only counts and deal values.
 */
const HUBSPOT = "https://api.hubapi.com";
const MAX_PAGES = 30;

interface HsSearch { results?: { properties?: Record<string, string | null> }[]; paging?: { next?: { after?: string } } }

async function hsSearch(ctx: ConnectorContext, object: "contacts" | "deals", filters: unknown[], properties: string[]): Promise<Record<string, string | null>[]> {
  const { accessToken } = oauth(ctx, "HubSpot");
  const out: Record<string, string | null>[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: HsSearch = await postJson(ctx, `${HUBSPOT}/crm/v3/objects/${object}/search`, { filterGroups: [{ filters }], properties, limit: 100, ...(after ? { after } : {}) }, { authorization: `Bearer ${accessToken}` }, "HubSpot");
    for (const r of body.results ?? []) out.push(r.properties ?? {});
    after = body.paging?.next?.after;
    if (!after) break;
  }
  return out;
}

async function readHubspot(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const book = new DayBook("crm", ctx.currency);
  const from = Date.parse(`${range.from}T00:00:00Z`), to = Date.parse(`${range.to}T23:59:59Z`);
  const created = await hsSearch(ctx, "contacts", [{ propertyName: "createdate", operator: "BETWEEN", value: String(from), highValue: String(to) }], ["createdate"]);
  for (const c of created) if (inRange(c.createdate ?? undefined, range.from, range.to)) book.add(dayOf(c.createdate!), "newContacts");
  const closed = await hsSearch(ctx, "deals", [{ propertyName: "closedate", operator: "BETWEEN", value: String(from), highValue: String(to) }, { propertyName: "hs_is_closed", operator: "EQ", value: "true" }], ["closedate", "amount", "hs_is_closed_won"]);
  for (const d of closed) {
    if (!inRange(d.closedate ?? undefined, range.from, range.to)) continue;
    const day = dayOf(d.closedate!);
    if (d.hs_is_closed_won === "true") { book.add(day, "dealsWon"); book.add(day, "wonValue", toMinor(d.amount)); } else book.add(day, "dealsLost");
  }
  const open = await hsSearch(ctx, "deals", [{ propertyName: "hs_is_closed", operator: "EQ", value: "false" }], ["amount"]);
  book.set(range.to, "openDeals", open.length);
  book.set(range.to, "pipelineValue", open.reduce((n, d) => n + toMinor(d.amount), 0));
  return { activity: book.list() };
}

export const hubspot: Connector = {
  key: "hubspot", name: "HubSpot", category: "customers", availability: "live", capabilities: ["crm.read"],
  summary: "New contacts, deals won and lost, and your open pipeline from HubSpot.",
  note: "Read-only. We count contacts and deals and add up deal values; we never read names, emails or notes.",
  auth: { kind: "oauth2", authorizeUrl: "https://app.hubspot.com/oauth/authorize", tokenUrl: `${HUBSPOT}/oauth/v1/token`, scopes: ["crm.objects.contacts.read", "crm.objects.deals.read"], envPrefix: "HUBSPOT" },
  setup: {
    console: { href: "https://developers.hubspot.com/", label: "HubSpot developer account" },
    steps: [
      "Create a free HubSpot developer account, then create an app (Apps, Create app).",
      "On the Auth tab paste the Redirect URL shown on this page. Add the scopes crm.objects.contacts.read and crm.objects.deals.read as required scopes.",
      "Copy the Client ID and Client secret from the Auth tab into the boxes here. Listing the app in HubSpot's marketplace is optional: it connects to any HubSpot account without that.",
    ],
  },
  read: readHubspot,
  refresh: standardRefresh(`${HUBSPOT}/oauth/v1/token`),
  async exchangeCode(http, app, code) {
    const res = await http(`${HUBSPOT}/oauth/v1/token`, { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: app.redirectUri }) });
    const o = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!res.ok || !o.access_token) throw new IntegrationError("HubSpot did not approve the connection");
    return { credentials: { kind: "oauth2", accessToken: o.access_token, refreshToken: o.refresh_token, expiresAt: new Date(Date.now() + (o.expires_in ?? 1800) * 1000).toISOString() } };
  },
};

// ---------- Pipedrive ----------

interface PdPage { data?: { add_time?: string; won_time?: string; lost_time?: string; value?: number | string; currency?: string }[] | null; additional_data?: { pagination?: { more_items_in_collection?: boolean; next_start?: number } } }

async function pdAll(ctx: ConnectorContext, host: string, path: string, token: string, until?: (r: NonNullable<PdPage["data"]>[number]) => boolean): Promise<NonNullable<PdPage["data"]>> {
  const out: NonNullable<PdPage["data"]> = [];
  let start = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const body: PdPage = await getJson(ctx, `https://${host}/api/v1/${path}${sep}limit=500&start=${start}`, { "x-api-token": token }, "Pipedrive");
    const rows = body.data ?? [];
    out.push(...rows);
    const pg = body.additional_data?.pagination;
    if (!pg?.more_items_in_collection || pg.next_start === undefined) break;
    if (until && rows.length && until(rows[rows.length - 1]!)) break;
    start = pg.next_start;
  }
  return out;
}

const pdDay = (t?: string) => (t ? t.slice(0, 10) : "");

async function readPipedrive(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "Pipedrive");
  const host = safeHost(`${k.companyDomain}.pipedrive.com`, /^[a-z0-9-]{1,63}\.pipedrive\.com$/, "Pipedrive company name");
  const token = k.apiToken!;
  const book = new DayBook("crm", ctx.currency);
  // Newest first, so we can stop once we pass the start of the range.
  const people = await pdAll(ctx, host, "persons?sort=add_time%20DESC", token, (r) => pdDay(r.add_time) < range.from);
  for (const p of people) if (pdDay(p.add_time) >= range.from && pdDay(p.add_time) <= range.to) book.add(pdDay(p.add_time), "newContacts");
  const won = await pdAll(ctx, host, "deals?status=won&sort=won_time%20DESC", token, (r) => pdDay(r.won_time) < range.from);
  for (const d of won) { const day = pdDay(d.won_time); if (day >= range.from && day <= range.to) { book.add(day, "dealsWon"); book.add(day, "wonValue", toMinor(d.value)); } }
  const lost = await pdAll(ctx, host, "deals?status=lost&sort=lost_time%20DESC", token, (r) => pdDay(r.lost_time) < range.from);
  for (const d of lost) { const day = pdDay(d.lost_time); if (day >= range.from && day <= range.to) book.add(day, "dealsLost"); }
  const open = await pdAll(ctx, host, "deals?status=open", token);
  book.set(range.to, "openDeals", open.length);
  book.set(range.to, "pipelineValue", open.reduce((n, d) => n + toMinor(d.value), 0));
  return { activity: book.list() };
}

export const pipedrive: Connector = {
  key: "pipedrive", name: "Pipedrive", category: "customers", availability: "live", capabilities: ["crm.read"],
  summary: "New contacts, deals won and lost, and your open pipeline from Pipedrive.",
  note: "Read-only counts and deal values. Use a key from a user who can see all deals, or the figures will be low.",
  auth: { kind: "api_key", fields: [
    { key: "companyDomain", label: "Pipedrive company name", help: "The first part of your Pipedrive address: for acme.pipedrive.com type acme." },
    { key: "apiToken", label: "Personal API token", help: "In Pipedrive: your profile picture, Personal preferences, API, copy the token." },
  ] },
  read: readPipedrive,
  validate(v) {
    if (!/^[a-z0-9-]{1,63}$/i.test(v.companyDomain ?? "")) return "Type only the first part of your Pipedrive address, for example acme.";
    if (!/^[A-Za-z0-9]{20,80}$/.test(v.apiToken ?? "")) return "That does not look like a Pipedrive API token (letters and numbers, no spaces).";
    return undefined;
  },
};
