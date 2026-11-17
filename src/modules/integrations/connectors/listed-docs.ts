import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records } from "../types.js";
import { DayBook, dayOf, getJson, inRange, oauth } from "./util.js";
import { exchange, makeRefresh } from "./oauth-util.js";

/**
 * DocuSign (documents sent, signed and waiting) and Canva (how many designs you have and how many changed). Counts only:
 * no document names, signers, design titles or pictures are read into our records.
 */
const MAX_PAGES = 5;

// ---------- DocuSign ----------

const DS_AUTH = "https://account.docusign.com/oauth/auth";
const DS_TOKEN = "https://account.docusign.com/oauth/token";
const DS_USERINFO = "https://account.docusign.com/oauth/userinfo";
/** The account's own web address is trusted only when it is DocuSign's. It is kept as the connection's account. */
const DS_BASE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.docusign\.(net|com)\/restapi\/v2\.1\/accounts\/[0-9a-f-]{36}$/i;

async function readDocusign(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken, tenant } = oauth(ctx, "DocuSign");
  if (!tenant || !DS_BASE.test(tenant)) throw new IntegrationError("Please connect DocuSign again.");
  const h = { authorization: `Bearer ${accessToken}` };
  const book = new DayBook("documents", ctx.currency);
  let waiting = 0;
  for (let start = 0, page = 0; page < MAX_PAGES; page++, start += 1000) {
    const q = new URLSearchParams({ from_date: `${range.from}T00:00:00Z`, to_date: `${range.to}T23:59:59Z`, count: "1000", start_position: String(start) });
    const body: { envelopes?: { status?: string; sentDateTime?: string; completedDateTime?: string }[]; resultSetSize?: string | number; totalSetSize?: string | number } = await getJson(ctx, `${tenant}/envelopes?${q}`, h, "DocuSign");
    for (const e of body.envelopes ?? []) {
      if (inRange(e.sentDateTime, range.from, range.to)) book.add(dayOf(e.sentDateTime!), "sent");
      if (e.status === "completed" && inRange(e.completedDateTime, range.from, range.to)) book.add(dayOf(e.completedDateTime!), "completed");
      if (e.status === "sent" || e.status === "delivered") waiting++;
    }
    if (start + (Number(body.resultSetSize) || 0) >= (Number(body.totalSetSize) || 0)) break;
  }
  book.set(range.to, "waiting", waiting);
  return { activity: book.list() };
}

export const docusign: Connector = {
  key: "docusign", name: "DocuSign", category: "teamwork", availability: "approval", capabilities: ["documents.read"],
  summary: "How many agreements you sent, how many are signed, and how many are still waiting for a signature.",
  note: "Read-only counts. Document names, signers and contents are never read. DocuSign apps must pass a go-live review before they can connect other accounts.",
  auth: { kind: "oauth2", authorizeUrl: DS_AUTH, tokenUrl: DS_TOKEN, scopes: ["signature"], envPrefix: "DOCUSIGN", tokenAuth: "basic" },
  setup: {
    console: { href: "https://developers.docusign.com/", label: "DocuSign developer centre" },
    steps: [
      "Create a free DocuSign developer account and, under Apps and Keys, add an app. The Integration key is the Client ID. Under Authentication choose Authorization Code Grant and add a secret key.",
      "Add the Redirect URI shown on this page. Copy the Integration key and the secret into the boxes here.",
      "Test it with your sandbox, then request Go-Live (Apps and Keys, Go Live). DocuSign checks that the app made 20 successful calls in the sandbox, then you promote it to a production account.",
      "Note: the boxes here use DocuSign's production sign-in. The sandbox uses a different address, so test the sandbox by hand before going live.",
    ],
    approval: "Usually one to two weeks.",
  },
  read: readDocusign,
  async exchangeCode(http, app, code) {
    const { credentials } = await exchange(http, "DocuSign", DS_TOKEN, app, code, undefined, { basic: true });
    if (credentials.kind !== "oauth2") throw new IntegrationError("DocuSign did not approve the connection");
    let info: { accounts?: { account_id?: string; base_uri?: string; is_default?: boolean }[] } = {};
    try {
      const res = await http(DS_USERINFO, { headers: { authorization: `Bearer ${credentials.accessToken}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
      info = (await res.json().catch(() => ({}))) as typeof info;
    } catch { throw new IntegrationError("DocuSign could not be reached. Try again in a minute."); }
    const acc = (info.accounts ?? []).find((a) => a.is_default) ?? info.accounts?.[0];
    const tenant = acc?.base_uri && acc.account_id ? `${acc.base_uri.replace(/\/$/, "")}/restapi/v2.1/accounts/${acc.account_id}` : "";
    if (!DS_BASE.test(tenant)) throw new IntegrationError("DocuSign did not name an account we can use. Please try again.");
    return { credentials: { ...credentials, tenant }, externalAccount: new URL(tenant).hostname };
  },
  refresh: makeRefresh("DocuSign", DS_TOKEN, { basic: true }),
};

// ---------- Canva ----------

const CANVA = "https://api.canva.com/rest/v1";
const CANVA_TOKEN = `${CANVA}/oauth/token`;

async function readCanva(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken } = oauth(ctx, "Canva");
  const book = new DayBook("documents", ctx.currency);
  let total = 0;
  let continuation: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ ownership: "owned", sort_by: "modified_descending", limit: "100", ...(continuation ? { continuation } : {}) });
    const body: { items?: { updated_at?: number }[]; continuation?: string } = await getJson(ctx, `${CANVA}/designs?${q}`, { authorization: `Bearer ${accessToken}` }, "Canva");
    for (const d of body.items ?? []) {
      total++;
      if (typeof d.updated_at === "number" && inRange(d.updated_at * 1000, range.from, range.to)) book.add(dayOf(d.updated_at * 1000), "designsUpdated");
    }
    continuation = body.continuation;
    if (!continuation) break;
  }
  book.set(range.to, "designs", total);
  return { activity: book.list() };
}

export const canva: Connector = {
  key: "canva", name: "Canva", category: "marketing", availability: "approval", capabilities: ["documents.read"],
  summary: "How many designs you have in Canva and how many you made or changed.",
  note: "Read-only counts: design titles and pictures are never read. Filling Canva brand templates with an agent's text is a different Canva feature and is not built.",
  auth: { kind: "oauth2", authorizeUrl: "https://www.canva.com/api/oauth/authorize", tokenUrl: CANVA_TOKEN, scopes: ["design:meta:read"], envPrefix: "CANVA", tokenAuth: "basic", pkce: true },
  setup: {
    console: { href: "https://www.canva.com/developers/", label: "Canva developers: your integrations" },
    steps: [
      "In Canva's developer portal create an integration of the type that connects to the Canva Connect API.",
      "Under Scopes tick only design:meta:read (read design details). Paste the Redirect URI shown on this page under Authentication.",
      "Copy the Client ID and generate a Client secret (shown once) into the boxes here.",
      "Canva keeps a new integration private to your own team. To let other people connect, make it public and submit it for Canva's review: check Canva's current rules for what review needs.",
    ],
    approval: "Canva's review time is not published. Check the portal.",
  },
  read: readCanva,
  async exchangeCode(http, app, code, params) {
    const { credentials } = await exchange(http, "Canva", CANVA_TOKEN, app, code, params?.code_verifier, { basic: true });
    return { credentials };
  },
  refresh: makeRefresh("Canva", CANVA_TOKEN, { basic: true }),
};
