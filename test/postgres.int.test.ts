import pg from "pg";
import { describe, expect, it } from "vitest";
import { createApp, makeToken, userIdFor, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { PgStore } from "../src/storage/postgres.js";

// Runs only against a real Postgres: `npm run db:int` starts a throwaway one.
const ADMIN = process.env.TEST_DATABASE_URL;
const APP = process.env.TEST_DATABASE_APP_URL;
const KEY = "ab".repeat(32);
const SLACK = { clientId: "c", clientSecret: "s", signingSecret: "sg", redirectUri: "https://x/cb" };

async function boot(platformOwners: string[] = []) {
  const http = (async (url: any) =>
    String(url).includes("oauth.v2.access")
      ? { json: async () => ({ ok: true, access_token: "xoxb-secret-token", team: { id: "T7" }, authed_user: { id: "U7" } }) }
      : { json: async () => ({ ok: true }) }) as any;
  const platform = createPlatform({ sessionSecret: "k", allowDevAuth: true, slack: SLACK, http, platformOwners, now: () => new Date("2026-06-10T10:00:00Z") });
  const store = new PgStore({ adminUrl: ADMIN!, appUrl: APP!, tokenKeyHex: KEY });
  await store.migrate();
  await platform.attachStore(store);
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, token?: string, query = "") =>
    handle({ method, path, query: new URLSearchParams(query), headers: token ? { authorization: `Bearer ${token}` } : {}, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  return { platform, store, call };
}

describe.skipIf(!ADMIN || !APP)("postgres persistence", () => {
  it("everything survives a restart, and chat tokens are encrypted at rest", async () => {
    const a = await boot();
    const signup = await a.call("POST", "/api/signup", { email: "ann@kestrel.co", businessName: "Kestrel Coffee", sells: "Coffee", size: "2-10", country: "GB" });
    expect(signup.status).toBe(201);
    const token = (signup.body as any).token;
    const org = (await a.call("GET", "/api/org", undefined, token)).body as any;
    const user = userIdFor("ann@kestrel.co");

    // books: a sale, a mistake, and its reversal
    const sale = { date: "2026-06-02", memo: "Sale", lines: [{ account: "1000", debit: 9000, credit: 0 }, { account: "4000", debit: 0, credit: 9000 }] };
    expect((await a.call("POST", "/api/finance/entries", sale, token)).status).toBe(201);
    const oops = a.platform.ledger.post(user, org.id, { date: "2026-06-03", memo: "Oops", lines: [{ account: "6900", debit: 500, credit: 0 }, { account: "1000", debit: 0, credit: 500 }] });
    a.platform.ledger.reverse(user, org.id, oops.id, "2026-06-04");

    // work: spends energy
    const ask = await a.call("POST", "/api/ask", { text: "Draft a post", employeeId: org.team[1].id, urgent: true }, token);
    expect((ask.body as any).status).toBe("ready_for_review");

    // the Admin manager: welcome is stored, setup runs from the form
    const answers = { goals: "More subscribers", customers: "Home coffee drinkers" };
    expect(((await a.call("POST", "/api/setup", { answers }, token)).body as any).state).toBe("ready");

    // chat: Slack install stores an encrypted bot token
    const { url } = (await a.call("GET", "/api/slack/install", undefined, token)).body as any;
    expect((await a.call("GET", "/api/slack/callback", undefined, undefined, `code=1&state=${new URL(url).searchParams.get("state")}`)).status).toBe(302);

    // business apps: a payroll file (pending), a till file (posted) and a webhook with a secret
    const payroll = "Employee,Pay Date,Gross Pay,PAYE,Net Pay\nAnn,05/06/2026,1000,100,900";
    expect((await a.call("POST", "/api/integrations/apps/brightpay/import", { csv: payroll }, token)).status).toBe(200);
    await a.call("POST", "/api/integrations/post", {}, token);
    await a.call("POST", "/api/integrations/apps/till-file/import", { csv: "Date,Total,VAT\n2026-06-06,60,10" }, token);
    const hook = (await a.call("POST", "/api/integrations/apps/webhook/connect", {}, token)).body as any;
    const hookPath = new URL(hook.url, "https://x").pathname;
    const apps = (await a.call("GET", "/api/integrations", undefined, token)).body;

    const before = {
      summary: (await a.call("GET", "/api/finance/summary", undefined, token)).body,
      org: (await a.call("GET", "/api/org", undefined, token)).body,
      audit: a.platform.audit.list(org.id).length,
      setup: (await a.call("GET", "/api/setup", undefined, token)).body,
    };
    await a.store.flush();
    expect(a.store.healthy).toBe(true);

    // the token is not readable in the database
    const admin = new pg.Pool({ connectionString: ADMIN });
    const raw = await admin.query("SELECT data::text AS d FROM state_records WHERE kind='slack_token'");
    expect(raw.rows[0].d).not.toContain("xoxb-secret-token");
    const hookRaw = await admin.query("SELECT data::text AS d FROM state_records WHERE kind='int_secret'");
    expect(hookRaw.rows.map((r) => r.d).join()).not.toContain(hookPath.split("/").pop());
    // the database itself keeps the books balanced and append-only
    const bal = await admin.query("SELECT (sum(debit) - sum(credit))::bigint AS diff FROM journal_lines");
    expect(bal.rows[0].diff).toBe(0);
    await admin.end();
    await a.store.close();

    // "restart": a brand new platform that only knows the database
    const b = await boot();
    expect((await b.call("GET", "/api/org", undefined, token)).body).toEqual(before.org);
    expect((await b.call("GET", "/api/finance/summary", undefined, token)).body).toEqual(before.summary);
    expect(b.platform.audit.list(org.id).length).toBe(before.audit);
    expect((await b.call("GET", "/api/setup", undefined, token)).body).toEqual(before.setup);
    // setup can still be undone after a restart, and the undone state survives another one
    const undone = (await b.call("POST", "/api/setup/rollback", undefined, token)).body as any;
    expect(undone.run.status).toBe("rolled_back");
    expect(b.platform.slackTokens.get("T7")).toBe("xoxb-secret-token");
    // apps, their pending records and the webhook secret all came back
    expect((await b.call("GET", "/api/integrations", undefined, token)).body).toEqual(apps);
    expect((await b.call("POST", hookPath, { sales: [{ date: "2026-06-07", gross: 100 }] })).status).toBe(200);
    expect((await b.call("POST", "/api/signup", { email: "ann@kestrel.co", businessName: "Again" })).status).toBe(409);
    // the Slack person is still linked and gets an answer, and usage records came back
    expect(await b.platform.router.handle({ channel: "slack", externalWorkspace: "T7", externalUser: "U7", conversation: "D1", text: "hello", eventId: "E-after-restart" })).toBe("replied");
    expect(b.platform.energy.monthSummary(user, org.id, "2026-06").byEmployee[org.team[1].id]).toBeDefined();
    await b.store.flush();
    expect(b.store.healthy).toBe(true);
    await b.store.close();
  }, 30000);

  it("keeps price changes, custom specialist requests and the client's email across a restart", async () => {
    const OWNER = "owner@maiz.test";
    const ownerToken = makeToken("k", { k: "session", u: userIdFor(OWNER), e: OWNER }, 7 * 86400, new Date("2026-06-10T10:00:00Z").getTime());
    const a = await boot([OWNER]);
    const email = `bob${Date.now()}@bakery.co`;
    const client = (await a.call("POST", "/api/signup", { email, businessName: "Bob's Bakery", sells: "Bread", size: "2-10", country: "GB" })).body as any;
    const change = await a.call("POST", "/api/owner/prices/changes", { general: { addOnEmployeeMonthlyGbp: 14 }, agents: { "marketing-manager": 450 }, note: "Int test" }, ownerToken);
    expect(change.status).toBe(201);
    const madeSp = await a.call("POST", "/api/specialists", { title: "Wholesale account coordinator", purpose: "Look after cafes that buy in bulk", duties: ["Prepare price lists", "Chase repeat orders"] }, client.token);
    expect(madeSp.body).toMatchObject({ request: { status: "in_review" } });
    const req = (madeSp.body as any).request;
    await a.call("POST", `/api/owner/specialists/${req.id}/decide`, { decision: "approved", priceGbp: 22 }, ownerToken);
    await a.store.flush();
    await a.store.close();

    const b = await boot([OWNER]);
    expect(((await b.call("GET", "/api/store")).body as any).prices.addOnEmployeeMonthlyGbp).toBe(14);
    expect(((await b.call("GET", "/api/owner/prices", undefined, ownerToken)).body as any).history.some((h: any) => h.note === "Int test")).toBe(true);
    expect(((await b.call("GET", "/api/specialists", undefined, client.token)).body as any).requests[0]).toMatchObject({ status: "approved", priceGbp: 22 });
    const row = ((await b.call("GET", "/api/owner/clients", undefined, ownerToken)).body as any).clients.find((c: any) => c.ownerEmail === email);
    expect(row).toMatchObject({ name: "Bob's Bakery", specialistsToReview: 0 });
    const app = new pg.Client({ connectionString: APP });
    await app.connect();
    await expect(app.query("SELECT * FROM platform_records")).rejects.toThrow(/permission denied/);
    await app.end();
    await b.store.close();
  }, 30000);
});
