// Calendar dates for staff records: plain "YYYY-MM-DD" strings, compared in UTC so a record
// reads the same in every time zone.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  return Math.round((ms(b) - ms(a)) / DAY_MS);
}

export function addDays(iso: string, days: number): string {
  return toIsoDate(new Date(ms(iso) + days * DAY_MS));
}

/** Adds calendar months, clamping to the month's last day (31 Jan + 1 month = 28 or 29 Feb). */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return toIsoDate(new Date(Date.UTC(ny, nm, Math.min(d, last))));
}

/** Age in whole years on `on`. */
export function ageOn(dateOfBirth: string, on: string): number {
  const [by, bm, bd] = dateOfBirth.split("-").map(Number) as [number, number, number];
  const [y, m, d] = on.split("-").map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** The leave year that contains `today`, starting on the 1st of `startMonth` (1 = January). */
export function leaveYear(today: string, startMonth: number): { start: string; end: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const startYear = m >= startMonth ? y : y - 1;
  const start = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
  return { start, end: addDays(addMonths(start, 12), -1) };
}
