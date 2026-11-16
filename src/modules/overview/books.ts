// The Books and cash screen: only figures a connected app sent or the client's own books hold, each with the app
// and the period it came from. A pure function over plain data.
//
// What is deliberately not here: a bank figure, money owed, how long the cash lasts, or a profit worked out by us.
// No connected source gives those, and a number that looks like advice from an accountant must come from one.
// The only profit shown is the one the client's own accounting app reported, labelled as that app's figure.
import type { Account, JournalEntry } from "../ledger/index.js";
import type { StoredRecord } from "../integrations/service.js";
import type { AccountsMonth, PayrollRun, SalesDay } from "../integrations/types.js";
import type { ReconciliationReport } from "../reconciliation/index.js";
import { addDays, addMonths } from "../people/dates.js";

export type Brings = "sales" | "payroll" | "accounts";
export const BOOKS_PERIODS = [7, 30, 90] as const;
/** An accounting app's months are kept on screen for at least this long, whatever period is picked. */
const ACCOUNTS_MONTHS_BACK = 3;

export interface BooksConnection { id: string; app: string; category: string; brings: readonly Brings[]; status: "connected" | "disconnected" | "error"; lastSyncAt?: string }

export interface BooksInput {
  /** The client's own date today, YYYY-MM-DD. */
  today: string;
  days: number;
  baseCurrency: string;
  connections: readonly BooksConnection[];
  records: readonly StoredRecord[];
  books?: { accounts: readonly Account[]; entries: readonly JournalEntry[] };
  check?: ReconciliationReport;
}

interface Money { moneyIn: number; tax: number; tips: number; refunds: number; fees: number; transactions: number }
export interface SalesSource extends Money { connectionId: string; app: string; currency: string; daysWithFigures: number; firstDate: string; lastDate: string; waiting: number }
export interface SalesDayRow { date: string; currency: string; moneyIn: number; refunds: number; fees: number; tips: number; transactions: number; apps: string[] }
export interface SalesTotal extends Money { currency: string }
export interface PayRunRow { app: string; payDate: string; currency: string; gross: number; net: number; employerCosts: number; headcount: number; inBooks: boolean }
export interface AccountsRow { app: string; month: string; currency: string; income: number; costOfSales: number; expenses: number; reportedProfit?: number }
export interface LedgerLine { code: string; name: string; type: "income" | "expense"; amount: number }

export interface BooksView {
  period: { from: string; to: string; days: number };
  apps: { id: string; app: string; category: string; brings: Brings[]; problem: boolean; lastUpdatedAt?: string }[];
  sales: { sources: SalesSource[]; days: SalesDayRow[]; totals: SalesTotal[] };
  payroll: PayRunRow[];
  accounts: AccountsRow[];
  ledger: { opened: boolean; currency: string; entries: number; fromApps: number; lastEntryDate?: string; lines: LedgerLine[]; waiting: number };
  check?: { date: string; ranAt: string; entriesChecked: number; ok: boolean; problems: number; warnings: number };
}

const zero = (): Money => ({ moneyIn: 0, tax: 0, tips: 0, refunds: 0, fees: 0, transactions: 0 });
const plus = (a: Money, d: SalesDay): Money => ({
  moneyIn: a.moneyIn + d.gross, tax: a.tax + d.tax, tips: a.tips + d.tips, refunds: a.refunds + d.refunds, fees: a.fees + d.fees, transactions: a.transactions + d.transactions,
});

interface Ctx { from: string; to: string; base: string; live: BooksConnection[]; order: Map<string, number>; byId: Map<string, BooksConnection> }

/** Base currency first, then by name, so the client's own money always leads. */
const currencyOrder = (base: string) => (a: string, b: string): number => Number(b === base) - Number(a === base) || a.localeCompare(b);

function salesOf(records: readonly StoredRecord[], c: Ctx): BooksView["sales"] {
  const inPeriod = records.filter((r) => r.kind === "sales" && c.byId.has(r.connectionId) && r.date >= c.from && r.date <= c.to);
  const sources = new Map<string, SalesSource>();
  const days = new Map<string, SalesDayRow & { order: number[] }>();
  const totals = new Map<string, SalesTotal>();
  for (const r of inPeriod) {
    const d = r.data as SalesDay;
    const conn = c.byId.get(r.connectionId)!;
    const sKey = `${r.connectionId} ${d.currency}`;
    const s = sources.get(sKey) ?? { connectionId: conn.id, app: conn.app, currency: d.currency, ...zero(), daysWithFigures: 0, firstDate: r.date, lastDate: r.date, waiting: 0 };
    sources.set(sKey, { ...s, ...plus(s, d), daysWithFigures: s.daysWithFigures + 1, firstDate: r.date < s.firstDate ? r.date : s.firstDate, lastDate: r.date > s.lastDate ? r.date : s.lastDate, waiting: s.waiting + (r.status === "pending" ? 1 : 0) });
    const dKey = `${r.date} ${d.currency}`;
    const row = days.get(dKey) ?? { date: r.date, currency: d.currency, moneyIn: 0, refunds: 0, fees: 0, tips: 0, transactions: 0, apps: [], order: [] };
    const at = c.order.get(conn.id) ?? 0;
    days.set(dKey, { ...row, moneyIn: row.moneyIn + d.gross, refunds: row.refunds + d.refunds, fees: row.fees + d.fees, tips: row.tips + d.tips, transactions: row.transactions + d.transactions, order: row.order.includes(at) ? row.order : [...row.order, at] });
    const t = totals.get(d.currency) ?? { currency: d.currency, ...zero() };
    totals.set(d.currency, { ...t, ...plus(t, d) });
  }
  const cur = currencyOrder(c.base);
  return {
    sources: [...sources.values()].sort((a, b) => (c.order.get(a.connectionId) ?? 0) - (c.order.get(b.connectionId) ?? 0) || cur(a.currency, b.currency)),
    days: [...days.values()].sort((a, b) => b.date.localeCompare(a.date) || cur(a.currency, b.currency))
      .map(({ order, ...row }) => ({ ...row, apps: [...order].sort((a, b) => a - b).map((i) => c.live[i]!.app) })),
    totals: [...totals.values()].sort((a, b) => cur(a.currency, b.currency)),
  };
}

function payrollOf(records: readonly StoredRecord[], c: Ctx): PayRunRow[] {
  return records
    .filter((r) => r.kind === "payroll" && c.byId.has(r.connectionId) && r.date >= c.from && r.date <= c.to)
    .map((r) => {
      const p = r.data as PayrollRun;
      return { app: c.byId.get(r.connectionId)!.app, payDate: p.payDate, currency: p.currency, gross: p.gross, net: p.net, employerCosts: p.employerInsurance + p.employerPension, headcount: p.headcount, inBooks: r.status === "posted" };
    })
    .sort((a, b) => b.payDate.localeCompare(a.payDate) || a.app.localeCompare(b.app));
}

function accountsOf(records: readonly StoredRecord[], c: Ctx, today: string): AccountsRow[] {
  const earliest = [c.from, addMonths(today, -ACCOUNTS_MONTHS_BACK)].sort()[0]!.slice(0, 7);
  return records
    .filter((r) => r.kind === "accounts" && c.byId.has(r.connectionId) && r.date >= earliest && r.date <= c.to.slice(0, 7))
    .sort((a, b) => b.date.localeCompare(a.date) || (c.order.get(a.connectionId) ?? 0) - (c.order.get(b.connectionId) ?? 0))
    .map((r) => {
      const m = r.data as AccountsMonth;
      const conn = c.byId.get(r.connectionId)!;
      // Only an accounting app's own profit is repeated. A bridge or a file gives three totals, and we do not subtract them.
      return { app: conn.app, month: m.month, currency: m.currency, income: m.income, costOfSales: m.costOfSales, expenses: m.expenses, ...(conn.category === "accounting" ? { reportedProfit: m.netProfit } : {}) };
    });
}

function ledgerOf(input: BooksInput, c: Ctx): BooksView["ledger"] {
  const waiting = input.records.filter((r) => r.status === "pending" && (r.kind === "sales" || r.kind === "payroll") && c.byId.has(r.connectionId)).length;
  if (!input.books) return { opened: false, currency: input.baseCurrency, entries: 0, fromApps: 0, lines: [], waiting };
  const inPeriod = input.books.entries.filter((e) => e.date >= c.from && e.date <= c.to);
  const moved = new Map<string, number>();
  for (const e of inPeriod) for (const l of e.lines) moved.set(l.account, (moved.get(l.account) ?? 0) + l.debit - l.credit);
  const lines = input.books.accounts
    .filter((a): a is Account & { type: "income" | "expense" } => a.type === "income" || a.type === "expense")
    .map((a) => ({ code: a.code, name: a.name, type: a.type, amount: a.type === "income" ? -(moved.get(a.code) ?? 0) : (moved.get(a.code) ?? 0) }))
    .filter((l) => l.amount !== 0)
    .sort((a, b) => Number(b.type === "income") - Number(a.type === "income") || a.code.localeCompare(b.code));
  const last = input.books.entries.reduce<string | undefined>((best, e) => (e.date <= c.to && (!best || e.date > best) ? e.date : best), undefined);
  return {
    opened: true, currency: input.baseCurrency, entries: inPeriod.length, fromApps: inPeriod.filter((e) => e.source?.startsWith("app:")).length,
    ...(last ? { lastEntryDate: last } : {}), lines, waiting,
  };
}

export function buildBooks(input: BooksInput): BooksView {
  const live = input.connections.filter((x) => x.status !== "disconnected");
  const c: Ctx = {
    from: addDays(input.today, -(input.days - 1)), to: input.today, base: input.baseCurrency, live,
    order: new Map(live.map((x, i) => [x.id, i])), byId: new Map(live.map((x) => [x.id, x])),
  };
  const check = input.check;
  return {
    period: { from: c.from, to: c.to, days: input.days },
    apps: live.map((x) => ({ id: x.id, app: x.app, category: x.category, brings: [...x.brings], problem: x.status === "error", ...(x.lastSyncAt ? { lastUpdatedAt: x.lastSyncAt } : {}) })),
    sales: salesOf(input.records, c),
    payroll: payrollOf(input.records, c),
    accounts: accountsOf(input.records, c, input.today),
    ledger: ledgerOf(input, c),
    ...(check ? { check: { date: check.date, ranAt: check.ranAt, entriesChecked: check.entries, ok: check.ok, problems: check.findings.filter((f) => f.severity === "error").length, warnings: check.findings.filter((f) => f.severity === "warn").length } } : {}),
  };
}
