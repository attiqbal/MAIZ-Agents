import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import { PermissionError } from "../identity/index.js";
import {
  CODE_PATTERN, COUPON_KINDS, PromoError, checkCouponValue, checkDuration, describeCoupon, discountOf, normaliseCouponCode,
  type CouponKind, type Discount, type Duration,
} from "./rules.js";

export interface Coupon {
  id: string;
  code: string;
  kind: CouponKind;
  value: number;
  duration: Duration;
  /** Most times it can be used in total. Left out means no limit. */
  maxRedemptions?: number;
  /** After this moment (ISO time) it no longer works. */
  expiresAt?: string;
  /** Only for clients on the free trial, or only for paying clients. */
  plan?: "trial" | "paid";
  /** Only for this sign-in email. */
  email?: string;
  enabled: boolean;
  note?: string;
  createdAt: string;
  createdBy: string;
}

export interface Redemption {
  id: string;
  couponId: string;
  code: string;
  workspaceId: string;
  email: string;
  at: string;
  /** What was given, in words. */
  applied: string;
  /** Set for discounts on the bill: applied once billing is live. */
  discount?: Discount;
}

/** What a coupon does to a client's account. Supplied by the platform so this module knows nothing of energy. */
export interface CouponEffects {
  isTrial(workspaceId: string): boolean;
  extendTrial(workspaceId: string, days: number, by: string): void;
  grantEnergy(workspaceId: string, energy: number, by: string): void;
}

export interface CouponContext {
  email?: string;
  workspaceId?: string;
}

export interface CouponCheck { code: string; summary: string }

const NOTE_MAX = 300;
const MAX_REDEMPTIONS_LIMIT = 1_000_000;

export class CouponService {
  private coupons = new Map<string, Coupon>();
  private redemptions: Redemption[] = [];
  private sink?: Sink;

  constructor(private readonly isOwner: (userId: string) => boolean, private readonly effects: CouponEffects, private readonly now: () => Date = () => new Date()) {}

  useSink(sink: Sink): void { this.sink = sink; }
  restoreCoupon(c: Coupon): void { this.coupons.set(c.id, c); }
  restoreRedemption(r: Redemption): void { this.redemptions.push(r); }

  private requireOwner(userId: string): void {
    if (!this.isOwner(userId)) throw new PermissionError("only the platform owner manages coupons");
  }

  private save(c: Coupon): void {
    this.coupons.set(c.id, c);
    this.sink?.promo("coupon", c.id, c);
  }

  create(userId: string, raw: unknown): Coupon {
    this.requireOwner(userId);
    const b = (raw ?? {}) as Record<string, unknown>;
    const code = normaliseCouponCode(b.code);
    if (!CODE_PATTERN.test(code)) throw new PromoError("a code is 3 to 32 letters, numbers or dashes");
    if ([...this.coupons.values()].some((c) => c.code === code)) throw new PromoError("a coupon with that code already exists");
    const kind = b.kind as CouponKind;
    if (!COUPON_KINDS.includes(kind)) throw new PromoError("choose what the coupon gives");
    const value = checkCouponValue(kind, b.value);
    const duration = kind === "percent_off" || kind === "fixed_off" ? checkDuration(b.duration) : ({ kind: "once" } as Duration);
    const coupon: Coupon = { id: newId("coupon"), code, kind, value, duration, enabled: true, createdAt: this.now().toISOString(), createdBy: userId };
    if (b.maxRedemptions !== undefined && b.maxRedemptions !== null && b.maxRedemptions !== "") {
      const m = Number(b.maxRedemptions);
      if (!Number.isInteger(m) || m < 1 || m > MAX_REDEMPTIONS_LIMIT) throw new PromoError("maximum uses must be a whole number of 1 or more");
      coupon.maxRedemptions = m;
    }
    if (b.expiresAt) {
      const t = Date.parse(String(b.expiresAt));
      if (Number.isNaN(t)) throw new PromoError("the expiry date is not valid");
      if (t <= this.now().getTime()) throw new PromoError("the expiry date must be in the future");
      coupon.expiresAt = new Date(t).toISOString();
    }
    if (b.plan === "trial" || b.plan === "paid") coupon.plan = b.plan;
    else if (b.plan) throw new PromoError("restrict a coupon to trial or paid clients, or leave it open");
    if (b.email) {
      const e = String(b.email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new PromoError("the email restriction is not a valid address");
      coupon.email = e;
    }
    if (b.note) coupon.note = String(b.note).slice(0, NOTE_MAX);
    if (coupon.kind === "trial_days" && coupon.plan === "paid") throw new PromoError("trial days only work for clients on the free trial");
    this.save(coupon);
    return coupon;
  }

  setEnabled(userId: string, id: string, enabled: boolean): Coupon {
    this.requireOwner(userId);
    const c = this.coupons.get(id);
    if (!c) throw new PromoError("coupon not found");
    const next = { ...c, enabled };
    this.save(next);
    return next;
  }

  usedCount(couponId: string): number {
    return this.redemptions.filter((r) => r.couponId === couponId).length;
  }

  /** Owner's list: every coupon with how often it was used, newest first. */
  list(userId: string): (Coupon & { used: number; status: "active" | "disabled" | "expired" | "used_up"; summary: string })[] {
    this.requireOwner(userId);
    const t = this.now().getTime();
    return [...this.coupons.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((c) => {
        const used = this.usedCount(c.id);
        const status = !c.enabled ? "disabled" : c.expiresAt && Date.parse(c.expiresAt) <= t ? "expired" : c.maxRedemptions !== undefined && used >= c.maxRedemptions ? "used_up" : "active";
        return { ...c, used, status, summary: describeCoupon(c.kind, c.value, c.duration) };
      });
  }

  redemptionsOf(userId: string, couponId: string): Redemption[] {
    this.requireOwner(userId);
    return this.redemptions.filter((r) => r.couponId === couponId).sort((a, b) => b.at.localeCompare(a.at));
  }

  /**
   * Whether a client may use this code now. Returns the coupon, or throws PromoError with words the client can act on.
   * An email restriction is never named, so a guessed code does not reveal whose it is.
   */
  private validate(raw: unknown, ctx: CouponContext): Coupon {
    const code = normaliseCouponCode(raw);
    if (!code) throw new PromoError("Enter a code.");
    if (!CODE_PATTERN.test(code)) throw new PromoError("That doesn't look like a code. Codes are letters, numbers and dashes.");
    const c = [...this.coupons.values()].find((x) => x.code === code);
    if (!c) throw new PromoError("That code isn't valid. Check it and try again.");
    if (!c.enabled) throw new PromoError("This code is no longer active.");
    if (c.expiresAt && Date.parse(c.expiresAt) <= this.now().getTime()) throw new PromoError(`This code expired on ${new Date(c.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}.`);
    if (c.maxRedemptions !== undefined && this.usedCount(c.id) >= c.maxRedemptions) throw new PromoError("This code has been used the maximum number of times.");
    if (c.email && (!ctx.email || ctx.email.trim().toLowerCase() !== c.email)) throw new PromoError("That code isn't valid. Check it and try again.");
    const ws = ctx.workspaceId;
    if (ws) {
      if (this.redemptions.some((r) => r.couponId === c.id && r.workspaceId === ws)) throw new PromoError("You have already used this code.");
      const trial = this.effects.isTrial(ws);
      if (c.plan === "trial" && !trial) throw new PromoError("This code is for clients on the free trial.");
      if (c.plan === "paid" && trial) throw new PromoError("This code is for paying clients. It will work once your team is on the paid plan.");
      if (c.kind === "trial_days" && !trial) throw new PromoError("This code extends the free trial, and your team is already on the paid plan.");
      if (discountOf(c.kind, c.value, c.duration) && this.activeDiscount(ws)) throw new PromoError("You already have a discount. Only one discount can be active at a time.");
    }
    return c;
  }

  /** The client types a code: says what it would give, changes nothing. */
  check(raw: unknown, ctx: CouponContext): CouponCheck {
    const c = this.validate(raw, ctx);
    return { code: c.code, summary: describeCoupon(c.kind, c.value, c.duration) };
  }

  /** The client uses a code on their team. Gives what it promises and records who used it. */
  redeem(userId: string, workspaceId: string, email: string, raw: unknown): Redemption {
    const c = this.validate(raw, { email, workspaceId });
    const by = `user:${userId}`;
    if (c.kind === "trial_days") this.effects.extendTrial(workspaceId, c.value, by);
    else if (c.kind === "energy_credit") this.effects.grantEnergy(workspaceId, c.value, by);
    const discount = discountOf(c.kind, c.value, c.duration);
    const r: Redemption = {
      id: newId("redemption"), couponId: c.id, code: c.code, workspaceId, email: email.trim().toLowerCase(), at: this.now().toISOString(),
      applied: describeCoupon(c.kind, c.value, c.duration), ...(discount ? { discount } : {}),
    };
    this.redemptions.push(r);
    this.sink?.promo("redemption", r.id, r);
    return r;
  }

  /** The discount on this client's bill, if one is waiting for billing to start (or running). */
  activeDiscount(workspaceId: string): Redemption | undefined {
    return this.redemptions.find((r) => r.workspaceId === workspaceId && r.discount);
  }

  /** Everything a client has used, for their account page. */
  forClient(workspaceId: string): Redemption[] {
    return this.redemptions.filter((r) => r.workspaceId === workspaceId).sort((a, b) => b.at.localeCompare(a.at));
  }
}
