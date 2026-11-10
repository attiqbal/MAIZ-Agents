import { describe, expect, it } from "vitest";
import { AuditLog, EventBus, IdentityService, Ledger, LedgerError, PermissionError } from "../src/index.js";

async function setup() {
  const audit = new AuditLog();
  const identity = new IdentityService(audit, new EventBus());
  const ledger = new Ledger(identity, audit);
  const ws = await identity.createWorkspace("owner", { name: "Acme" });
  ledger.open("owner", ws.id);
  return { identity, ledger, ws: ws.id };
}
const dr = (account: string, n: number) => ({ account, debit: n, credit: 0 });
const cr = (account: string, n: number) => ({ account, debit: 0, credit: n });

describe("ledger", () => {
  it("rejects unbalanced, malformed and unknown-account entries", async () => {
    const { ledger, ws } = await setup();
    const p = (lines: any[], date = "2026-01-05") => () => ledger.post("owner", ws, { date, memo: "x", lines });
    expect(p([dr("1000", 100), cr("4000", 99)])).toThrow(/does not balance/);
    expect(p([dr("1000", 100)])).toThrow(/at least two/);
    expect(p([dr("1000", 1e20), cr("4000", 1e20)])).toThrow(/too large/);
    expect(p([dr("1000", 100), cr("9999", 100)])).toThrow(/unknown account/);
    expect(p([dr("1000", 10.5), cr("4000", 10.5)])).toThrow(/whole minor units/);
    expect(p([{ account: "1000", debit: 5, credit: 5 }, cr("4000", 0)])).toThrow(LedgerError);
    expect(p([dr("1000", 1), cr("4000", 1)], "2026-13-45")).toThrow(/invalid date/);
  });

  it("trial balance always balances and reports P&L and balance sheet", async () => {
    const { ledger, ws } = await setup();
    ledger.post("owner", ws, { date: "2026-01-01", memo: "Funding", lines: [dr("1000", 1_000_000), cr("3000", 1_000_000)] });
    ledger.post("owner", ws, { date: "2026-01-10", memo: "Sale", lines: [dr("1000", 300_000), cr("4000", 300_000)] });
    ledger.post("owner", ws, { date: "2026-01-15", memo: "Rent", lines: [dr("6000", 120_000), cr("1000", 120_000)] });
    const tb = ledger.trialBalance("owner", ws);
    expect(tb.debit).toBe(tb.credit);
    const pl = ledger.profitAndLoss("owner", ws, { from: "2026-01-01", to: "2026-01-31" });
    expect(pl).toMatchObject({ totalIncome: 300_000, totalExpenses: 120_000, netProfit: 180_000 });
    const bs = ledger.balanceSheet("owner", ws, "2026-01-31");
    expect(bs.totalAssets).toBe(1_180_000);
    expect(bs.totalAssets).toBe(bs.totalLiabilities + bs.totalEquity);
  });

  it("reversal fixes a mistake without editing history, and only once", async () => {
    const { ledger, ws } = await setup();
    const e = ledger.post("owner", ws, { date: "2026-02-01", memo: "Oops", lines: [dr("6900", 5000), cr("1000", 5000)] });
    ledger.reverse("owner", ws, e.id, "2026-02-02");
    expect(ledger.profitAndLoss("owner", ws, {}).netProfit).toBe(0);
    expect(ledger.journal("owner", ws)).toHaveLength(2);
    expect(() => ledger.reverse("owner", ws, e.id, "2026-02-03")).toThrow(/already reversed/);
    expect(() => ((e as any).memo = "changed")).toThrow();
  });

  it("computes runway from recent cash burn", async () => {
    const { ledger, ws } = await setup();
    ledger.post("owner", ws, { date: "2026-01-01", memo: "Funding", lines: [dr("1000", 1_000_000), cr("3000", 1_000_000)] });
    for (const d of ["2026-02-10", "2026-03-10", "2026-04-10"])
      ledger.post("owner", ws, { date: d, memo: "Burn", lines: [dr("6000", 100_000), cr("1000", 100_000)] });
    const r = ledger.runway("owner", ws, "2026-04-30", 3);
    expect(r).toMatchObject({ cashNow: 700_000, monthlyBurn: 100_000, runwayMonths: 7 });
    const grow = await setup();
    grow.ledger.post("owner", grow.ws, { date: "2026-04-01", memo: "Sale", lines: [dr("1000", 5), cr("4000", 5)] });
    expect(grow.ledger.runway("owner", grow.ws, "2026-04-30").runwayMonths).toBeNull();
  });

  it("keeps workspaces apart and enforces roles", async () => {
    const { ledger, ws, identity } = await setup();
    ledger.post("owner", ws, { date: "2026-01-01", memo: "x", lines: [dr("1000", 5), cr("4000", 5)] });
    const other = await identity.createWorkspace("someone", { name: "Other" });
    ledger.open("someone", other.id);
    expect(ledger.journal("someone", other.id)).toHaveLength(0);
    expect(() => ledger.journal("someone", ws)).toThrow(PermissionError);
    identity.addMember("owner", ws, "v", "viewer");
    expect(() => ledger.post("v", ws, { date: "2026-01-01", memo: "x", lines: [dr("1000", 5), cr("4000", 5)] })).toThrow(PermissionError);
    expect(ledger.trialBalance("v", ws).debit).toBe(5);
  });
});
