import { IntegrationError, type Connector, type ConnectorContext, type DateRange, type Records } from "../types.js";
import { GOOGLE_AUTHORIZE, GOOGLE_PARAMS, GOOGLE_TOKEN, googleExchange, googleRefresh } from "./google.js";
import { DayBook, dayOf, getJson, inRange, oauth } from "./util.js";

/**
 * Gmail inbox counts. Uses the gmail.metadata scope, which cannot read message bodies. Google treats Gmail scopes as
 * restricted: until Google has verified the app (and, for restricted scopes, a security assessment), only the test
 * users listed in the Google project can connect and their permission ends after 7 days. Built and ready; it goes
 * live for everyone when Google approves. Counts cover the newest 100 inbox messages per update.
 */
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
const MAX_MESSAGES = 100;

async function readGmail(ctx: ConnectorContext, range: DateRange): Promise<Records> {
  const { accessToken } = oauth(ctx, "Gmail");
  const headers = { authorization: `Bearer ${accessToken}` };
  const book = new DayBook("inbox", ctx.currency);
  const label: { messagesUnread?: number } = await getJson(ctx, `${API}/labels/INBOX`, headers, "Gmail");
  book.set(range.to, "unread", Number(label.messagesUnread) || 0);
  const list: { messages?: { id?: string }[] } = await getJson(ctx, `${API}/messages?labelIds=INBOX&maxResults=${MAX_MESSAGES}`, headers, "Gmail");
  const ids = (list.messages ?? []).map((m) => m.id).filter((id): id is string => !!id && /^[a-f0-9]{8,32}$/i.test(id));
  for (let i = 0; i < ids.length; i += 10) {
    const batch = await Promise.all(ids.slice(i, i + 10).map((id) => getJson(ctx, `${API}/messages/${id}?format=minimal`, headers, "Gmail") as Promise<{ internalDate?: string }>));
    for (const m of batch) {
      const t = Number(m.internalDate);
      if (Number.isFinite(t) && inRange(t, range.from, range.to)) book.add(dayOf(t), "received");
    }
  }
  return { activity: book.list() };
}

export const gmail: Connector = {
  key: "gmail", name: "Gmail", category: "messaging", availability: "approval", capabilities: ["inbox.read"],
  summary: "How many emails reach your inbox and how many are unread. Never the emails themselves.",
  note: "Uses Google's gmail.metadata permission, which cannot open message bodies. Google must approve MAIZ before everyone can connect; until then only test users can.",
  auth: { kind: "oauth2", authorizeUrl: GOOGLE_AUTHORIZE, tokenUrl: GOOGLE_TOKEN, scopes: [SCOPE], envPrefix: "GMAIL", authorizeParams: GOOGLE_PARAMS },
  setup: {
    console: { href: "https://console.cloud.google.com/auth/overview", label: "Google Auth Platform" },
    steps: [
      "Use a Google Cloud project separate from the sign-in and Analytics ones, so a Gmail review cannot hold those up. Turn on the Gmail API.",
      "In Data access add only the gmail.metadata scope. Under Clients create a Web application client and paste the Redirect URI shown on this page.",
      "Copy the Client ID and secret into the boxes here. Add up to 100 test users under Audience: they can connect now, for 7 days at a time.",
      "To open it to every client, press Publish app and submit it for verification (a short video, your privacy page, and the explanation that only counts are kept). Google may require a third-party security assessment for Gmail scopes.",
    ],
    approval: "Several weeks, plus the cost of the security assessment if Google asks for one. Test users work in the meantime.",
  },
  read: readGmail,
  exchangeCode: async (http, app, code) => ({ credentials: await googleExchange(http, app, code) }),
  refresh: googleRefresh,
};

void IntegrationError;
