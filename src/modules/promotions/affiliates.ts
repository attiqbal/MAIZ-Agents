import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import { PermissionError } from "../identity/index.js";
import {
  AFFILIATE_CODE_PATTERN, DEFAULT_COMMISSION, DEFAULT_HOLD_DAYS, PromoError, canonicalEmail, checkCommission, commissionFor, normaliseAffiliateCode, round2,
  type Commission,
} from "./rules.js";

export interface Affiliate {
  id: string;
  name: string;
  /** Their sign-in email: they see their dashboard when they log in with it. Lower case. */
  email: string;
  /** Referral code in the link and the cookie. Lower case. */
  code: string;
  commission: Commission;
  /** Days a commission waits before it can be paid. */
  holdDays: number;
  enabled: boolean;
  note?: string;
  clicks: number;
  createdAt: string;
  createdBy: string;
}

export interface Referral {
  id: string;
  affiliateId: string;
  workspaceId: string;
  /** The referred client's business name, kept so the affiliate's list reads in words. */
  businessName: string;
  at: string;
}

export interface Accrual {
  id: string;
  affiliateId: string;
  referralId: string;
  /** What the client paid (pounds), the order or payment it came from, and the commission it earned. */
  paymentRef: string;
  paidGbp: number;
  amountGbp: number;
  at: string;
  /** From this moment (ISO time) the commission can be paid out. */
  payableFrom: string;
  payoutId?: string;
}

export interface Payout {
  id: string;
  affiliateId: string;
  amountGbp: number;
  accrualIds: string[];
  at: string;
  by: string;
  /** How it was paid, for example a bank transfer reference. */
  reference?: string;
}

export interface AffiliateStats {
  clicks: number;
  signups: number;
  paying: number;
  /** All commission earned, split by where it stands. */
  earnedGbp: number;
  /** Still inside the hold period. */
  pendingGbp: number;
  /** Past the hold period and not yet paid: what the owner will pay next. */
  payableGbp: number;
  paidGbp: number;
}

export interface AffiliateView extends Affiliate {
  stats: AffiliateStats;
}

export interface AffiliateDetail extends AffiliateView {
  referrals: (Referral & { paying: boolean; earnedGbp: number })[];
  accruals: Accrual[];
  payouts: Payout[];
}

const NAME_MAX = 80;
const NOTE_MAX = 300;
const REFERENCE_MAX = 200;

export class AffiliateService {
  private affiliates = new Map<string, Affiliate>();
  private referrals = new Map<string, Referral>();
  private accruals = new Map<string, Accrual>();
  private payouts = new Map<string, Payout>();
  private sink?: Sink;

  constructor(private readonly isOwner: (userId: string) => boolean, private readonly now: () => Date = () => new Date()) {}

  useSink(sink: Sink): void { this.sink = sink; }
  restore(kind: string, data: any): void {
    if (kind === "affiliate") this.affiliates.set(data.id, data);
    else if (kind === "referral") this.referrals.set(data.id, data);
    else if (kind === "accrual") this.accruals.set(data.id, data);
    else if (kind === "payout") this.payouts.set(data.id, data);
  }

  private requireOwner(userId: string): void {
    if (!this.isOwner(userId)) throw new PermissionError("only the platform owner manages affiliates");
  }
  private saveAffiliate(a: Affiliate): void { this.affiliates.set(a.id, a); this.sink?.promo("affiliate", a.id, a); }
  private saveAccrual(a: Accrual): void { this.accruals.set(a.id, a); this.sink?.promo("accrual", a.id, a); }

  byCode(raw: unknown): Affiliate | undefined {
    const code = normaliseAffiliateCode(raw);
    return [...this.affiliates.values()].find((a) => a.code === code);
  }

  create(userId: string, raw: unknown): Affiliate {
    this.requireOwner(userId);
    const b = (raw ?? {}) as Record<string, unknown>;
    const name = String(b.name ?? "").trim().slice(0, NAME_MAX);
    if (!name) throw new PromoError("enter the affiliate's name");
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new PromoError("enter a valid email: the affiliate logs in with it");
    const code = normaliseAffiliateCode(b.code || name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
    if (!AFFILIATE_CODE_PATTERN.test(code)) throw new PromoError("a referral code is 3 to 24 lower-case letters, numbers or dashes");
    if (this.byCode(code)) throw new PromoError("that referral code is already taken");
    if ([...this.affiliates.values()].some((a) => canonicalEmail(a.email) === canonicalEmail(email))) throw new PromoError("an affiliate with that email already exists");
    const commission = checkCommission(b.commission ?? DEFAULT_COMMISSION);
    const hold = b.holdDays === undefined || b.holdDays === "" ? DEFAULT_HOLD_DAYS : Number(b.holdDays);
    if (!Number.isInteger(hold) || hold < 0 || hold > 180) throw new PromoError("the hold period is a whole number of days from 0 to 180");
    const a: Affiliate = {
      id: newId("affiliate"), name, email, code, commission, holdDays: hold, enabled: true, clicks: 0,
      ...(b.note ? { note: String(b.note).slice(0, NOTE_MAX) } : {}), createdAt: this.now().toISOString(), createdBy: userId,
    };
    this.saveAffiliate(a);
    return a;
  }

  setEnabled(userId: string, id: string, enabled: boolean): Affiliate {
    this.requireOwner(userId);
    const a = this.affiliates.get(id);
    if (!a) throw new PromoError("affiliate not found");
    const next = { ...a, enabled };
    this.saveAffiliate(next);
    return next;
  }

  /** A visitor opened the link. Counted only for an active affiliate. */
  trackClick(code: unknown): Affiliate | undefined {
    const a = this.byCode(code);
    if (!a || !a.enabled) return undefined;
    const next = { ...a, clicks: a.clicks + 1 };
    this.saveAffiliate(next);
    return next;
  }

  /**
   * A new client signed up after following a referral link. Returns the referral, or undefined when it does not
   * count: unknown or paused code, the affiliate's own address (or an alias of it), or a client already referred.
   */
  attribute(workspaceId: string, ownerEmail: string, businessName: string, code: unknown): Referral | undefined {
    const a = this.byCode(code);
    if (!a || !a.enabled) return undefined;
    if (canonicalEmail(ownerEmail) === canonicalEmail(a.email)) return undefined;
    if ([...this.referrals.values()].some((r) => r.workspaceId === workspaceId)) return undefined;
    const r: Referral = { id: newId("referral"), affiliateId: a.id, workspaceId, businessName: businessName.slice(0, NAME_MAX), at: this.now().toISOString() };
    this.referrals.set(r.id, r);
    this.sink?.promo("referral", r.id, r);
    return r;
  }

  /**
   * A referred client paid. Earns commission for the first N payments only, once per payment reference so a replayed
   * webhook never pays twice. Returns the accrual, or undefined when nothing is earned.
   */
  recordPayment(workspaceId: string, paidGbp: number, paymentRef: string): Accrual | undefined {
    const ref = [...this.referrals.values()].find((r) => r.workspaceId === workspaceId);
    if (!ref || !(paidGbp > 0)) return undefined;
    const a = this.affiliates.get(ref.affiliateId);
    if (!a) return undefined;
    const mine = [...this.accruals.values()].filter((x) => x.referralId === ref.id);
    if (mine.some((x) => x.paymentRef === paymentRef) || mine.length >= a.commission.months) return undefined;
    const at = this.now();
    const acc: Accrual = {
      id: newId("accrual"), affiliateId: a.id, referralId: ref.id, paymentRef, paidGbp: round2(paidGbp), amountGbp: commissionFor(a.commission, paidGbp),
      at: at.toISOString(), payableFrom: new Date(at.getTime() + a.holdDays * 86_400_000).toISOString(),
    };
    this.saveAccrual(acc);
    return acc;
  }

  private statsOf(a: Affiliate): AffiliateStats {
    const t = this.now().toISOString();
    const refs = [...this.referrals.values()].filter((r) => r.affiliateId === a.id);
    const acc = [...this.accruals.values()].filter((x) => x.affiliateId === a.id);
    const sum = (xs: Accrual[]) => round2(xs.reduce((s, x) => s + x.amountGbp, 0));
    return {
      clicks: a.clicks, signups: refs.length, paying: refs.filter((r) => acc.some((x) => x.referralId === r.id)).length,
      earnedGbp: sum(acc), pendingGbp: sum(acc.filter((x) => !x.payoutId && x.payableFrom > t)), payableGbp: sum(acc.filter((x) => !x.payoutId && x.payableFrom <= t)),
      paidGbp: sum(acc.filter((x) => x.payoutId)),
    };
  }

  list(userId: string): AffiliateView[] {
    this.requireOwner(userId);
    return [...this.affiliates.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((a) => ({ ...a, stats: this.statsOf(a) }));
  }

  private detail(a: Affiliate): AffiliateDetail {
    const accruals = [...this.accruals.values()].filter((x) => x.affiliateId === a.id).sort((x, y) => y.at.localeCompare(x.at));
    const referrals = [...this.referrals.values()].filter((r) => r.affiliateId === a.id).sort((x, y) => y.at.localeCompare(x.at)).map((r) => {
      const mine = accruals.filter((x) => x.referralId === r.id);
      return { ...r, paying: mine.length > 0, earnedGbp: round2(mine.reduce((s, x) => s + x.amountGbp, 0)) };
    });
    const payouts = [...this.payouts.values()].filter((p) => p.affiliateId === a.id).sort((x, y) => y.at.localeCompare(x.at));
    return { ...a, stats: this.statsOf(a), referrals, accruals, payouts };
  }

  detailFor(userId: string, id: string): AffiliateDetail {
    this.requireOwner(userId);
    const a = this.affiliates.get(id);
    if (!a) throw new PromoError("affiliate not found");
    return this.detail(a);
  }

  /** What an affiliate sees when they log in with their email, or undefined if that email is not an affiliate. */
  dashboardFor(email: string): AffiliateDetail | undefined {
    const e = email.trim().toLowerCase();
    const a = [...this.affiliates.values()].find((x) => x.email === e);
    return a ? this.detail(a) : undefined;
  }

  /**
   * The owner has paid an affiliate by hand (bank transfer, PayPal, whatever was agreed) and marks it here.
   * Settles every commission past its hold period; nothing is ever paid automatically.
   */
  markPaid(userId: string, affiliateId: string, reference?: unknown): Payout {
    this.requireOwner(userId);
    const a = this.affiliates.get(affiliateId);
    if (!a) throw new PromoError("affiliate not found");
    const t = this.now().toISOString();
    const due = [...this.accruals.values()].filter((x) => x.affiliateId === a.id && !x.payoutId && x.payableFrom <= t);
    if (!due.length) throw new PromoError("nothing is ready to pay yet: commissions wait out the hold period first");
    const payout: Payout = {
      id: newId("payout"), affiliateId: a.id, amountGbp: round2(due.reduce((s, x) => s + x.amountGbp, 0)), accrualIds: due.map((x) => x.id), at: t, by: userId,
      ...(reference ? { reference: String(reference).slice(0, REFERENCE_MAX) } : {}),
    };
    this.payouts.set(payout.id, payout);
    this.sink?.promo("payout", payout.id, payout);
    for (const x of due) this.saveAccrual({ ...x, payoutId: payout.id });
    return payout;
  }
}
