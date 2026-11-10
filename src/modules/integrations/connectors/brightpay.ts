import { mapColumns, parseCsv, toIsoDate, toMinor } from "../csv.js";
import type { Connector, FileOptions, ParsedFile, PayrollRun } from "../types.js";

/**
 * BrightPay (UK and Ireland payroll).
 *
 * What BrightPay offers today (checked 2026-11, devdocs.brightpay.com):
 * - BrightPay Cloud has an OAuth 2.0 Payroll API, but it is UK only, still in development and open
 *   only to timesheet providers who apply by email. Its methods read employers, employees and hourly
 *   rates and push hourly payments in. There is no method to read payslips or payroll totals.
 * - BrightPay exports reports (payroll summary, payslip details) to CSV/Excel, and posts payroll
 *   journals straight into Xero, QuickBooks Online, Sage and others.
 *
 * So we read the exported payroll summary today. When the owner already uses Xero or QuickBooks,
 * the accounting connector picks up BrightPay's journal too. The API path is kept for later.
 */
const PAYROLL_COLUMNS = {
  payDate: ["Pay Date", "Payment Date", "Paid On", "Date"],
  employee: ["Employee", "Employee Name", "Name", "Surname"],
  gross: ["Gross Pay", "Total Gross Pay", "Gross", "Total Gross", "Gross Pay This Period"],
  incomeTax: ["PAYE", "PAYE Tax", "Tax", "Income Tax", "Tax Deducted"],
  employeeNi: ["Employee NI", "EE NI", "Employee NIC", "Employees NI", "NI Employee", "Employee PRSI", "EE PRSI", "PRSI EE"],
  usc: ["USC", "Universal Social Charge"],
  employerNi: ["Employer NI", "ER NI", "Employer NIC", "Employers NI", "NI Employer", "Employer PRSI", "ER PRSI", "PRSI ER"],
  employeePension: ["Employee Pension", "EE Pension", "Pension EE", "Employee Pension Contribution"],
  employerPension: ["Employer Pension", "ER Pension", "Pension ER", "Employer Pension Contribution"],
  studentLoan: ["Student Loan", "Student Loan Deduction", "Postgraduate Loan"],
  net: ["Net Pay", "Net", "Take Home Pay", "Net Pay This Period"],
} as const;

export function parseBrightPayCsv(text: string, opts: FileOptions): ParsedFile {
  const rows = parseCsv(text);
  if (rows.length < 2) return { payroll: [], warnings: ["The file is empty or has only a heading row."], unmapped: [] };
  const [header, ...body] = rows as [string[], ...string[][]];
  const { cols, unmapped } = mapColumns(header, PAYROLL_COLUMNS);
  const warnings: string[] = [];
  if (cols.gross === undefined || cols.net === undefined) {
    return { payroll: [], warnings: ["We need at least the Gross Pay and Net Pay columns. In BrightPay, export the payroll summary report for the pay period."], unmapped };
  }
  if (cols.payDate === undefined && !opts.date) return { payroll: [], warnings: ["The file has no pay date. Tell us the date staff were paid."], unmapped };

  const runs = new Map<string, PayrollRun>();
  for (const r of body) {
    const first = (cols.employee !== undefined ? r[cols.employee] : r[0]) ?? "";
    if (/^\s*(grand\s*)?totals?\b/i.test(first) || /^\s*(grand\s*)?totals?\b/i.test(r[0] ?? "")) continue;
    const payDate = cols.payDate !== undefined ? toIsoDate(r[cols.payDate]) : opts.date;
    const gross = toMinor(r[cols.gross]);
    const net = toMinor(r[cols.net]);
    if (!payDate || gross === undefined || net === undefined) continue;
    const v = (c: number | undefined) => (c === undefined ? 0 : Math.abs(toMinor(r[c]) ?? 0));
    const run = runs.get(payDate) ?? { payDate, currency: opts.currency, gross: 0, incomeTax: 0, employeeInsurance: 0, employerInsurance: 0, employeePension: 0, employerPension: 0, otherDeductions: 0, net: 0, headcount: 0 };
    run.gross += gross;
    run.net += net;
    run.incomeTax += v(cols.incomeTax);
    run.employeeInsurance += v(cols.employeeNi) + v(cols.usc);
    run.employerInsurance += v(cols.employerNi);
    run.employeePension += v(cols.employeePension);
    run.employerPension += v(cols.employerPension);
    run.otherDeductions += v(cols.studentLoan);
    run.headcount += 1;
    runs.set(payDate, run);
  }
  for (const run of runs.values()) {
    const known = run.incomeTax + run.employeeInsurance + run.employeePension + run.otherDeductions;
    const gap = run.gross - known - run.net;
    if (gap !== 0) {
      // Something taken from pay that we have no column for (attachments, benefits). Kept so the books balance, and flagged.
      run.otherDeductions += gap;
      warnings.push(`Pay run ${run.payDate}: ${(gap / 100).toFixed(2)} between gross and net pay is not in any column we know. It is recorded as "other deductions"; please check.`);
    }
  }
  if (cols.employerNi === undefined) warnings.push("No employer NI/PRSI column, so employer costs may be understated.");
  return { payroll: [...runs.values()].sort((a, b) => a.payDate.localeCompare(b.payDate)), warnings, unmapped };
}

export const brightpay: Connector = {
  key: "brightpay",
  name: "BrightPay",
  category: "payroll",
  summary: "Payroll for the UK and Ireland. Upload the payroll summary after each pay run.",
  availability: "file",
  capabilities: ["payroll.read"],
  regions: ["GB", "IE"],
  note: "BrightPay has no public API for payroll totals yet (its API is for timesheet partners only). File upload takes about a minute per pay run. If you post BrightPay journals to Xero or QuickBooks, connecting those will pick it up automatically.",
  auth: {
    kind: "file",
    accepts: ".csv",
    howToExport: [
      "In BrightPay, open the employer and go to Reports.",
      "Choose the payroll summary for the pay period (pick the columns Gross Pay, PAYE, Employee and Employer NI or PRSI, pensions and Net Pay).",
      "Export it as CSV and upload it here.",
    ],
  },
  parseFile: parseBrightPayCsv,
};
