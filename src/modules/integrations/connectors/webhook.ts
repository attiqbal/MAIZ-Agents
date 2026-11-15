import { toIsoDate } from "../csv.js";
import { AREAS, cleanFigures, isArea } from "../areas.js";
import type { AccountsMonth, ActivityDay, Connector, ParsedFile, PayrollRun, SalesDay } from "../types.js";

/**
 * The quick path for any app we have not built yet: Zapier, Make, n8n or the app's own
 * webhooks POST JSON to a private URL. Thousands of apps already have a Zapier or Make trigger.
 *
 * Body: { "sales": [SalesDay...] }, { "payroll": [PayrollRun...] } or { "accounts": [AccountsMonth...] }, amounts in minor units
 * (pence, cents), or with "amountsIn": "major" to send 12.50 instead of 1250.
 * Customer activity from any app (a new lead, a ticket, a booking): { "activity": [{ "date", "area": "crm"|"support"|"inbox"|"bookings"|"audience"|"tasks"|"reviews", "figures": { ... } }] }
 * with the figure names listed in areas.ts. Unknown areas and figures are ignored; only numbers are kept.
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
  const activity: ActivityDay[] = [];
  for (const a of list(b.activity)) {
    const date = toIsoDate(String(a.date ?? ""));
    if (!date) { warnings.push("An activity item without a valid date was skipped."); continue; }
    if (!isArea(a.area)) { warnings.push("An activity item with an unknown area was skipped."); continue; }
    const figures = cleanFigures(a.area, scale === 100 ? moneyAsMinor(a.area, a.figures) : a.figures);
    if (!Object.keys(figures).length) { warnings.push(`An activity item for ${a.area} on ${date} had no figures we know.`); continue; }
    activity.push({ date, area: a.area, currency: cur(a.currency), figures });
  }
  if (!sales.length && !payroll.length && !accounts.length && !activity.length) warnings.push('Nothing to import: send "sales", "payroll", "accounts" or "activity" items.');
  return { sales, payroll, accounts, activity, warnings, unmapped: [] };
}

/** With "amountsIn": "major", money figures arrive as 12.50; turn them into minor units like everything else. */
function moneyAsMinor(area: ActivityDay["area"], figures: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(figures && typeof figures === "object" ? (figures as Record<string, unknown>) : {}) };
  for (const f of AREAS[area].figures) if (f.kind === "money" && out[f.key] !== undefined) out[f.key] = Math.round(Number(out[f.key]) * 100);
  return out;
}

export const webhookBridge: Connector = {
  key: "webhook",
  name: "Zapier, Make or any app (webhook)",
  category: "bridge",
  summary: "Send data from any app through Zapier, Make or n8n to a private link.",
  availability: "live",
  capabilities: ["sales.read", "payroll.read", "accounts.read", "crm.read", "support.read", "inbox.read", "bookings.read", "audience.read", "tasks.read", "reviews.read"],
  note: "Good for apps we don't connect directly yet. The link is secret: anyone with it can send data, so keep it private and replace it if it leaks.",
  auth: { kind: "webhook" },
};
