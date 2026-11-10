import type { Account, JournalLine } from "../ledger/index.js";
import type { PayrollRun, SalesDay } from "./types.js";

/** Accounts app data needs beyond the default chart. Added the first time records are posted. */
export const PAYROLL_ACCOUNTS: readonly Account[] = [
  { code: "2200", name: "Payroll taxes owed", type: "liability" },
  { code: "2210", name: "Pensions owed", type: "liability" },
  { code: "2220", name: "Other payroll deductions owed", type: "liability" },
  { code: "2300", name: "Tips owed to staff", type: "liability" },
  { code: "6500", name: "Card and payment fees", type: "expense" },
];

/** Signed amount to a ledger line: positive is a debit, negative a credit. Zero lines are dropped. */
function lines(parts: [account: string, signed: number][]): JournalLine[] {
  return parts.filter(([, n]) => n !== 0).map(([account, n]) => (n > 0 ? { account, debit: n, credit: 0 } : { account, debit: 0, credit: -n }));
}

/**
 * One day of till sales. The money is treated as landing in the bank that day, net of fees;
 * tips are owed to staff; refunds reduce sales.
 */
export function toSalesEntry(d: SalesDay, label: string): { date: string; memo: string; lines: JournalLine[] } | undefined {
  if (!d.gross && !d.refunds && !d.tips) return undefined;
  const bank = d.gross + d.tips - d.fees - d.refunds;
  return {
    date: d.date,
    memo: `${label}: ${d.transactions} transactions`,
    lines: lines([
      ["1000", bank],
      ["6500", d.fees],
      ["4000", d.refunds - (d.gross - d.tax)],
      ["2100", -d.tax],
      ["2300", -d.tips],
    ]),
  };
}

/** One pay run: staff cost is gross pay plus employer contributions; what was withheld is owed until paid over. */
export function toPayrollEntry(p: PayrollRun, label: string): { date: string; memo: string; lines: JournalLine[] } | undefined {
  if (!p.gross) return undefined;
  return {
    date: p.payDate,
    memo: `${label}: ${p.headcount} staff`,
    lines: lines([
      ["6100", p.gross + p.employerInsurance + p.employerPension],
      ["1000", -p.net],
      ["2200", -(p.incomeTax + p.employeeInsurance + p.employerInsurance)],
      ["2210", -(p.employeePension + p.employerPension)],
      ["2220", -p.otherDeductions],
    ]),
  };
}
