import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records } from "../types.js";
import { DayBook, dayOf, getJson, inRange, keys } from "./util.js";

/** Task boards: Trello and Asana. Counts of open, overdue and finished tasks. Task titles and notes are never read. */
const MAX_PAGES = 10;

// ---------- Trello ----------

async function readTrello(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "Trello");
  const headers = { authorization: `OAuth oauth_consumer_key="${k.apiKey}", oauth_token="${k.token}"` };
  const cards: { due?: string | null; dueComplete?: boolean; dateLastActivity?: string }[] = await getJson(ctx, "https://api.trello.com/1/members/me/cards?filter=open&fields=due,dueComplete,dateLastActivity", headers, "Trello");
  const book = new DayBook("tasks", ctx.currency);
  const now = ctx.now().toISOString();
  const list = Array.isArray(cards) ? cards : [];
  book.set(range.to, "open", list.filter((c) => !c.dueComplete).length);
  book.set(range.to, "overdue", list.filter((c) => c.due && !c.dueComplete && c.due < now).length);
  for (const c of list) if (c.dueComplete && inRange(c.dateLastActivity, range.from, range.to)) book.add(dayOf(c.dateLastActivity!), "completed");
  return { activity: book.list() };
}

export const trello: Connector = {
  key: "trello", name: "Trello", category: "teamwork", availability: "live", capabilities: ["tasks.read"],
  summary: "Open, overdue and finished tasks across your Trello boards.",
  note: "Read-only counts of the cards assigned to you. A card counts as finished when its due date is ticked complete.",
  auth: { kind: "api_key", fields: [
    { key: "apiKey", label: "Trello API key", help: "Open trello.com/power-ups/admin, create a Power-Up, then API key, and copy the key." },
    { key: "token", label: "Trello token", help: "On the same page click Token (Generate a Token), allow read access, and copy the token." },
  ] },
  read: readTrello,
  validate(v) {
    if (!/^[a-f0-9]{32}$/i.test(v.apiKey ?? "")) return "A Trello API key is 32 letters and numbers.";
    if (!/^[A-Za-z0-9_-]{30,200}$/.test(v.token ?? "")) return "A Trello token is one long code with no spaces.";
    return undefined;
  },
};

// ---------- Asana ----------

const ASANA = "https://app.asana.com/api/1.0";

async function asanaTasks(ctx: ConnectorContext, headers: Record<string, string>, workspace: string, completedSince: string): Promise<{ completed?: boolean; completed_at?: string | null; due_on?: string | null }[]> {
  const out: { completed?: boolean; completed_at?: string | null; due_on?: string | null }[] = [];
  let offset: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body: { data?: typeof out; next_page?: { offset?: string } | null } = await getJson(ctx, `${ASANA}/tasks?assignee=me&workspace=${encodeURIComponent(workspace)}&completed_since=${encodeURIComponent(completedSince)}&opt_fields=completed,completed_at,due_on&limit=100${offset ? `&offset=${encodeURIComponent(offset)}` : ""}`, headers, "Asana");
    out.push(...(body.data ?? []));
    offset = body.next_page?.offset;
    if (!offset) break;
  }
  return out;
}

async function readAsana(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const k = keys(ctx, "Asana");
  const headers = { authorization: `Bearer ${k.token}` };
  const me: { data?: { workspaces?: { gid?: string }[] } } = await getJson(ctx, `${ASANA}/users/me?opt_fields=workspaces.gid`, headers, "Asana");
  const workspace = me.data?.workspaces?.[0]?.gid;
  if (!workspace || !/^\d{1,30}$/.test(workspace)) throw new IntegrationError("Asana did not show a workspace for this token.");
  const book = new DayBook("tasks", ctx.currency);
  // completed_since=now returns only unfinished tasks.
  const open = await asanaTasks(ctx, headers, workspace, "now");
  book.set(range.to, "open", open.length);
  book.set(range.to, "overdue", open.filter((t) => t.due_on && t.due_on < range.to).length);
  const recent = await asanaTasks(ctx, headers, workspace, `${range.from}T00:00:00Z`);
  for (const t of recent) if (t.completed && inRange(t.completed_at ?? undefined, range.from, range.to)) book.add(dayOf(t.completed_at!), "completed");
  return { activity: book.list() };
}

export const asana: Connector = {
  key: "asana", name: "Asana", category: "teamwork", availability: "live", capabilities: ["tasks.read"],
  summary: "Open, overdue and finished tasks assigned to you in Asana.",
  note: "Read-only counts of tasks assigned to the token's owner. Task names and notes are never read.",
  auth: { kind: "api_key", fields: [{ key: "token", label: "Asana personal access token", help: "In Asana: your profile picture, Settings, Apps, Service accounts or Developer apps, Personal access token, Create new token." }] },
  read: readAsana,
  validate: (v) => (/^[0-9]\/[0-9]{5,30}\/[0-9]{5,30}:[a-f0-9]{20,64}$|^[A-Za-z0-9._:/-]{20,200}$/.test(v.token ?? "") ? undefined : "An Asana token is one long code with no spaces."),
};
