import { describe, expect, it } from "vitest";
import { AuditLog, EventBus, IdentityService, Ledger, ModelGateway, WorkforceService } from "../src/index.js";
import {
  ConnectorRegistry, IntegrationError, IntegrationService, defaultRegistry, parseBrightPayCsv, parseCsv, parseTillCsv, parseWebhookBody, toIsoDate, toMinor, toPayrollEntry, toSalesEntry,
  type Connector,
} from "../src/modules/integrations/index.js";
import { monthsIn, parseXeroProfitAndLoss } from "../src/modules/integrations/index.js";
import { integrationAppsFromEnv, checkEnv } from "../src/server/config.js";

const TILL_CSV = `Date,Total,VAT,Tip,Processing Fee,Payment Method
05/11/2026,"£1,200.00",200.00,5.00,18.00,Card
05/11/2026,(20.00),,,,Card
06/11/2026,300,50,,4.50,Cash
Total,1480,250,5,22.50,`;

const BRIGHTPAY_CSV = `Employee,Pay Date,Gross Pay,PAYE,Employee NI,Employer NI,Employee Pension,Employer Pension,Net Pay
Ann Smith,28/11/2026,2500.00,300.00,120.00,250.00,125.00,75.00,1955.00
Bob Jones,28/11/2026,1800.00,150.00,60.00,140.00,90.00,54.00,1500.00
Totals,,4300.00,450.00,180.00,390.00,215.00,129.00,3455.00`;

async function setup(http?: typeof fetch) {
  const audit = new AuditLog();
  const identity = new IdentityService(audit, new EventBus());
  const ledger = new Ledger(identity, audit);
  const ws = await identity.createWorkspace("owner", { name: "Kestrel", baseCurrency: "GBP" });
  ledger.open("owner", ws.id);
  const ig = new IntegrationService(identity, audit, ledger, defaultRegistry(), {
    http, now: () => new Date("2026-11-10T12:00:00Z"),
    oauthApps: {
      square: { clientId: "sq-id", clientSecret: "sq-secret", redirectUri: "https://app.test/api/integrations/callback" },
      xero: { clientId: "xo-id", clientSecret: "xo-secret", redirectUri: "https://app.test/api/integrations/callback" },
    },
  });
  return { audit, identity, ledger, ig, ws: ws.id };
}

describe("file helpers", () => {
  it("reads quoted CSV, money and dates", () => {
    expect(parseCsv('a,"b, c","d ""q"""\r\n1,2,3\n')).toEqual([["a", "b, c", 'd "q"'], ["1", "2", "3"]]);
    expect(toMinor("£1,234.5")).toBe(123450);
    expect(toMinor("(12.00)")).toBe(-1200);
    expect(toMinor("abc")).toBeUndefined();
    expect(toMinor("1.234")).toBeUndefined();
    expect(toIsoDate("05/11/2026")).toBe("2026-11-05");
    expect(toIsoDate("2026-11-05T10:00:00Z")).toBe("2026-11-05");
    expect(toIsoDate("31/02/2026")).toBeUndefined();
  });
});

describe("till files", () => {
  it("adds up sales per day, treats negatives as refunds and skips totals rows", () => {
    const r = parseTillCsv(TILL_CSV, { currency: "GBP" });
    expect(r.sales).toEqual([
      { date: "2026-11-05", currency: "GBP", gross: 120000, tax: 20000, tips: 500, fees: 1800, refunds: 2000, transactions: 2 },
      { date: "2026-11-06", currency: "GBP", gross: 30000, tax: 5000, tips: 0, fees: 450, refunds: 0, transactions: 1 },
    ]);
    expect(r.unmapped).toEqual(["Payment Method"]);
  });
  it("says what is missing instead of guessing", () => {
    expect(parseTillCsv("Date,Colour\n2026-01-01,red", { currency: "GBP" }).warnings[0]).toMatch(/sale amount/);
    expect(parseTillCsv("Total\n10", { currency: "GBP" }).warnings[0]).toMatch(/date/);
    expect(parseTillCsv("Date,Total\n2026-01-01,10", { currency: "GBP" }).warnings.join()).toMatch(/tax is recorded as 0/);
  });
});

describe("BrightPay payroll summary", () => {
  it("turns the export into one pay run with balanced deductions", () => {
    const r = parseBrightPayCsv(BRIGHTPAY_CSV, { currency: "GBP" });
    expect(r.payroll).toEqual([{ payDate: "2026-11-28", currency: "GBP", gross: 430000, incomeTax: 45000, employeeInsurance: 18000, employerInsurance: 39000, employeePension: 21500, employerPension: 12900, otherDeductions: 0, net: 345500, headcount: 2 }]);
    expect(r.warnings).toEqual([]);
  });
  it("flags money between gross and net that no column explains", () => {
    const r = parseBrightPayCsv("Employee,Gross Pay,PAYE,Net Pay\nAnn,1000,100,850", { currency: "GBP", date: "2026-11-28" });
    expect(r.payroll![0]!.otherDeductions).toBe(5000);
    expect(r.warnings.join()).toMatch(/not in any column/);
  });
  it("asks for the pay date when the file has none", () => {
    expect(parseBrightPayCsv("Gross Pay,Net Pay\n1,1", { currency: "GBP" }).warnings[0]).toMatch(/pay date/);
  });
});

describe("ledger posting", () => {
  it("sales and payroll entries always balance", () => {
    const s = toSalesEntry({ date: "2026-11-05", currency: "GBP", gross: 120000, tax: 20000, tips: 500, fees: 1800, refunds: 2000, transactions: 2 }, "x")!;
    const p = toPayrollEntry(parseBrightPayCsv(BRIGHTPAY_CSV, { currency: "GBP" }).payroll![0]!, "x")!;
    for (const e of [s, p]) expect(e.lines.reduce((n, l) => n + l.debit - l.credit, 0)).toBe(0);
    expect(p.lines.find((l) => l.account === "6100")!.debit).toBe(430000 + 39000 + 12900);
  });
});

describe("registry", () => {
  it("rejects connectors that could not work", () => {
    const r = new ConnectorRegistry();
    const base: Connector = { key: "x-app", name: "X", category: "till", summary: "", availability: "live", capabilities: ["sales.read"], auth: { kind: "api_key", fields: [] } };
    expect(() => r.register(base)).toThrow(/cannot read/);
    expect(() => r.register({ ...base, availability: "file", auth: { kind: "file", accepts: ".csv", howToExport: [] } })).toThrow(/cannot parse/);
    expect(() => r.register({ ...base, key: "Bad Key" })).toThrow(/bad connector key/);
  });
  it("lists BrightPay and planned tills honestly", async () => {
    const { ig } = await setup();
    const cat = ig.catalogue();
    expect(cat.find((c) => c.key === "brightpay")).toMatchObject({ availability: "file", connect: "file" });
    expect(cat.find((c) => c.key === "square")).toMatchObject({ availability: "live", connect: "oauth" });
    expect(cat.find((c) => c.key === "lightspeed")).toMatchObject({ availability: "partner", acceptsFiles: true });
  });
});

describe("integration service", () => {
  it("imports a file as pending, posts it once, and flags later changes", async () => {
    const { ig, ledger, ws } = await setup();
    const first = ig.importFile("owner", ws, "brightpay", BRIGHTPAY_CSV);
    expect(first).toMatchObject({ added: 1, conflicts: [] });
    expect(ig.pending("owner", ws)).toHaveLength(1);
    expect(ig.post("owner", ws)).toEqual({ posted: 1, skipped: [] });
    expect(ig.pending("owner", ws)).toHaveLength(0);
    expect(ledger.trialBalance("owner", ws).debit).toBe(ledger.trialBalance("owner", ws).credit);
    // Same file again: nothing new. Changed file: a conflict, never a silent double entry.
    expect(ig.importFile("owner", ws, "brightpay", BRIGHTPAY_CSV)).toMatchObject({ added: 0, unchanged: 1 });
    const changed = ig.importFile("owner", ws, "brightpay", BRIGHTPAY_CSV.replace("1955.00", "1950.00").replace("2500.00", "2495.00"));
    expect(changed.conflicts).toHaveLength(1);
    expect(ledger.journal("owner", ws)).toHaveLength(1);
  });

  it("gives each employee only the app data its job needs", async () => {
    const { ig, ws } = await setup();
    ig.importFile("owner", ws, "brightpay", BRIGHTPAY_CSV);
    ig.importFile("owner", ws, "till-file", TILL_CSV);
    expect(ig.contextFor(ws, "finance-manager")).toMatch(/Payroll paid 2026-11-28/);
    expect(ig.contextFor(ws, "marketing-manager")).toMatch(/Sales 2026-11/);
    expect(ig.contextFor(ws, "marketing-manager")).not.toMatch(/Payroll/);
    expect(ig.contextFor(ws, "admin-manager")).toBeUndefined();
    const payroll = ig.list("owner", ws).find((c) => c.connectorKey === "brightpay")!;
    // The owner can narrow access; the Admin manager can never be added.
    ig.setAccess("owner", ws, payroll.id, ["hr-manager", "admin-manager"]);
    expect(ig.list("owner", ws).find((c) => c.id === payroll.id)!.access).toEqual(["hr-manager"]);
    expect(ig.contextFor(ws, "finance-manager")).not.toMatch(/Payroll/);
  });

  it("keeps organisations apart and needs the owner to connect", async () => {
    const { ig, identity, ws } = await setup();
    const other = await identity.createWorkspace("eve", { name: "Other" });
    const conn = ig.importFile("owner", ws, "till-file", TILL_CSV).connectionId;
    expect(() => ig.disconnect("eve", other.id, conn)).toThrow(IntegrationError);
    expect(() => ig.list("eve", ws)).toThrow();
    identity.addMember("owner", ws, "mia", "member");
    expect(() => ig.createWebhook("mia", ws)).toThrow();
    expect(() => ig.setAccess("mia", ws, conn, [])).toThrow();
  });

  it("webhook needs the exact secret and stores only its hash", async () => {
    const { ig, ws } = await setup();
    const sink = { secrets: [] as string[] };
    ig.useSink({ integration() {}, integrationRecord() {}, integrationSecret(_w: string, _c: string, s: string) { sink.secrets.push(s); } } as never);
    const { connection, secret } = ig.createWebhook("owner", ws);
    expect(sink.secrets[0]).not.toContain(secret);
    expect(ig.receiveWebhook(connection.id, "wrong-secret-xxxxxxxx", { sales: [] })).toBeUndefined();
    const r = ig.receiveWebhook(connection.id, secret, { amountsIn: "major", sales: [{ date: "2026-11-07", gross: 99.5, tax: 16.58, transactions: 4 }] });
    expect(r).toMatchObject({ added: 1 });
    expect(ig.pending("owner", ws)[0]!.data).toMatchObject({ gross: 9950, tax: 1658 });
    ig.disconnect("owner", ws, connection.id);
    expect(ig.receiveWebhook(connection.id, secret, { sales: [] })).toBeUndefined();
  });

  it("parses webhook bodies defensively", () => {
    expect(parseWebhookBody("nope", "GBP").warnings[0]).toMatch(/JSON object/);
    expect(parseWebhookBody({ sales: [{ date: "bad", gross: 1 }] }, "GBP").warnings.join()).toMatch(/valid date/);
    expect(parseWebhookBody({ amountsIn: "major", accounts: [{ month: "2026-10", income: 100, expenses: 40 }, { month: "2026-13" }] }, "GBP")).toMatchObject({
      accounts: [{ month: "2026-10", currency: "GBP", income: 10000, costOfSales: 0, expenses: 4000, netProfit: 6000 }], warnings: [expect.stringMatching(/month/)],
    });
  });

  it("connects Square by OAuth and reads completed payments per day", async () => {
    const calls: string[] = [];
    const http = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith("/oauth2/token")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ client_id: "sq-id", client_secret: "sq-secret", code: "c0de", grant_type: "authorization_code" });
        return new Response(JSON.stringify({ access_token: "sq-access", refresh_token: "r", merchant_id: "M1" }), { status: 200 });
      }
      const u = new URL(String(url));
      const page = u.searchParams.get("cursor") ? 2 : 1;
      const payments = page === 1
        ? [{ status: "COMPLETED", created_at: "2026-11-05T10:00:00Z", amount_money: { amount: 1000, currency: "GBP" }, tip_money: { amount: 100 }, processing_fee: [{ amount_money: { amount: 18 } }] },
           { status: "FAILED", created_at: "2026-11-05T11:00:00Z", amount_money: { amount: 999, currency: "GBP" } }]
        : [{ status: "COMPLETED", created_at: "2026-11-05T12:00:00Z", amount_money: { amount: 500, currency: "GBP" }, refunded_money: { amount: 500 } }];
      return new Response(JSON.stringify({ payments, cursor: page === 1 ? "next" : undefined }), { status: 200 });
    }) as typeof fetch;
    const { ig, ws } = await setup(http);
    const url = new URL(ig.authorizeUrl("owner", ws, "square", "STATE"));
    expect(url.searchParams.get("scope")).toBe("PAYMENTS_READ MERCHANT_PROFILE_READ");
    expect(url.searchParams.get("state")).toBe("STATE");
    const conn = await ig.completeOAuth("owner", ws, "square", "c0de");
    expect(conn).toMatchObject({ externalAccount: "M1", status: "connected" });
    expect(JSON.stringify(ig.list("owner", ws))).not.toContain("sq-access");
    const r = await ig.sync("owner", ws, conn.id);
    expect(r.added).toBe(1);
    expect(ig.pending("owner", ws)[0]!.data).toEqual({ date: "2026-11-05", currency: "GBP", gross: 1500, tax: 0, tips: 100, fees: 18, refunds: 500, transactions: 2 });
    expect(calls.filter((c) => c.includes("/v2/payments"))).toHaveLength(2);
  });

  it("marks a Square connection as needing attention when the token is refused", async () => {
    const http = (async (url: string) => (String(url).endsWith("/oauth2/token")
      ? new Response(JSON.stringify({ access_token: "a" }), { status: 200 })
      : new Response("{}", { status: 401 }))) as typeof fetch;
    const { ig, ws } = await setup(http);
    const conn = await ig.completeOAuth("owner", ws, "square", "c");
    await expect(ig.sync("owner", ws, conn.id)).rejects.toThrow(/connect Square again/);
    expect(ig.list("owner", ws)[0]).toMatchObject({ status: "error" });
  });

  it("refuses direct connection when our app keys are not set", async () => {
    const audit = new AuditLog();
    const identity = new IdentityService(audit, new EventBus());
    const ws = await identity.createWorkspace("owner", { name: "K" });
    const ig = new IntegrationService(identity, audit, new Ledger(identity, audit), defaultRegistry());
    expect(() => ig.authorizeUrl("owner", ws.id, "square", "s")).toThrow(/Upload a file/);
    expect(ig.catalogue().find((c) => c.key === "square")!.connect).toBe("file");
  });
});

describe("employees see connected data", () => {
  it("adds the granted app figures to the Finance manager's instructions", async () => {
    const audit = new AuditLog();
    const bus = new EventBus();
    const identity = new IdentityService(audit, bus);
    const seen: string[] = [];
    const gateway = new ModelGateway([{ name: "spy", tiers: ["standard", "premium"], async complete(req) { seen.push(req.messages[0]!.content); return { text: "ok", provider: "spy", model: "m", inputTokens: 1, outputTokens: 1 }; } }]);
    const workforce = new WorkforceService(identity, audit, bus, gateway);
    const ledger = new Ledger(identity, audit);
    const ws = await identity.createWorkspace("owner", { name: "K", baseCurrency: "GBP" });
    const ig = new IntegrationService(identity, audit, ledger, defaultRegistry(), { now: () => new Date("2026-11-10T00:00:00Z") });
    workforce.addContext((w, t) => ig.contextFor(w, t));
    ig.importFile("owner", ws.id, "brightpay", BRIGHTPAY_CSV);
    const fin = await workforce.hire("owner", ws.id, "finance-manager");
    const mkt = await workforce.hire("owner", ws.id, "marketing-manager");
    await workforce.assign("owner", ws.id, fin.id, "cash?");
    await workforce.assign("owner", ws.id, mkt.id, "post?");
    expect(seen[0]).toMatch(/Payroll paid 2026-11-28: 2 staff/);
    expect(seen[1]).not.toMatch(/Payroll/);
  });
});

describe("config", () => {
  it("builds OAuth apps from environment variables and catches half-set pairs", () => {
    expect(integrationAppsFromEnv({ SQUARE_CLIENT_ID: "a", SQUARE_CLIENT_SECRET: "b" }, "https://app.x/")).toEqual({ square: { clientId: "a", clientSecret: "b", redirectUri: "https://app.x/api/integrations/callback" } });
    expect(integrationAppsFromEnv({ SQUARE_CLIENT_ID: "a" }, "https://app.x")).toEqual({});
    expect(checkEnv({ SQUARE_CLIENT_ID: "a" }).join()).toMatch(/SQUARE_CLIENT_ID and SQUARE_CLIENT_SECRET/);
  });
});

const XERO_PL = { Reports: [{ Rows: [
  { RowType: "Header", Cells: [{ Value: "" }, { Value: "30 Nov 2026" }] },
  { RowType: "Section", Title: "Income", Rows: [{ RowType: "Row", Cells: [{ Value: "Sales" }, { Value: "5000.00" }] }, { RowType: "SummaryRow", Cells: [{ Value: "Total Income" }, { Value: "5000.00" }] }] },
  { RowType: "Section", Title: "Less Cost of Sales", Rows: [{ RowType: "SummaryRow", Cells: [{ Value: "Total Cost of Sales" }, { Value: "1500.00" }] }] },
  { RowType: "Section", Title: "Less Operating Expenses", Rows: [{ RowType: "Row", Cells: [{ Value: "Wages and Salaries" }, { Value: "2000.00" }] }, { RowType: "SummaryRow", Cells: [{ Value: "Total Operating Expenses" }, { Value: "2500.00" }] }] },
  { RowType: "Section", Rows: [{ RowType: "Row", Cells: [{ Value: "Net Profit" }, { Value: "1000.00" }] }] },
] }] };

describe("Xero", () => {
  it("reads the totals out of a Profit and Loss report", () => {
    expect(parseXeroProfitAndLoss(XERO_PL.Reports[0]!, "2026-11", "GBP")).toEqual({ month: "2026-11", currency: "GBP", income: 500000, costOfSales: 150000, expenses: 250000, netProfit: 100000 });
    expect(monthsIn({ from: "2026-10-15", to: "2026-11-10" })).toEqual(["2026-10", "2026-11"]);
    expect(monthsIn({ from: "2024-01-01", to: "2026-11-10" })).toHaveLength(12);
  });

  it("connects with Basic auth, picks the organisation, refreshes expired tokens and never posts Xero figures", async () => {
    const seen: { url: string; auth?: string; tenant?: string; body?: string }[] = [];
    let issued = 0;
    const http = (async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: String(url), auth: h.authorization, tenant: h["xero-tenant-id"], body: init?.body ? String(init.body) : undefined });
      if (String(url).endsWith("/connect/token")) {
        issued++;
        // The first token expired long ago, so the sync must refresh it. (The expiry is computed from the real clock while the
        // service runs on the test's fixed clock, so "expires now" would only work before the fixed time of day.)
        return new Response(JSON.stringify({ access_token: `xa-${issued}`, refresh_token: `xr-${issued}`, expires_in: issued === 1 ? -86_400 * 3650 : 1800 }), { status: 200 });
      }
      if (String(url).endsWith("/connections")) return new Response(JSON.stringify([{ tenantId: "T-old", tenantName: "Old Co", updatedDateUtc: "2025-01-01" }, { tenantId: "T-new", tenantName: "Kestrel Ltd", updatedDateUtc: "2026-11-10" }]), { status: 200 });
      return new Response(JSON.stringify(XERO_PL), { status: 200 });
    }) as typeof fetch;
    const { ig, ws, ledger } = await setup(http);
    expect(new URL(ig.authorizeUrl("owner", ws, "xero", "s")).searchParams.get("scope")).toBe("openid offline_access accounting.reports.profitandloss.read");
    const conn = await ig.completeOAuth("owner", ws, "xero", "code");
    expect(conn.externalAccount).toBe("Kestrel Ltd");
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from("xo-id:xo-secret").toString("base64")}`);
    const r = await ig.sync("owner", ws, conn.id, { from: "2026-10-01", to: "2026-11-10" });
    expect(r.added).toBe(2);
    expect(seen.some((s) => s.body?.includes("grant_type=refresh_token") && s.body.includes("refresh_token=xr-1"))).toBe(true);
    const reports = seen.filter((s) => s.url.includes("ProfitAndLoss"));
    expect(reports.map((s) => [s.auth, s.tenant])).toEqual([["Bearer xa-2", "T-new"], ["Bearer xa-2", "T-new"]]);
    expect(reports[1]!.url).toContain("fromDate=2026-11-01&toDate=2026-11-30");
    // Read for context, never posted: no pending items and an untouched ledger.
    expect(ig.pending("owner", ws)).toHaveLength(0);
    expect(ig.post("owner", ws).posted).toBe(0);
    expect(ledger.journal("owner", ws)).toHaveLength(0);
    expect(ig.contextFor(ws, "finance-manager")).toMatch(/Books in Xero 2026-11: income 5000.00 GBP.*net profit 1000.00 GBP/);
    expect(ig.contextFor(ws, "marketing-manager")).toBeUndefined();
  });

  it("offers the Zapier bridge when our Xero keys are not set", async () => {
    const audit = new AuditLog();
    const identity = new IdentityService(audit, new EventBus());
    const ig = new IntegrationService(identity, audit, new Ledger(identity, audit), defaultRegistry());
    const cat = ig.catalogue();
    expect(cat.find((c) => c.key === "xero")!.connect).toBe("bridge");
    expect(cat.find((c) => c.key === "quickbooks")).toMatchObject({ connect: "bridge", availability: "planned" });
    for (const k of ["sage", "shopify", "paypal", "gusto", "stripe", "sumup"]) expect(cat.some((c) => c.key === k)).toBe(true);
  });
});

describe("Stripe", () => {
  it("only takes a read-only restricted key", async () => {
    const { ig, ws } = await setup();
    expect(() => ig.connectWithKey("owner", ws, "stripe", { restrictedKey: "sk_live_abcdefghijklmnop" })).toThrow(/restricted key/);
    expect(() => ig.connectWithKey("owner", ws, "stripe", { restrictedKey: "hello" })).toThrow(/does not look like/);
    expect(() => ig.connectWithKey("owner", ws, "stripe", {})).toThrow(/required/);
  });

  it("adds up charges, refunds and fees per day and ignores payouts", async () => {
    let page = 0;
    const http = (async (url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer rk_test_abcdefghijklmnop");
      page++;
      const day = Date.parse("2026-11-05T10:00:00Z") / 1000;
      const data = page === 1
        ? [{ id: "t1", type: "charge", amount: 2000, fee: 59, currency: "gbp", created: day }, { id: "t2", type: "payout", amount: -5000, fee: 0, currency: "gbp", created: day }]
        : [{ id: "t3", type: "refund", amount: -500, fee: 0, currency: "gbp", created: day }];
      expect(String(url).includes("starting_after=t2")).toBe(page === 2);
      return new Response(JSON.stringify({ data, has_more: page === 1 }), { status: 200 });
    }) as typeof fetch;
    const { ig, ws } = await setup(http);
    const conn = ig.connectWithKey("owner", ws, "stripe", { restrictedKey: "rk_test_abcdefghijklmnop" });
    await ig.sync("owner", ws, conn.id);
    expect(ig.pending("owner", ws)[0]!.data).toEqual({ date: "2026-11-05", currency: "GBP", gross: 2000, tax: 0, tips: 0, fees: 59, refunds: 500, transactions: 1 });
    expect(JSON.stringify(ig.list("owner", ws))).not.toContain("rk_test");
  });
});
