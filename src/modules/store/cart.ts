/**
 * The agent store's catalogue and cart. Everything a business can add on top
 * of its package, with how it is billed:
 *  - "monthly": ready-made add-on employees and custom specialists (recurring)
 *  - "once": task-based hires (fixed price per task, energy included)
 *
 * Pure: no payments happen here. Prices are draft list prices in GBP for the
 * owner of MAIZ agents to confirm; tasks take their price from task-roles.ts.
 * The website imports this file too, so the cart and the API always agree.
 */
import { EMPLOYEE_TEMPLATES } from "../workforce/templates.js";
import { DEPARTMENTS } from "../workforce/blueprints.js";
import { TASK_ROLES } from "../workforce/task-roles.js";
import { STANDARD_TEAM } from "../onboarding/index.js";

export type Billing = "monthly" | "once";
export type ItemKind = "employee" | "specialist" | "task";

export interface CatalogueItem {
  key: string;
  title: string;
  kind: ItemKind;
  billing: Billing;
  priceGbp: number;
  /** Group label for the picker, e.g. "Finance and accounting". */
  group: string;
  summary: string;
}

/** Draft monthly prices. A ready-made add-on matches the Standard price on the pricing page. */
export const MONTHLY_PRICE_GBP = { employee: 12, specialistStandard: 19, specialistPremium: 29 } as const;
export const MAX_QTY = 10;

/** Ready-made employees that come with every package, so they are not sold in the store. */
const IN_PACKAGE: ReadonlySet<string> = new Set(STANDARD_TEAM);

export const CATALOGUE: readonly CatalogueItem[] = [
  ...EMPLOYEE_TEMPLATES.filter((t) => !IN_PACKAGE.has(t.key)).map((t) => ({
    key: t.key, title: t.title, kind: "employee" as const, billing: "monthly" as const,
    priceGbp: MONTHLY_PRICE_GBP.employee, group: "Ready-made employees", summary: t.summary,
  })),
  ...DEPARTMENTS.flatMap((d) =>
    d.roles.filter((r) => !r.jd).map((r) => ({
      key: r.key, title: r.title, kind: "specialist" as const, billing: "monthly" as const,
      priceGbp: r.tier === "premium" ? MONTHLY_PRICE_GBP.specialistPremium : MONTHLY_PRICE_GBP.specialistStandard,
      group: `Specialists · ${d.name}`, summary: r.purpose,
    })),
  ),
  ...TASK_ROLES.map((r) => ({
    key: r.key, title: r.title, kind: "task" as const, billing: "once" as const,
    priceGbp: r.fixedGbp, group: `One-off tasks · ${r.category}`, summary: r.purpose,
  })),
];

export function getItem(key: string): CatalogueItem | undefined {
  return CATALOGUE.find((i) => i.key === key);
}

export interface CartLine {
  key: string;
  qty: number;
}

export interface PricedLine extends CartLine {
  title: string;
  billing: Billing;
  unitGbp: number;
  totalGbp: number;
}

export interface Quote {
  lines: PricedLine[];
  /** Recurring total per month. */
  monthlyGbp: number;
  /** One-off total for tasks. */
  onceGbp: number;
  /** First payment: one-off tasks plus the first month. */
  dueTodayGbp: number;
  /** Lines that were dropped and why (unknown item, bad quantity). */
  rejected: { key: string; reason: string }[];
}

/** Prices a cart. Same key twice is merged; quantities are whole numbers from 1 to MAX_QTY. */
export function quote(lines: readonly unknown[]): Quote {
  const qty = new Map<string, number>();
  const rejected: Quote["rejected"] = [];
  for (const raw of lines) {
    const l = raw as Partial<CartLine> | null;
    const key = typeof l?.key === "string" ? l.key : "";
    const n = l?.qty ?? 1;
    if (!getItem(key)) { rejected.push({ key, reason: "not in the store" }); continue; }
    if (!Number.isInteger(n) || n < 1) { rejected.push({ key, reason: "quantity must be a whole number of 1 or more" }); continue; }
    qty.set(key, Math.min(MAX_QTY, (qty.get(key) ?? 0) + n));
  }
  const priced: PricedLine[] = [...qty].map(([key, n]) => {
    const item = getItem(key)!;
    return { key, qty: n, title: item.title, billing: item.billing, unitGbp: item.priceGbp, totalGbp: item.priceGbp * n };
  });
  const sum = (b: Billing) => priced.filter((p) => p.billing === b).reduce((a, p) => a + p.totalGbp, 0);
  const monthlyGbp = sum("monthly");
  const onceGbp = sum("once");
  return { lines: priced, monthlyGbp, onceGbp, dueTodayGbp: monthlyGbp + onceGbp, rejected };
}
