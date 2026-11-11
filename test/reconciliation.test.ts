import { describe, expect, it } from "vitest";
import { reconcile, ReconciliationService } from "../src/modules/reconciliation/index.js";
import { DEFAULT_CHART, type JournalEntry } from "../src/modules/ledger/index.js";
import type { StoredRecord } from "../src/modules/integrations/service.js";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";

let n = 0;
const entry = (over: Partial<JournalEntry> & { lines: JournalEntry["lines"] }): JournalEntry =>
  ({ id: `e${++n}` as any, workspaceId: "w", date: "2026-11-01", memo: `m${n}`, ...over }) as JournalEntry;
const sale = (id: string, amount = 1000, over: Partial<JournalEntry> = {}) =>
  entry({ id: id as any, lines: [{ account: "1000", debit: amount, credit: 0 }, { account: "4000", debit: 0, credit: amount }], ...over });
const base = { accounts: DEFAULT_CHART, records: [], orders: [] };
const checks = (f: ReturnType<typeof reconcile>) => f.map((x) => x.check);

describe("reconcile", () => {
  it("is quiet for healthy books", () => {
    expect(reconcile({ ...base, entries: [sale("a"), sale("b", 500, { source: "inv-1" })] })).toEqual([]);
  });

  it("catches an unbalanced entry, an unknown account and a bad line", () => {
    const f = reconcile({ ...base, entries: [
      entry({ lines: [{ account: "1000", debit: 100, credit: 0 }, { account: "4000", debit: 0, credit: 90 }] }),
      entry({ lines: [{ account: "9999", debit: 100, credit: 0 }, { account: "4000", debit: 0, credit: 100 }] }),
      entry({ lines: [{ account: "1000", debit: 1.5, credit: 0 }, { account: "4000", debit: 0, credit: 1.5 }] }),
    ] });
    expect(checks(f)).toEqual(expect.arrayContaining(["balanced", "trial-balance", "entry-lines"]));
    expect(f.filter((x) => x.check === "entry-lines")).toHaveLength(3);
  });

  it("checks reversals mirror the original and happen once", () => {
    const a = sale("a", 1000, { source: "inv-1" });
    const good = sale("r1", 1000, { reverses: "a" as any, lines: [{ account: "1000", debit: 0, credit: 1000 }, { account: "4000", debit: 1000, credit: 0 }] });
    expect(reconcile({ ...base, entries: [a, good] })).toEqual([]);
    const notMirror = sale("r2", 900, { reverses: "a" as any, lines: [{ account: "1000", debit: 0, credit: 900 }, { account: "4000", debit: 900, credit: 0 }] });
    expect(checks(reconcile({ ...base, entries: [a, notMirror] }))).toContain("reversals");
    expect(checks(reconcile({ ...base, entries: [a, good, { ...good, id: "r3" as any }] }))).toContain("reversals");
    expect(checks(reconcile({ ...base, entries: [sale("r4", 1000, { reverses: "ghost" as any })] }))).toContain("reversals");
  });

  it("flags the same source booked twice, unless the first was reversed", () => {
    const a = sale("a", 1000, { source: "inv-1" });
    const b = sale("b", 1000, { source: "inv-1" });
    expect(checks(reconcile({ ...base, entries: [a, b] }))).toContain("double-posting");
    const rev = sale("r", 1000, { reverses: "a" as any, lines: [{ account: "1000", debit: 0, credit: 1000 }, { account: "4000", debit: 1000, credit: 0 }] });
    expect(checks(reconcile({ ...base, entries: [a, rev, b] }))).not.toContain("double-posting");
  });

  it("matches booked app records to their entries", () => {
    const rec = (over: Partial<StoredRecord>): StoredRecord => ({ id: "r1", workspaceId: "w", connectionId: "c", kind: "sales", date: "2026-11-01", data: {} as any, status: "posted", entryId: "a", ...over });
    const a = sale("a", 1000, { source: "app:r1" });
    expect(reconcile({ ...base, entries: [a], records: [rec({})] })).toEqual([]);
    expect(checks(reconcile({ ...base, entries: [], records: [rec({})] }))).toContain("app-records");
    expect(checks(reconcile({ ...base, entries: [sale("a", 1000, { source: "app:other" })], records: [rec({})] }))).toContain("app-records");
    expect(reconcile({ ...base, entries: [a], records: [] }).map((x) => x.severity)).toEqual(["warn"]);
  });

  it("flags a paid order that was never delivered, and a negative bank balance as a warning", () => {
    const order: any = { id: "o1", status: "paid", dueTodayMinor: 1900 };
    expect(checks(reconcile({ ...base, entries: [], orders: [order] }))).toContain("orders");
    expect(reconcile({ ...base, entries: [], orders: [{ ...order, fulfilledAt: "x" }] })).toEqual([]);
    const spend = entry({ lines: [{ account: "6200", debit: 500, credit: 0 }, { account: "1000", debit: 0, credit: 500 }] });
    expect(reconcile({ ...base, entries: [spend] })).toMatchObject([{ check: "cash", severity: "warn" }]);
  });
});

describe("nightly run", () => {
  it("checks each client once after their own midnight and alerts once when something is wrong", async () => {
    let date = "2026-11-10";
    const alerts: string[] = [];
    let entries = [sale("a")];
    const svc = new ReconciliationService({
      workspaceIds: () => ["w1", "w2"], localDate: () => date, now: () => new Date("2026-11-10T00:01:00Z"),
      books: (ws) => (ws === "w1" ? { accounts: [...DEFAULT_CHART], entries } : undefined), records: () => [], orders: () => [],
      alert: async (ws) => { alerts.push(ws); },
    });
    expect((await svc.tick()).map((r) => r.workspaceId)).toEqual(["w1"]); // w2 has no books yet
    await svc.tick();
    expect(svc.latestFor("w1")).toMatchObject({ ok: true, date: "2026-11-10", entries: 1 });
    entries = [sale("a"), entry({ lines: [{ account: "1000", debit: 5, credit: 0 }, { account: "4000", debit: 0, credit: 4 }] })];
    await svc.runOne("w1"); await svc.runOne("w1"); // run-now twice on the same day alerts once
    expect(alerts).toEqual(["w1"]);
    date = "2026-11-11"; // the client's midnight passes
    expect((await svc.tick()).map((r) => r.workspaceId)).toEqual(["w1"]);
    expect(alerts).toEqual(["w1", "w1"]); // still broken on a new day: told again
  });

  it("is wired in: the owner sees every client's result and is emailed when books are wrong", async () => {
    const OWNER = "atif@maiz.test";
    const clock = { d: new Date("2026-11-10T09:00:00Z") };
    const mail = new MemoryEmailSender();
    const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: mail, appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d });
    const handle = createApp(platform);
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
    const su = await call("POST", "/api/signup", { email: "ann@kestrel.co", businessName: "Kestrel", sells: "Coffee", size: "2–10", country: "GB" });
    const ann = { authorization: `Bearer ${(su.body as any).token}` };
    const owner = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(OWNER), e: OWNER }, 86400, clock.d.getTime())}` };
    expect((await call("GET", "/api/owner/reconciliation", undefined, ann)).status).toBe(403);
    await call("POST", "/api/finance/entries", { date: "2026-11-09", memo: "Opening cash", lines: [{ account: "1000", debit: 5000, credit: 0 }, { account: "3000", debit: 0, credit: 5000 }] }, ann);
    const run = await call("POST", "/api/owner/reconciliation/run", undefined, owner);
    expect((run.body as any).reports[0]).toMatchObject({ clientName: "Kestrel", ok: true });
    const clients = (await call("GET", "/api/owner/clients", undefined, owner)).body as any;
    expect(clients.clients[0].books).toMatchObject({ ok: true, problems: 0 });
  });
});
