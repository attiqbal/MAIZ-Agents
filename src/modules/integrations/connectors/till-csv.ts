import { mapColumns, parseCsv, toIsoDate, toMinor } from "../csv.js";
import type { Connector, FileOptions, ParsedFile, SalesDay } from "../types.js";

/** Headings tills use in their sales exports. Add more here when a customer's file is not recognised. */
const SALES_COLUMNS = {
  date: ["Date", "Transaction Date", "Sale Date", "Created", "Created At", "Timestamp", "Date/Time", "Time"],
  gross: ["Gross", "Gross Sales", "Total", "Total Amount", "Amount", "Sale Amount", "Total (inc. VAT)", "Total Inc Tax", "Total Collected", "Takings"],
  tax: ["Tax", "VAT", "Sales Tax", "Tax Amount", "VAT Amount", "Total Tax"],
  tips: ["Tip", "Tips", "Gratuity", "Service Charge"],
  fees: ["Fee", "Fees", "Processing Fee", "Processing Fees", "Card Fee", "Transaction Fee", "Commission"],
  refunds: ["Refund", "Refunds", "Refunded", "Refund Amount", "Returns"],
  currency: ["Currency", "Currency Code"],
  count: ["Transactions", "Transaction Count", "Count", "No. of Transactions", "Sales Count"],
} as const;

/**
 * Reads any till's sales export: one row per sale or one row per day. Rows are added up per day.
 * A negative amount counts as a refund. Totals rows ("Total", "Grand total") are skipped.
 */
export function parseTillCsv(text: string, opts: FileOptions): ParsedFile {
  const rows = parseCsv(text);
  const warnings: string[] = [];
  if (rows.length < 2) return { sales: [], warnings: ["The file is empty or has only a heading row."], unmapped: [] };
  const [header, ...body] = rows as [string[], ...string[][]];
  const { cols, unmapped } = mapColumns(header, SALES_COLUMNS);
  if (cols.gross === undefined) return { sales: [], warnings: ["We could not find the column with the sale amount. Tell us which column it is."], unmapped };
  if (cols.date === undefined && !opts.date) return { sales: [], warnings: ["We could not find a date column. Tell us which column it is, or the date these sales are for."], unmapped };
  if (cols.tax === undefined) warnings.push("No VAT or sales tax column, so tax is recorded as 0. Check this before you file a return.");

  const days = new Map<string, SalesDay>();
  let skipped = 0;
  body.forEach((r) => {
    if (/^\s*(grand\s*)?total/i.test(r[0] ?? "")) return;
    const date = cols.date !== undefined ? toIsoDate(r[cols.date]) : opts.date;
    const gross = toMinor(r[cols.gross!]);
    if (!date || gross === undefined) { skipped++; return; }
    const cell = (c: number | undefined) => (c === undefined ? 0 : toMinor(r[c]) ?? 0);
    const currency = (cols.currency !== undefined && r[cols.currency]?.trim().toUpperCase()) || opts.currency;
    const day = days.get(date) ?? { date, currency, gross: 0, tax: 0, tips: 0, fees: 0, refunds: 0, transactions: 0 };
    if (day.currency !== currency) { skipped++; warnings.push(`Row with ${currency} on ${date} skipped: one day can only have one currency.`); return; }
    if (gross < 0) day.refunds += -gross;
    else { day.gross += gross; day.tax += cell(cols.tax); }
    day.tips += cell(cols.tips);
    day.fees += Math.abs(cell(cols.fees));
    day.refunds += Math.abs(cell(cols.refunds));
    day.transactions += cols.count !== undefined ? Math.max(0, Number(r[cols.count]) || 0) : 1;
    days.set(date, day);
  });
  if (skipped) warnings.push(`${skipped} row(s) had no readable date or amount and were left out.`);
  return { sales: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), warnings, unmapped };
}

/** Upload a sales export from any till. Works today for every till, whether or not it has an API. */
export const tillFile: Connector = {
  key: "till-file",
  name: "Any till (file upload)",
  category: "till",
  summary: "Upload your till's sales export (CSV). Works with any till system.",
  availability: "file",
  capabilities: ["sales.read"],
  auth: {
    kind: "file",
    accepts: ".csv",
    howToExport: [
      "In your till's back office, open Reports, then Sales or Transactions.",
      "Pick the dates you want and choose Export, then CSV.",
      "Upload the file here. We show you the totals before anything goes into your books.",
    ],
  },
  parseFile: parseTillCsv,
};
