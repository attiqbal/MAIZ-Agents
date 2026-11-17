/**
 * The agent store's catalogue and cart. The Team package itself, and everything a business can add on top
 * of it, with how it is billed:
 *  - "monthly": the Team package, ready-made add-on employees and custom specialists (recurring)
 *  - "once": consultant passes (7 or 30 days with an energy pool, paid once)
 *
 * Pure: no payments happen here. These are the launch defaults; the platform owner changes prices,
 * energy and availability on the Prices page (src/modules/pricing), and the API quotes from that.
 * The website imports this file too, so the cart and the API always agree.
 */
import { EMPLOYEE_TEMPLATES } from "../workforce/templates.js";
import { DEPARTMENTS, LEGACY_SPECIALIST_KEYS } from "../workforce/blueprints.js";
import { CONSULTANTS } from "../workforce/consultants.js";
import { STANDARD_TEAM } from "../onboarding/index.js";
import { SHOP_EMPLOYEE_KEYS } from "../ecommerce/rules.js";

export type Billing = "monthly" | "once";
export type ItemKind = "package" | "employee" | "specialist" | "consultant";

/** The plan every client is on after the free trial: the whole core team and the weekly energy. Bought once, never twice. */
export const TEAM_PACKAGE_KEY = "team-package";
/** Launch price of the Team package; the platform owner changes it on the Prices page ("Basic package, per month"). */
export const TEAM_PACKAGE_MONTHLY_GBP = 150;

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
  package: "Your plan",
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
  /** Group label for the picker, e.g. "Specialist hires". */
  group: string;
  summary: string;
}

/** Draft monthly prices. A ready-made add-on matches the Standard price on the pricing page. */
export const MONTHLY_PRICE_GBP = { employee: 25, specialistStandard: 35, specialistPremium: 35 } as const;
export const MAX_QTY = 10;

/** Online-shop add-on employees a business hires once: a second copy would only repeat the first, so it is never sold twice. */
export const ONE_PER_BUSINESS: ReadonlySet<string> = new Set(SHOP_EMPLOYEE_KEYS);

/** Ready-made employees that come with every package, so they are not sold in the store. */
const IN_PACKAGE: ReadonlySet<string> = new Set(STANDARD_TEAM);

export const CATALOGUE: readonly CatalogueItem[] = [
  {
    key: TEAM_PACKAGE_KEY, title: "Team package", kind: "package", billing: "monthly", priceGbp: TEAM_PACKAGE_MONTHLY_GBP, group: "Your plan",
    summary: "Your whole team after the free trial: Finance, Marketing, Business consultant, HR, Compliance and the Admin manager, sharing one weekly energy allowance that refills every Monday.",
  },
  ...EMPLOYEE_TEMPLATES.filter((t) => !IN_PACKAGE.has(t.key)).map((t) => ({
    key: t.key, title: t.title, kind: "employee" as const, billing: "monthly" as const,
    priceGbp: MONTHLY_PRICE_GBP.employee, group: "Ready-made employees", summary: t.summary,
  })),
  ...DEPARTMENTS.flatMap((d) =>
    d.roles.filter((r) => !r.jd).map((r) => ({
      key: r.key, title: r.title, kind: "specialist" as const, billing: "monthly" as const,
      priceGbp: r.tier === "premium" ? MONTHLY_PRICE_GBP.specialistPremium : MONTHLY_PRICE_GBP.specialistStandard,
      tier: r.tier === "premium" ? ("premium" as const) : ("standard" as const),
      group: "Specialist hires", summary: r.purpose,
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

/** Looks up a catalogue item. Old one-job specialist keys (saved carts, links) resolve to their specialist hire. */
export function getItem(key: string): CatalogueItem | undefined {
  const resolved = LEGACY_SPECIALIST_KEYS[key] ?? key;
  return CATALOGUE.find((i) => i.key === resolved);
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
    // One business has one Team package, however many times it was added.
    qty.set(key, key === TEAM_PACKAGE_KEY || ONE_PER_BUSINESS.has(key) ? 1 : Math.min(MAX_QTY, (qty.get(key) ?? 0) + n));
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

/**
 * Makes a cart fit where the client is with their plan, then prices it:
 *  - still on the free trial: a first monthly order starts the paid plan, so the Team package is added to it
 *    (a consultant pass alone needs no plan);
 *  - already on the Team package: it cannot be bought a second time.
 */
export function quoteForPlan(lines: readonly unknown[], hasTeamPackage: boolean, catalogue: readonly CatalogueItem[] = CATALOGUE, owned: readonly string[] = []): Quote {
  // An online-shop employee the client already has is left out of the cart, and the client is told why.
  const keyOf = (raw: unknown): string => (typeof (raw as { key?: unknown } | null)?.key === "string" ? (raw as { key: string }).key : "");
  const hasAlready = (raw: unknown): boolean => ONE_PER_BUSINESS.has(keyOf(raw)) && owned.includes(keyOf(raw));
  const q = quoteForTeam(lines.filter((l) => !hasAlready(l)), hasTeamPackage, catalogue);
  const dupes = [...new Set(lines.filter(hasAlready).map(keyOf))].map((key) => ({ key, reason: "you already have this employee" }));
  return dupes.length ? { ...q, rejected: [...q.rejected, ...dupes] } : q;
}

function quoteForTeam(lines: readonly unknown[], hasTeamPackage: boolean, catalogue: readonly CatalogueItem[]): Quote {
  const plain = quote(lines, catalogue);
  const asked = plain.lines.some((l) => l.key === TEAM_PACKAGE_KEY);
  if (hasTeamPackage) {
    if (!asked) return plain;
    const rest = quote(plain.lines.filter((l) => l.key !== TEAM_PACKAGE_KEY), catalogue);
    return { ...rest, rejected: [...plain.rejected, { key: TEAM_PACKAGE_KEY, reason: "you already have the Team package" }] };
  }
  if (asked || plain.monthlyGbp === 0 || !catalogue.some((i) => i.key === TEAM_PACKAGE_KEY)) return plain;
  const withPlan = quote([{ key: TEAM_PACKAGE_KEY, qty: 1 }, ...plain.lines], catalogue);
  return { ...withPlan, rejected: plain.rejected };
}
