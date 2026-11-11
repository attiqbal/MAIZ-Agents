import { newId, type Id } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";

/**
 * Deterministic books. The Finance manager (an AI model) may *propose* entries
 * and *explain* reports, but every number comes from this code, never from a
 * model. Amounts are integers in minor units (cents, pence) so there are no
 * rounding errors.
 */
export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export interface Account {
  code: string;
  name: string;
  type: AccountType;
}

export interface JournalLine {
  account: string;
  /** Exactly one of debit or credit is positive on each line. */
  debit: number;
  credit: number;
}

export interface JournalEntry {
  id: Id<"entry">;
  workspaceId: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  memo: string;
  /** Link to the source document (invoice, receipt, bank line). */
  source?: string;
  lines: readonly JournalLine[];
  /** If set, this entry reverses the referenced one. Entries are never edited. */
  reverses?: string;
}

export interface TrialBalanceRow {
  account: Account;
  debit: number;
  credit: number;
}

/** A small default chart of accounts that suits most startups; owners can add more. */
export const DEFAULT_CHART: readonly Account[] = [
  { code: "1000", name: "Bank", type: "asset" },
  { code: "1100", name: "Accounts receivable", type: "asset" },
  { code: "1500", name: "Equipment", type: "asset" },
  { code: "2000", name: "Accounts payable", type: "liability" },
  { code: "2100", name: "Sales tax payable", type: "liability" },
  { code: "2500", name: "Loans", type: "liability" },
  { code: "3000", name: "Owner's equity", type: "equity" },
  { code: "4000", name: "Sales", type: "income" },
  { code: "4900", name: "Other income", type: "income" },
  { code: "5000", name: "Cost of goods sold", type: "expense" },
  { code: "6000", name: "Rent", type: "expense" },
  { code: "6100", name: "Salaries and contractors", type: "expense" },
  { code: "6200", name: "Software and subscriptions", type: "expense" },
  { code: "6300", name: "Marketing", type: "expense" },
  { code: "6400", name: "Travel and meals", type: "expense" },
  { code: "6900", name: "Other expenses", type: "expense" },
];

/** Largest amount one line may carry, in minor units (ten trillion). Keeps totals exact in JavaScript and inside the database's bigint. */
export const MAX_AMOUNT_MINOR = 1e15;

export class LedgerError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class Ledger {
  private accounts = new Map<string, Map<string, Account>>();
  private entries = new Map<string, JournalEntry[]>();
  private sink?: Sink;

  useSink(sink: Sink): void {
    this.sink = sink;
  }

  /** Put back books read from storage (already validated when first written). */
  restoreAccount(workspaceId: string, a: Account): void {
    if (!this.accounts.has(workspaceId)) {
      this.accounts.set(workspaceId, new Map());
      this.entries.set(workspaceId, []);
    }
    this.accounts.get(workspaceId)!.set(a.code, a);
  }

  restoreEntry(e: JournalEntry): void {
    this.entries.get(e.workspaceId)?.push(Object.freeze(e));
  }

  constructor(
    private identity: IdentityService,
    private audit: AuditLog,
  ) {}

  /** Set up books for a workspace with the default chart. Safe to call once. */
  open(userId: string, workspaceId: string, chart: readonly Account[] = DEFAULT_CHART): void {
    this.identity.require(userId, workspaceId, "workspace.manage");
    if (this.accounts.has(workspaceId)) throw new LedgerError("books already open");
    this.accounts.set(workspaceId, new Map(chart.map((a) => [a.code, { ...a }])));
    this.entries.set(workspaceId, []);
    for (const a of this.accounts.get(workspaceId)!.values()) this.sink?.account(workspaceId, a);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "ledger.opened" });
  }

  addAccount(userId: string, workspaceId: string, account: Account): void {
    this.identity.require(userId, workspaceId, "workspace.manage");
    const accts = this.books(workspaceId);
    if (accts.has(account.code)) throw new LedgerError(`account ${account.code} exists`);
    accts.set(account.code, { ...account });
    this.sink?.account(workspaceId, account);
  }

  chart(userId: string, workspaceId: string): Account[] {
    this.identity.require(userId, workspaceId, "task.read");
    return [...this.books(workspaceId).values()];
  }

  /** Record a balanced entry. Rejects anything that would unbalance the books. */
  post(
    userId: string,
    workspaceId: string,
    input: { date: string; memo: string; source?: string; lines: JournalLine[] },
  ): JournalEntry {
    return this.append(userId, workspaceId, input);
  }

  private append(
    userId: string,
    workspaceId: string,
    input: { date: string; memo: string; source?: string; lines: JournalLine[] },
    reverses?: string,
  ): JournalEntry {
    this.identity.require(userId, workspaceId, "task.create");
    const accts = this.books(workspaceId);
    if (!DATE_RE.test(input.date) || Number.isNaN(Date.parse(input.date))) throw new LedgerError("invalid date");
    if (input.lines.length < 2) throw new LedgerError("an entry needs at least two lines");
    let debit = 0;
    let credit = 0;
    for (const l of input.lines) {
      if (!accts.has(l.account)) throw new LedgerError(`unknown account ${l.account}`);
      if (!Number.isInteger(l.debit) || !Number.isInteger(l.credit) || l.debit < 0 || l.credit < 0)
        throw new LedgerError("amounts must be whole minor units and not negative");
      if (l.debit > MAX_AMOUNT_MINOR || l.credit > MAX_AMOUNT_MINOR) throw new LedgerError("amount is too large");
      if ((l.debit > 0) === (l.credit > 0)) throw new LedgerError("each line is either a debit or a credit");
      debit += l.debit;
      credit += l.credit;
    }
    if (debit !== credit) throw new LedgerError(`entry does not balance: debits ${debit}, credits ${credit}`);
    const entry: JournalEntry = Object.freeze({
      id: newId("entry"),
      workspaceId,
      date: input.date,
      memo: input.memo,
      source: input.source,
      reverses,
      lines: Object.freeze(input.lines.map((l) => Object.freeze({ ...l }))),
    });
    this.entries.get(workspaceId)!.push(entry);
    this.sink?.entry(entry);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "ledger.posted", target: entry.id });
    return entry;
  }

  /** Platform-level (no user check): the raw books of one workspace, for the nightly reconciliation. Undefined if never opened. */
  rawBooks(workspaceId: string): { accounts: Account[]; entries: readonly JournalEntry[] } | undefined {
    const a = this.accounts.get(workspaceId);
    return a ? { accounts: [...a.values()], entries: this.entries.get(workspaceId) ?? [] } : undefined;
  }

  /** Entries are never edited or deleted. A mistake is fixed by reversing it. */
  reverse(userId: string, workspaceId: string, entryId: string, date: string): JournalEntry {
    const original = this.entries.get(workspaceId)?.find((e) => e.id === entryId);
    if (!original) throw new LedgerError("entry not found");
    if (this.entries.get(workspaceId)!.some((e) => e.reverses === entryId)) throw new LedgerError("already reversed");
    return this.append(
      userId,
      workspaceId,
      {
        date,
        memo: `Reversal of: ${original.memo}`,
        source: original.source,
        lines: original.lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit })),
      },
      entryId,
    );
  }

  journal(userId: string, workspaceId: string, range?: { from?: string; to?: string }): JournalEntry[] {
    this.identity.require(userId, workspaceId, "task.read");
    this.books(workspaceId);
    return this.entries.get(workspaceId)!.filter((e) => inRange(e.date, range));
  }

  /** Every account with its total debits and credits up to a date. Total debits always equal total credits. */
  trialBalance(userId: string, workspaceId: string, asOf?: string): { rows: TrialBalanceRow[]; debit: number; credit: number } {
    const sums = this.sum(userId, workspaceId, { to: asOf });
    const rows = [...this.books(workspaceId).values()]
      .map((account) => ({ account, ...(sums.get(account.code) ?? { debit: 0, credit: 0 }) }))
      .filter((r) => r.debit !== 0 || r.credit !== 0);
    return { rows, debit: rows.reduce((s, r) => s + r.debit, 0), credit: rows.reduce((s, r) => s + r.credit, 0) };
  }

  /** Profit and loss for a period: income minus expenses. */
  profitAndLoss(userId: string, workspaceId: string, range: { from?: string; to?: string }) {
    const sums = this.sum(userId, workspaceId, range);
    const lines = (type: AccountType) =>
      [...this.books(workspaceId).values()]
        .filter((a) => a.type === type)
        .map((a) => {
          const s = sums.get(a.code) ?? { debit: 0, credit: 0 };
          return { account: a, amount: type === "income" ? s.credit - s.debit : s.debit - s.credit };
        })
        .filter((l) => l.amount !== 0);
    const income = lines("income");
    const expenses = lines("expense");
    const totalIncome = income.reduce((s, l) => s + l.amount, 0);
    const totalExpenses = expenses.reduce((s, l) => s + l.amount, 0);
    return { income, expenses, totalIncome, totalExpenses, netProfit: totalIncome - totalExpenses };
  }

  /** Balance sheet as of a date. Profit to date is shown inside equity so it always balances. */
  balanceSheet(userId: string, workspaceId: string, asOf?: string) {
    const sums = this.sum(userId, workspaceId, { to: asOf });
    const section = (type: AccountType, sign: 1 | -1) =>
      [...this.books(workspaceId).values()]
        .filter((a) => a.type === type)
        .map((a) => {
          const s = sums.get(a.code) ?? { debit: 0, credit: 0 };
          return { account: a, amount: sign * (s.debit - s.credit) };
        })
        .filter((l) => l.amount !== 0);
    const assets = section("asset", 1);
    const liabilities = section("liability", -1);
    const equity = section("equity", -1);
    const profitToDate = this.profitAndLoss(userId, workspaceId, { to: asOf }).netProfit;
    const total = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);
    return {
      assets,
      liabilities,
      equity,
      profitToDate,
      totalAssets: total(assets),
      totalLiabilities: total(liabilities),
      totalEquity: total(equity) + profitToDate,
    };
  }

  /**
   * How long the cash lasts. Uses the average monthly net cash movement of the
   * bank account over the last `months` full months before `asOf`.
   */
  runway(userId: string, workspaceId: string, asOf: string, months = 3, cashAccount = "1000") {
    if (!Number.isInteger(months) || months < 1) throw new LedgerError("months must be a positive whole number");
    const cash = this.sum(userId, workspaceId, { to: asOf }).get(cashAccount) ?? { debit: 0, credit: 0 };
    const cashNow = cash.debit - cash.credit;
    const start = addMonths(asOf, -months);
    const win = this.sum(userId, workspaceId, { from: start, to: asOf, after: true }).get(cashAccount) ?? { debit: 0, credit: 0 };
    const monthlyNet = Math.round((win.debit - win.credit) / months);
    const monthlyBurn = monthlyNet < 0 ? -monthlyNet : 0;
    return {
      cashNow,
      monthlyNet,
      monthlyBurn,
      /** null means cash is not shrinking, so runway is not limited. */
      runwayMonths: monthlyBurn === 0 ? null : Math.max(0, Math.round((cashNow / monthlyBurn) * 10) / 10),
    };
  }

  private sum(userId: string, workspaceId: string, range?: { from?: string; to?: string; after?: boolean }) {
    this.identity.require(userId, workspaceId, "task.read");
    this.books(workspaceId);
    const out = new Map<string, { debit: number; credit: number }>();
    for (const e of this.entries.get(workspaceId)!) {
      if (!inRange(e.date, range, range?.after)) continue;
      for (const l of e.lines) {
        const cur = out.get(l.account) ?? { debit: 0, credit: 0 };
        cur.debit += l.debit;
        cur.credit += l.credit;
        out.set(l.account, cur);
      }
    }
    return out;
  }

  private books(workspaceId: string): Map<string, Account> {
    const a = this.accounts.get(workspaceId);
    if (!a) throw new LedgerError("books not opened for this workspace");
    return a;
  }
}

/** ISO dates compare correctly as strings. `fromExclusive` makes the start date not count. */
function inRange(date: string, range?: { from?: string; to?: string }, fromExclusive = false): boolean {
  if (range?.from && (fromExclusive ? date <= range.from : date < range.from)) return false;
  if (range?.to && date > range.to) return false;
  return true;
}

function addMonths(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 10);
}
