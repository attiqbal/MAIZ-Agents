/**
 * The agent store's catalogue and cart. Everything a business can add on top
 * of its package, with how it is billed:
 *  - "monthly": ready-made add-on employees and custom specialists (recurring)
 *  - "once": consultant passes (7 or 30 days with an energy pool, paid once)
 *
 * Pure: no payments happen here. These are the launch defaults; the platform owner changes prices,
 * energy and availability on the Prices page (src/modules/pricing), and the API quotes from that.
 * The website imports this file too, so the cart and the API always agree.
 */
import { EMPLOYEE_TEMPLATES } from "../workforce/templates.js";
import { DEPARTMENTS } from "../workforce/blueprints.js";
import { CONSULTANTS } from "../workforce/consultants.js";
import { STANDARD_TEAM } from "../onboarding/index.js";

export type Billing = "monthly" | "once";
export type ItemKind = "employee" | "specialist" | "consultant";

/**
 * How each kind of item is paid for, in the words shown next to the price and in the cart.
 * Core roles (the basic package and the free Admin manager) are included and never sold here.
 */
export const BILLING_INFO: Record<Billing, { label: string; short: string; note: string }> = {
  monthly: {
    label: "Recurring · monthly",
    short: "a month",
    note: "Charged every month until you cancel. Cancel in one click; you keep access to the end of the month you paid for.",
  },
  once: {
    label: "One-off · task based",
    short: "once",
    note: "Paid once for a time-boxed pass. No subscription. The consultant joins your team for the pass, then leaves; you can add another pass any time.",
  },
};

export const KIND_LABEL: Record<ItemKind, string> = {
  employee: "Ready-made employee",
  specialist: "Custom specialist",
  consultant: "Consultant pass",
};

export interface CatalogueItem {
  key: string;
  title: string;
  kind: ItemKind;
  billing: Billing;
  priceGbp: number;
  /** Pass length in days (consultants only). */
  days?: number;
  /** Energy included (consultants only). */
  energy?: number;
  /** Custom specialists only: which monthly price band applies. */
  tier?: "standard" | "premium";
  /** Group label for the picker, e.g. "Finance and accounting". */
  group: string;
  summary: string;
}

/** Draft monthly prices. A ready-made add-on matches the Standard price on the pricing page. */
export const MONTHLY_PRICE_GBP = { employee: 20, specialistStandard: 30, specialistPremium: 30 } as const;
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
      tier: r.tier === "premium" ? ("premium" as const) : ("standard" as const),
      group: `Specialists · ${d.name}`, summary: r.purpose,
    })),
  ),
  ...CONSULTANTS.flatMap((c) =>
    c.passes.map((p) => ({
      key: `${c.key}:${p.key}`, title: `${c.title} · ${p.label}`, kind: "consultant" as const, billing: "once" as const,
      priceGbp: p.gbp, days: p.days, energy: p.energy, group: "One-off · consultants", summary: c.purpose,
    })),
  ),
];

/** True for roles that come with every package: they cannot be added to a cart. */
export function isCoreRole(key: string): boolean {
  return IN_PACKAGE.has(key) || key === "admin-manager";
}

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
export function quote(lines: readonly unknown[], catalogue: readonly CatalogueItem[] = CATALOGUE): Quote {
  const getItem = (key: string) => catalogue.find((i) => i.key === key);
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
