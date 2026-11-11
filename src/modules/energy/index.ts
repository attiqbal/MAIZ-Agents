import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";

/**
 * Energy is what customers see; cost is what we pay. 1 energy = 1/1000 of a
 * US dollar of real provider cost (default), so a cheap open model burns less
 * energy than a premium one for the same work, and profit stays predictable.
 * All values are integers. Nothing here calls a model.
 */
export interface ModelPrice {
  /** Provider cost in micro-dollars (1e-6 USD) per 1,000 input / output tokens. */
  inputPer1k: number;
  outputPer1k: number;
}

/** Defaults are planning estimates, not quotes. Override from config per provider/model. */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  anthropic: { inputPer1k: 1_000, outputPer1k: 5_000 },
  "openai-compatible": { inputPer1k: 150, outputPer1k: 300 },
  mock: { inputPer1k: 0, outputPer1k: 0 },
};
const FALLBACK_PRICE: ModelPrice = { inputPer1k: 3_000, outputPer1k: 15_000 };
const MICRO_PER_ENERGY = 1_000; // 1 energy = 1,000 micro-dollars = $0.001

export interface EnergyPlan {
  /**
   * Free energy each employee gets per day. Only used by plans without a team pool (older plans); with a
   * pool, an agent is held to a daily amount only when the platform owner set one for that agent.
   */
  dailyQuotaPerEmployee: number;
  /**
   * Shared team pool: energy the whole team may use per week (Monday 00:00 UTC to Monday). On a trial
   * (expiresAt set) the pool covers the whole trial instead, from startedAt to expiresAt.
   * Add-on employees and specialists add to it through the pool resolver.
   */
  weeklyTeamEnergy?: number;
  /** Most the whole team may use in one day (UTC), so a runaway script cannot empty the week at once. */
  dailyTeamCeiling?: number;
  /** When the plan started (the trial window starts here). */
  startedAt?: string;
  /**
   * Older plans without a team pool: extra energy a workspace may spend beyond the daily quota per month.
   * Pooled plans use bought top-ups instead (topUpEnergyBought), which roll over and never expire.
   */
  monthlyOvertimeCap: number;
  /** Total top-up energy ever bought. What is left = this minus all top-up (overtime) energy used. */
  topUpEnergyBought?: number;
  /** Auto-reload: off unless the client turns it on, and never spends more than their monthly cap. */
  autoReload?: AutoReload;
  /** Auto-reload spend so far this month (UTC), so the cap holds. */
  autoReloadSpent?: { month: string; gbp: number };
  /** Hard stop for total real provider cost per month, in micro-dollars. Protects margin. */
  monthlyCostCapMicro: number;
  /** ISO timestamp after which no work is allowed (end of free trial). */
  expiresAt?: string;
}

export interface AutoReload {
  enabled: boolean;
  /** The pack bought each time the team runs out: its price and the energy it adds. */
  packGbp: number;
  packEnergy: number;
  /** Most auto-reload may spend in a calendar month. */
  monthlyCapGbp: number;
}

export class EnergyError extends Error {}

const MAX_TOP_UP_ENERGY = 1_000_000;
const MAX_AUTO_RELOAD_CAP_GBP = 10_000;

/** Checks auto-reload settings from a client. Off is always allowed; on needs a pack and a cap. */
export function parseAutoReload(input: unknown, packs: readonly { gbp: number; energy: number }[]): AutoReload {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new EnergyError("auto-reload settings are not valid");
  const b = input as Record<string, unknown>;
  if (typeof b.enabled !== "boolean") throw new EnergyError("say whether auto-reload is on or off");
  const pack = packs.find((p) => p.gbp === b.packGbp) ?? packs[0];
  if (!pack) throw new EnergyError("no top-up packs are on sale");
  const cap = b.monthlyCapGbp;
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0 || cap > MAX_AUTO_RELOAD_CAP_GBP) throw new EnergyError(`monthly cap must be from £0 to £${MAX_AUTO_RELOAD_CAP_GBP}`);
  if (b.enabled && cap < pack.gbp) throw new EnergyError("the monthly cap must cover at least one pack");
  return { enabled: b.enabled, packGbp: pack.gbp, packEnergy: pack.energy, monthlyCapGbp: Math.round(cap * 100) / 100 };
}

/**
 * Launch plans (pricing doc, 2026-11-11). The team shares one pool so a busy employee never hits a wall
 * while others sit idle. The monthly cost cap is a hidden backstop and must never be reached before the
 * visible pool runs out: `effectiveCostCapMicro` raises it to fit the pool, add-ons and top-ups.
 */
export const PLANS: Record<string, EnergyPlan> = {
  trial: { dailyQuotaPerEmployee: 300, weeklyTeamEnergy: 3_000, dailyTeamCeiling: 3_000, monthlyOvertimeCap: 0, monthlyCostCapMicro: 5_000_000 },
  starter: { dailyQuotaPerEmployee: 1_000, weeklyTeamEnergy: 8_000, dailyTeamCeiling: 3_000, monthlyOvertimeCap: 0, monthlyCostCapMicro: 50_000_000 },
};

/** Headroom above the visible allowance for our own Claude checks and redo, which the client does not see. */
const COST_CAP_HEADROOM = 1.25;
const DAYS_IN_LONGEST_MONTH = 31;

/**
 * The hidden monthly cost cap actually applied: the plan's own cap, raised when needed so it sits above
 * everything the client can see (a month of the pool, add-ons included, plus bought top-ups).
 */
export function effectiveCostCapMicro(plan: EnergyPlan, poolBonus = 0, topUpEnergy = 0): number {
  if (plan.weeklyTeamEnergy === undefined) return plan.monthlyCostCapMicro;
  const visibleEnergy = plan.expiresAt
    ? plan.weeklyTeamEnergy + poolBonus + topUpEnergy
    : ((plan.weeklyTeamEnergy + poolBonus) * DAYS_IN_LONGEST_MONTH) / 7 + plan.monthlyOvertimeCap + topUpEnergy;
  return Math.max(plan.monthlyCostCapMicro, Math.ceil(visibleEnergy * MICRO_PER_ENERGY * COST_CAP_HEADROOM));
}

/** Monday 00:00 UTC of the week containing `d`. */
export function weekStart(d: Date): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * 86_400_000);
}

/** What the client sees for a team pool. */
export interface TeamEnergy {
  /** The pool for this week (or the whole trial), add-ons included. */
  pool: number;
  used: number;
  left: number;
  /** Share of the pool used, 0 to 100, which is what the client sees first. */
  percentUsed: number;
  /** Bought top-up energy still unused. It rolls over and never expires. */
  topUpLeft: number;
  autoReload: AutoReload | null;
  /** Left today under the daily ceiling (never more than `left`). */
  leftToday: number;
  dailyCeiling: number | null;
  /** When the pool refills: next Monday 00:00 UTC, or null on a trial (it ends instead). */
  refillsAt: string | null;
}

export type Verdict =
  | { allowed: true; overtime: boolean }
  | { allowed: false; reason: "daily_quota_used" | "weekly_pool_used" | "daily_ceiling_reached" | "overtime_cap_reached" | "monthly_cost_cap_reached" | "trial_ended" };

export interface UsageRecord {
  workspaceId: string;
  employeeId: string;
  /** ISO date YYYY-MM-DD (UTC). */
  day: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costMicro: number;
  energy: number;
  overtime: boolean;
}

export function costMicro(provider: string, inputTokens: number, outputTokens: number): number {
  const p = DEFAULT_PRICES[provider] ?? FALLBACK_PRICE;
  return Math.ceil((inputTokens * p.inputPer1k + outputTokens * p.outputPer1k) / 1000);
}

export class EnergyMeter {
  private plans = new Map<string, EnergyPlan>();
  private usage: UsageRecord[] = [];
  private sink?: Sink;

  useSink(sink: Sink): void {
    this.sink = sink;
  }

  restorePlan(workspaceId: string, plan: EnergyPlan): void {
    this.plans.set(workspaceId, plan);
  }

  restoreUsage(u: UsageRecord): void {
    this.usage.push(u);
  }

  constructor(
    private identity: IdentityService,
    private audit: AuditLog,
    private now: () => Date = () => new Date(),
  ) {}

  private quotaFor?: (workspaceId: string, employeeId: string) => number | undefined;

  /** Per-agent daily energy set by the platform owner. Undefined falls back to the workspace plan. */
  setQuotaResolver(fn: (workspaceId: string, employeeId: string) => number | undefined): void {
    this.quotaFor = fn;
  }

  private poolBonusFor?: (workspaceId: string) => number;

  /** Extra weekly energy that add-on employees and specialists bring to a paid team pool. */
  setPoolBonusResolver(fn: (workspaceId: string) => number): void {
    this.poolBonusFor = fn;
  }

  private dailyQuota(workspaceId: string, employeeId: string): number {
    return this.quotaFor?.(workspaceId, employeeId) ?? this.planOf(workspaceId).dailyQuotaPerEmployee;
  }

  /** A pooled plan holds an agent to a daily amount only when the platform owner set one for it. */
  private agentCap(workspaceId: string, employeeId: string): number | undefined {
    return this.quotaFor?.(workspaceId, employeeId);
  }

  private poolBonus(workspaceId: string, plan: EnergyPlan): number {
    // A trial's pool is fixed; add-ons only add to paid plans.
    return plan.expiresAt ? 0 : Math.max(0, this.poolBonusFor?.(workspaceId) ?? 0);
  }

  /** Start of the current pool window: the trial start, or Monday 00:00 UTC. */
  private windowStart(plan: EnergyPlan): string {
    if (plan.expiresAt && plan.startedAt) return plan.startedAt.slice(0, 10);
    return weekStart(this.now()).toISOString().slice(0, 10);
  }

  /** The shared team pool right now, or undefined for a plan without one. Platform-level, no user check. */
  teamEnergyOf(workspaceId: string): TeamEnergy | undefined {
    const plan = this.planOf(workspaceId);
    if (plan.weeklyTeamEnergy === undefined) return undefined;
    const from = this.windowStart(plan);
    const day = this.today();
    const rows = this.usage.filter((u) => u.workspaceId === workspaceId && !u.overtime && u.day >= from);
    const used = rows.reduce((s, u) => s + u.energy, 0);
    const usedToday = rows.filter((u) => u.day === day).reduce((s, u) => s + u.energy, 0);
    const pool = plan.weeklyTeamEnergy + this.poolBonus(workspaceId, plan);
    const left = Math.max(0, pool - used);
    const ceiling = plan.dailyTeamCeiling ?? null;
    const refillsAt = plan.expiresAt ? null : new Date(weekStart(this.now()).getTime() + 7 * 86_400_000).toISOString();
    const percentUsed = pool > 0 ? Math.min(100, Math.round((used / pool) * 100)) : 100;
    return {
      pool, used, left, percentUsed, topUpLeft: this.topUpLeft(workspaceId), autoReload: plan.autoReload ?? null,
      leftToday: ceiling === null ? left : Math.min(left, Math.max(0, ceiling - usedToday)), dailyCeiling: ceiling, refillsAt,
    };
  }

  /** Bought top-up energy not used yet. */
  topUpLeft(workspaceId: string): number {
    const bought = this.planOf(workspaceId).topUpEnergyBought ?? 0;
    const used = this.usage.filter((u) => u.workspaceId === workspaceId && u.overtime).reduce((s, u) => s + u.energy, 0);
    return Math.max(0, bought - used);
  }

  private charge?: (workspaceId: string, gbp: number, what: string) => boolean;

  /**
   * Takes payment for an automatic top-up. Payments are not built yet, so without a charger auto-reload never
   * fires (settings are kept and shown). It must return true only when the money was taken.
   */
  setTopUpCharger(fn: (workspaceId: string, gbp: number, what: string) => boolean): void {
    this.charge = fn;
  }

  /** A paid top-up pack: called by checkout once the payment succeeded. Adds energy that rolls over. */
  addTopUp(workspaceId: string, energy: number, gbp: number, by: string): void {
    if (!Number.isInteger(energy) || energy <= 0 || energy > MAX_TOP_UP_ENERGY) throw new EnergyError("top-up energy is not valid");
    const plan = this.planOf(workspaceId);
    if (plan.weeklyTeamEnergy === undefined || plan.expiresAt) throw new EnergyError("top-ups are for paid team plans");
    this.savePlan(workspaceId, { ...plan, topUpEnergyBought: (plan.topUpEnergyBought ?? 0) + energy });
    this.audit.record({ workspaceId, actor: by, action: "energy.top_up", data: { energy, gbp } });
  }

  /** The client turns auto-reload on or off. Only an owner or admin can, as it spends money. */
  setAutoReload(userId: string, workspaceId: string, settings: AutoReload): void {
    this.identity.require(userId, workspaceId, "workspace.manage");
    this.savePlan(workspaceId, { ...this.planOf(workspaceId), autoReload: settings });
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "energy.auto_reload_set", data: { ...settings } });
  }

  /** Buys one pack when the team has run out, if the client turned auto-reload on and the month's cap allows. */
  private tryAutoReload(workspaceId: string): boolean {
    const plan = this.planOf(workspaceId);
    const ar = plan.autoReload;
    if (!ar?.enabled || !this.charge || plan.expiresAt) return false;
    const month = this.today().slice(0, 7);
    const spent = plan.autoReloadSpent?.month === month ? plan.autoReloadSpent.gbp : 0;
    if (spent + ar.packGbp > ar.monthlyCapGbp) return false;
    if (!this.charge(workspaceId, ar.packGbp, `${ar.packEnergy} energy top-up`)) return false;
    this.addTopUp(workspaceId, ar.packEnergy, ar.packGbp, "system:auto_reload");
    this.savePlan(workspaceId, { ...this.planOf(workspaceId), autoReloadSpent: { month, gbp: spent + ar.packGbp } });
    return true;
  }

  private savePlan(workspaceId: string, plan: EnergyPlan): void {
    this.plans.set(workspaceId, plan);
    this.sink?.plan(workspaceId, plan);
  }

  /** What the client sees: the team pool. Any member can read it. */
  teamEnergy(userId: string, workspaceId: string): TeamEnergy | undefined {
    this.identity.require(userId, workspaceId, "task.read");
    return this.teamEnergyOf(workspaceId);
  }

  setPlan(userId: string, workspaceId: string, plan: EnergyPlan): void {
    this.identity.require(userId, workspaceId, "workspace.manage");
    this.plans.set(workspaceId, plan);
    this.sink?.plan(workspaceId, plan);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "energy.plan_set", data: { ...plan } });
  }

  planOf(workspaceId: string): EnergyPlan {
    return this.plans.get(workspaceId) ?? PLANS.trial!;
  }

  /** Ask before doing work. Changes nothing, except buying a pack when the client turned auto-reload on. */
  check(workspaceId: string, employeeId: string): Verdict {
    const plan = this.planOf(workspaceId);
    if (plan.expiresAt && this.now().toISOString() > plan.expiresAt) return { allowed: false, reason: "trial_ended" };
    const day = this.today();
    const month = day.slice(0, 7);
    const mine = this.usage.filter((u) => u.workspaceId === workspaceId);
    const monthRows = mine.filter((u) => u.day.startsWith(month));
    const topUpThisMonth = this.topUpLeft(workspaceId) + monthRows.filter((u) => u.overtime).reduce((s, u) => s + u.energy, 0);
    if (monthRows.reduce((s, u) => s + u.costMicro, 0) >= effectiveCostCapMicro(plan, this.poolBonus(workspaceId, plan), topUpThisMonth))
      return { allowed: false, reason: "monthly_cost_cap_reached" };
    const usedToday = mine.filter((u) => u.employeeId === employeeId && u.day === day).reduce((s, u) => s + u.energy, 0);
    const team = this.teamEnergyOf(workspaceId);
    if (team) {
      // Shared pool: the daily ceiling and an agent's own cap are safety limits, not something to buy past.
      if (team.dailyCeiling !== null && team.left > 0 && team.leftToday === 0) return { allowed: false, reason: "daily_ceiling_reached" };
      const cap = this.agentCap(workspaceId, employeeId);
      // Same count as remainingToday: an agent's cap is measured on pool energy, not on bought top-ups.
      const poolUsedToday = mine.filter((u) => u.employeeId === employeeId && u.day === day && !u.overtime).reduce((s, u) => s + u.energy, 0);
      if (cap !== undefined && poolUsedToday >= cap) return { allowed: false, reason: "daily_quota_used" };
      if (team.left > 0) return { allowed: true, overtime: false };
      // Pool used: bought top-ups carry on the work; auto-reload buys one more pack only if the client said so.
      if (this.topUpLeft(workspaceId) > 0 || this.tryAutoReload(workspaceId)) return { allowed: true, overtime: true };
      return { allowed: false, reason: "weekly_pool_used" };
    } else if (usedToday < this.dailyQuota(workspaceId, employeeId)) return { allowed: true, overtime: false };
    const overtimeUsed = monthRows.filter((u) => u.overtime).reduce((s, u) => s + u.energy, 0);
    if (plan.monthlyOvertimeCap === 0) return { allowed: false, reason: team ? "weekly_pool_used" : "daily_quota_used" };
    if (overtimeUsed >= plan.monthlyOvertimeCap) return { allowed: false, reason: "overtime_cap_reached" };
    return { allowed: true, overtime: true };
  }

  /** Record what a finished piece of work actually cost. */
  record(workspaceId: string, employeeId: string, provider: string, inputTokens: number, outputTokens: number, overtime: boolean, measuredCostMicro?: number): UsageRecord {
    // The routing gateway measures the real cost of everything done for a task (answer, checks, redo); otherwise estimate from tokens.
    const cost = measuredCostMicro ?? costMicro(provider, inputTokens, outputTokens);
    const rec: UsageRecord = {
      workspaceId,
      employeeId,
      day: this.today(),
      provider,
      inputTokens,
      outputTokens,
      costMicro: cost,
      energy: Math.ceil(cost / MICRO_PER_ENERGY),
      overtime,
    };
    this.usage.push(rec);
    this.sink?.usage(rec);
    return rec;
  }

  /** What the customer sees: energy left today for one employee. Can go negative only through overtime. */
  remainingToday(userId: string, workspaceId: string, employeeId: string): number {
    this.identity.require(userId, workspaceId, "task.read");
    const day = this.today();
    const used = this.usage.filter((u) => u.workspaceId === workspaceId && u.employeeId === employeeId && u.day === day && !u.overtime).reduce((s, u) => s + u.energy, 0);
    const team = this.teamEnergyOf(workspaceId);
    if (!team) return Math.max(0, this.dailyQuota(workspaceId, employeeId) - used);
    // With a pool, an employee can use whatever the team has left today, up to its own cap if it has one.
    const cap = this.agentCap(workspaceId, employeeId);
    return cap === undefined ? team.leftToday : Math.min(team.leftToday, Math.max(0, cap - used));
  }

  /** What we see: real cost and energy for the month. Admin/owner view. */
  monthSummary(userId: string, workspaceId: string, month = this.today().slice(0, 7)) {
    this.identity.require(userId, workspaceId, "workspace.manage");
    const rows = this.usage.filter((u) => u.workspaceId === workspaceId && u.day.startsWith(month));
    const byEmployee: Record<string, { energy: number; costMicro: number }> = {};
    for (const r of rows) {
      const e = (byEmployee[r.employeeId] ??= { energy: 0, costMicro: 0 });
      e.energy += r.energy;
      e.costMicro += r.costMicro;
    }
    return {
      energy: rows.reduce((s, r) => s + r.energy, 0),
      costMicro: rows.reduce((s, r) => s + r.costMicro, 0),
      overtimeEnergy: rows.filter((r) => r.overtime).reduce((s, r) => s + r.energy, 0),
      byEmployee,
    };
  }

  /** Platform-level usage for one client (no user check): the platform owner's clients screen. */
  usageOf(workspaceId: string): { energyToday: number; energyMonth: number; costMicroMonth: number } {
    const day = this.today();
    const rows = this.usage.filter((u) => u.workspaceId === workspaceId && u.day.startsWith(day.slice(0, 7)));
    return {
      energyToday: rows.filter((u) => u.day === day).reduce((s, u) => s + u.energy, 0),
      energyMonth: rows.reduce((s, u) => s + u.energy, 0),
      costMicroMonth: rows.reduce((s, u) => s + u.costMicro, 0),
    };
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }
}
