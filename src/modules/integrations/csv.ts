/** Small, strict CSV reader for exported files. Handles quotes, commas and newlines inside quotes, BOM and CRLF. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** Lower-case letters and digits only, so "Gross Pay (£)" and "gross_pay" compare equal. */
export const normaliseHeader = (h: string): string => h.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "");

/**
 * Finds which column holds each field. `aliases` lists the headings apps use for that field.
 * Returns the column index per field and the headings nobody claimed.
 */
export function mapColumns<F extends string>(header: readonly string[], aliases: Record<F, readonly string[]>): { cols: Partial<Record<F, number>>; unmapped: string[] } {
  const cols: Partial<Record<F, number>> = {};
  const claimed = new Set<number>();
  for (const field of Object.keys(aliases) as F[]) {
    const wanted = aliases[field].map(normaliseHeader);
    const idx = header.findIndex((h, i) => !claimed.has(i) && wanted.includes(normaliseHeader(h)));
    if (idx >= 0) { cols[field] = idx; claimed.add(idx); }
  }
  const unmapped = header.filter((h, i) => !claimed.has(i) && h.trim() !== "");
  return { cols, unmapped };
}

/**
 * "£1,234.50", "1234.5", "(12.00)" and "-12" to minor units. Returns undefined for text that is not money.
 * Negative in brackets is how many exports show refunds.
 */
export function toMinor(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  let s = raw.trim();
  if (s === "" || s === "-") return 0;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[£$€\s,]|GBP|EUR|USD/gi, "");
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1); }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const [whole, frac = ""] = s.split(".");
  const n = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return negative ? -n : n;
}

/** Accepts YYYY-MM-DD, DD/MM/YYYY (UK/IE exports) and YYYY-MM-DDTHH:MM. Returns YYYY-MM-DD or undefined. */
export function toIsoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return valid(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (m) return valid(+m[3]!, +m[2]!, +m[1]!);
  return undefined;
}

function valid(y: number, mo: number, d: number): string | undefined {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return dt.toISOString().slice(0, 10);
}
