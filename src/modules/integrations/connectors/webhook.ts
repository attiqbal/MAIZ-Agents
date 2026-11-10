import { toIsoDate } from "../csv.js";
import type { AccountsMonth, Connector, ParsedFile, PayrollRun, SalesDay } from "../types.js";

/**
 * The quick path for any app we have not built yet: Zapier, Make, n8n or the app's own
 * webhooks POST JSON to a private URL. Thousands of apps already have a Zapier or Make trigger.
 *
 * Body: { "sales": [SalesDay...] }, { "payroll": [PayrollRun...] } or { "accounts": [AccountsMonth...] }, amounts in minor units
 * (pence, cents), or with "amountsIn": "major" to send 12.50 instead of 1250.
 */
const MAX_ITEMS = 1000;

export function parseWebhookBody(body: unknown, currency: string): ParsedFile {
  const warnings: string[] = [];
  if (!body || typeof body !== "object") return { warnings: ["The body must be a JSON object."], unmapped: [] };
  const b = body as Record<string, unknown>;
  const scale = b.amountsIn === "major" ? 100 : 1;
  const amount = (v: unknown): number => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
    return Number.isFinite(n) ? Math.round(n * scale) : 0;
  };
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.slice(0, MAX_ITEMS).filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
  const cur = (v: unknown) => (typeof v === "string" && /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : currency);

  const sales: SalesDay[] = [];
  for (const s of list(b.sales)) {
    const date = toIsoDate(String(s.date ?? ""));
    if (!date) { warnings.push("A sales item without a valid date was skipped."); continue; }
    sales.push({ date, currency: cur(s.currency), gross: amount(s.gross), tax: amount(s.tax), tips: amount(s.tips), fees: Math.abs(amount(s.fees)), refunds: Math.abs(amount(s.refunds)), transactions: Math.max(0, Math.trunc(Number(s.transactions) || 0)) });
  }
  const payroll: PayrollRun[] = [];
  for (const p of list(b.payroll)) {
    const payDate = toIsoDate(String(p.payDate ?? ""));
    if (!payDate) { warnings.push("A payroll item without a valid payDate was skipped."); continue; }
    payroll.push({
      payDate, currency: cur(p.currency), gross: amount(p.gross), incomeTax: amount(p.incomeTax), employeeInsurance: amount(p.employeeInsurance), employerInsurance: amount(p.employerInsurance),
      employeePension: amount(p.employeePension), employerPension: amount(p.employerPension), otherDeductions: amount(p.otherDeductions), net: amount(p.net), headcount: Math.max(0, Math.trunc(Number(p.headcount) || 0)),
    });
  }
  const accounts: AccountsMonth[] = [];
  for (const a of list(b.accounts)) {
    const month = typeof a.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(a.month) ? a.month : undefined;
    if (!month) { warnings.push("An accounts item without a month (YYYY-MM) was skipped."); continue; }
    const income = amount(a.income), costOfSales = amount(a.costOfSales), expenses = amount(a.expenses);
    accounts.push({ month, currency: cur(a.currency), income, costOfSales, expenses, netProfit: a.netProfit === undefined ? income - costOfSales - expenses : amount(a.netProfit) });
  }
  if (!sales.length && !payroll.length && !accounts.length) warnings.push('Nothing to import: send "sales", "payroll" or "accounts" items.');
  return { sales, payroll, accounts, warnings, unmapped: [] };
}

export const webhookBridge: Connector = {
  key: "webhook",
  name: "Zapier, Make or any app (webhook)",
  category: "bridge",
  summary: "Send data from any app through Zapier, Make or n8n to a private link.",
  availability: "live",
  capabilities: ["sales.read", "payroll.read", "accounts.read"],
  note: "Good for apps we don't connect directly yet. The link is secret: anyone with it can send data, so keep it private and replace it if it leaks.",
  auth: { kind: "webhook" },
};
