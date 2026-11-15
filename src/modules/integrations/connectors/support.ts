import { type Connector, type ConnectorContext, type DateRange, type Records } from "../types.js";
import { DayBook, dayOf, getJson, inRange, keys, safeHost, sameHttpsHost } from "./util.js";

/**
 * Zendesk and Freshdesk (customer support). Read-only counts: tickets opened and solved per day, and how many wait for
 * a reply now. Subjects, messages and customer details are never read into our records.
 */
const MAX_PAGES = 10;
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

// ---------- Zendesk ----------

interface ZdTicket { created_at?: string; updated_at?: string; status?: string }

async function readZendesk(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "Zendesk");
  const host = safeHost(`${k.subdomain}.zendesk.com`, /^[a-z0-9-]{1,63}\.zendesk\.com$/, "Zendesk name");
  const headers = { authorization: basic(`${k.email}/token`, k.apiToken!) };
  const book = new DayBook("support", ctx.currency);
  let url: string | undefined = `https://${host}/api/v2/search.json?query=${encodeURIComponent(`type:ticket updated>=${range.from}`)}&sort_by=updated_at&sort_order=desc&per_page=100`;
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const body: { results?: ZdTicket[]; next_page?: string | null } = await getJson(ctx, url, headers, "Zendesk");
    for (const t of body.results ?? []) {
      if (inRange(t.created_at, range.from, range.to)) book.add(dayOf(t.created_at!), "opened");
      if ((t.status === "solved" || t.status === "closed") && inRange(t.updated_at, range.from, range.to)) book.add(dayOf(t.updated_at!), "solved");
    }
    // Only follow a next page on the same Zendesk address.
    url = sameHttpsHost(body.next_page, host);
  }
  const count = async (q: string): Promise<number> => {
    const b: { count?: number } = await getJson(ctx, `https://${host}/api/v2/search/count.json?query=${encodeURIComponent(q)}`, headers, "Zendesk");
    return Number(b.count) || 0;
  };
  book.set(range.to, "waiting", (await count("type:ticket status:new")) + (await count("type:ticket status:open")));
  book.set(range.to, "open", (await count("type:ticket status<solved")));
  return { activity: book.list() };
}

export const zendesk: Connector = {
  key: "zendesk", name: "Zendesk", category: "customers", availability: "live", capabilities: ["support.read"],
  summary: "Support tickets opened and solved each day, and how many are waiting for a reply.",
  note: "Read-only counts. Ticket subjects and messages are never read. Zendesk's search shows at most 1,000 recent tickets per update.",
  auth: { kind: "api_key", fields: [
    { key: "subdomain", label: "Zendesk name", help: "The first part of your Zendesk address: for acme.zendesk.com type acme." },
    { key: "email", label: "Your Zendesk email", help: "The agent or admin email you sign in with." },
    { key: "apiToken", label: "API token", help: "In Zendesk Admin Centre: Apps and integrations, APIs, Zendesk API, add an API token and copy it." },
  ] },
  read: readZendesk,
  validate(v) {
    if (!/^[a-z0-9-]{1,63}$/i.test(v.subdomain ?? "")) return "Type only the first part of your Zendesk address, for example acme.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email ?? "")) return "Type the email address you sign in to Zendesk with.";
    if (!/^[A-Za-z0-9]{20,80}$/.test(v.apiToken ?? "")) return "That does not look like a Zendesk API token (letters and numbers, no spaces).";
    return undefined;
  },
};

// ---------- Freshdesk ----------

async function readFreshdesk(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "Freshdesk");
  const host = safeHost(`${k.domain}.freshdesk.com`, /^[a-z0-9-]{1,63}\.freshdesk\.com$/, "Freshdesk name");
  const headers = { authorization: basic(k.apiKey!, "X") };
  const book = new DayBook("support", ctx.currency);
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows: { created_at?: string; updated_at?: string; status?: number }[] = await getJson(ctx, `https://${host}/api/v2/tickets?updated_since=${range.from}T00:00:00Z&per_page=100&page=${page}`, headers, "Freshdesk");
    for (const t of Array.isArray(rows) ? rows : []) {
      if (inRange(t.created_at, range.from, range.to)) book.add(dayOf(t.created_at!), "opened");
      if ((t.status === 4 || t.status === 5) && inRange(t.updated_at, range.from, range.to)) book.add(dayOf(t.updated_at!), "solved");
    }
    if (!Array.isArray(rows) || rows.length < 100) break;
  }
  const total = async (status: number): Promise<number> => {
    const b: { total?: number } = await getJson(ctx, `https://${host}/api/v2/search/tickets?query=${encodeURIComponent(`"status:${status}"`)}`, headers, "Freshdesk");
    return Number(b.total) || 0;
  };
  const [openNow, pending] = [await total(2), await total(3)];
  book.set(range.to, "waiting", openNow);
  book.set(range.to, "open", openNow + pending);
  return { activity: book.list() };
}

export const freshdesk: Connector = {
  key: "freshdesk", name: "Freshdesk", category: "customers", availability: "live", capabilities: ["support.read"],
  summary: "Support tickets opened and solved each day, and how many are waiting for a reply.",
  note: "Read-only counts. Ticket subjects and messages are never read.",
  auth: { kind: "api_key", fields: [
    { key: "domain", label: "Freshdesk name", help: "The first part of your Freshdesk address: for acme.freshdesk.com type acme." },
    { key: "apiKey", label: "API key", help: "In Freshdesk: your profile picture, Profile settings, then View API key on the right." },
  ] },
  read: readFreshdesk,
  validate(v) {
    if (!/^[a-z0-9-]{1,63}$/i.test(v.domain ?? "")) return "Type only the first part of your Freshdesk address, for example acme.";
    if (!/^[A-Za-z0-9]{10,80}$/.test(v.apiKey ?? "")) return "That does not look like a Freshdesk API key (letters and numbers, no spaces).";
    return undefined;
  },
};
