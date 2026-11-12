/**
 * Pure rules for coupons and affiliates: code formats, what a coupon is worth, the duration of a discount, and the
 * commission arithmetic. No state here, so the rules are easy to test and to reuse when billing goes live.
 */
export class PromoError extends Error {}

export type CouponKind = "percent_off" | "fixed_off" | "free_months" | "trial_days" | "energy_credit";
export const COUPON_KINDS: readonly CouponKind[] = ["percent_off", "fixed_off", "free_months", "trial_days", "energy_credit"];

/** How long a billing discount lasts. Credits and trial days are given once and ignore it. */
export type Duration = { kind: "once" } | { kind: "months"; months: number } | { kind: "forever" };

/** A discount on the monthly bill, ready for the day billing arrives. `months: null` means for ever. */
export interface Discount {
  type: "percent" | "fixed";
  /** Percent (1 to 100) or pounds. */
  value: number;
  months: number | null;
}

export const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
export const AFFILIATE_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{2,23}$/;

export const normaliseCouponCode = (raw: unknown): string => String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
export const normaliseAffiliateCode = (raw: unknown): string => String(raw ?? "").trim().toLowerCase();

const MAX_DISCOUNT_MONTHS = 36;
const MAX_FREE_MONTHS = 12;
const MAX_TRIAL_DAYS = 90;
const MAX_CREDIT_ENERGY = 100_000;
const MAX_FIXED_GBP = 10_000;

/** Checks the value a coupon kind needs and returns it as a clean number. */
export function checkCouponValue(kind: CouponKind, value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new PromoError("enter a value above zero");
  switch (kind) {
    case "percent_off":
      if (n > 100) throw new PromoError("a percentage cannot be more than 100");
      return Math.round(n * 100) / 100;
    case "fixed_off":
      if (n > MAX_FIXED_GBP) throw new PromoError(`a fixed discount cannot be more than £${MAX_FIXED_GBP}`);
      return Math.round(n * 100) / 100;
    case "free_months":
      if (!Number.isInteger(n) || n > MAX_FREE_MONTHS) throw new PromoError(`free months must be a whole number up to ${MAX_FREE_MONTHS}`);
      return n;
    case "trial_days":
      if (!Number.isInteger(n) || n > MAX_TRIAL_DAYS) throw new PromoError(`trial days must be a whole number up to ${MAX_TRIAL_DAYS}`);
      return n;
    case "energy_credit":
      if (!Number.isInteger(n) || n > MAX_CREDIT_ENERGY) throw new PromoError(`energy credit must be a whole number up to ${MAX_CREDIT_ENERGY.toLocaleString("en-GB")}`);
      return n;
  }
}

export function checkDuration(d: unknown): Duration {
  const o = (d ?? { kind: "once" }) as { kind?: unknown; months?: unknown };
  if (o.kind === "once" || o.kind === "forever") return { kind: o.kind };
  if (o.kind === "months") {
    const m = Number(o.months);
    if (!Number.isInteger(m) || m < 1 || m > MAX_DISCOUNT_MONTHS) throw new PromoError(`months must be a whole number from 1 to ${MAX_DISCOUNT_MONTHS}`);
    return { kind: "months", months: m };
  }
  throw new PromoError("choose how long the discount lasts");
}

/** The discount a coupon gives on the monthly bill, or undefined for trial days and energy credit. */
export function discountOf(kind: CouponKind, value: number, duration: Duration): Discount | undefined {
  if (kind === "trial_days" || kind === "energy_credit") return undefined;
  if (kind === "free_months") return { type: "percent", value: 100, months: value };
  const months = duration.kind === "once" ? 1 : duration.kind === "months" ? duration.months : null;
  return { type: kind === "percent_off" ? "percent" : "fixed", value, months };
}

/** What a monthly price becomes in billing month `monthIndex` (0 is the first bill after the code was used). */
export function applyDiscount(d: Discount | undefined, monthlyGbp: number, monthIndex: number): number {
  if (!d || (d.months !== null && monthIndex >= d.months)) return round2(monthlyGbp);
  const off = d.type === "percent" ? (monthlyGbp * d.value) / 100 : d.value;
  return round2(Math.max(0, monthlyGbp - off));
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

const durationWords = (d: Duration): string => (d.kind === "once" ? "on the first bill" : d.kind === "forever" ? "for as long as you stay" : `for ${d.months} month${d.months === 1 ? "" : "s"}`);

/** One plain sentence for what a coupon gives, shown to the client and the owner. */
export function describeCoupon(kind: CouponKind, value: number, duration: Duration): string {
  switch (kind) {
    case "percent_off": return `${value}% off your monthly bill ${durationWords(duration)}`;
    case "fixed_off": return `£${value} off your monthly bill ${durationWords(duration)}`;
    case "free_months": return `${value} free month${value === 1 ? "" : "s"}`;
    case "trial_days": return `${value} more day${value === 1 ? "" : "s"} of free trial`;
    case "energy_credit": return `${value.toLocaleString("en-GB")} free energy`;
  }
}

/**
 * One address per person: lower case, and for Gmail also without dots and "+tags", so an affiliate cannot refer
 * themselves with an alias of their own address.
 */
export function canonicalEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  local = local.split("+")[0]!;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

export interface Commission {
  kind: "percent" | "fixed";
  /** Percent of what the client paid, or pounds per payment. */
  value: number;
  /** How many payments from one referred client earn commission. */
  months: number;
}

export const DEFAULT_COMMISSION: Commission = { kind: "percent", value: 20, months: 12 };
/** Days a commission waits before it can be paid out, to cover refunds. */
export const DEFAULT_HOLD_DAYS = 30;

export function checkCommission(c: unknown): Commission {
  const o = (c ?? DEFAULT_COMMISSION) as Partial<Commission>;
  if (o.kind !== "percent" && o.kind !== "fixed") throw new PromoError("choose percent or fixed pounds for the commission");
  const value = Number(o.value);
  if (!Number.isFinite(value) || value <= 0) throw new PromoError("enter a commission above zero");
  if (o.kind === "percent" && value > 100) throw new PromoError("a commission percentage cannot be more than 100");
  if (o.kind === "fixed" && value > 1_000) throw new PromoError("a fixed commission cannot be more than £1,000 a payment");
  const months = Number(o.months);
  if (!Number.isInteger(months) || months < 1 || months > 60) throw new PromoError("commission months must be a whole number from 1 to 60");
  return { kind: o.kind, value: round2(value), months };
}

export const commissionFor = (c: Commission, paidGbp: number): number => round2(c.kind === "percent" ? (paidGbp * c.value) / 100 : Math.min(c.value, paidGbp));

export const describeCommission = (c: Commission): string =>
  `${c.kind === "percent" ? `${c.value}%` : `£${c.value}`} of each payment for the first ${c.months} month${c.months === 1 ? "" : "s"}`;
