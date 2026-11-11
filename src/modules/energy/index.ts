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
  /** Extra energy a workspace may buy and spend beyond the daily quota per month. 0 = no overtime. */
  monthlyOvertimeCap: number;
  /** Hard stop for total real provider cost per month, in micro-dollars. Protects margin. */
  monthlyCostCapMicro: number;
  /** ISO timestamp after which no work is allowed (end of free trial). */
  expiresAt?: string;
}

/**
 * Launch plans (pricing doc, 2026-11-11). The team shares one pool so a busy employee never hits a wall
 * while others sit idle. The monthly cost cap is a hidden backstop and must never be reached before the
 * visible pool runs out: `effectiveCostCapMicro` raises it to fit the pool, add-ons and top-ups.
 */
export const PLANS: Record<string, EnergyPlan> = {
  trial: { dailyQuotaPerEmployee: 300, weeklyTeamEnergy: 3_000, dailyTeamCeiling: 3_000, monthlyOvertimeCap: 0, monthlyCostCapMicro: 5_000_000 },
  starter: { dailyQuotaPerEmployee: 1_000, weeklyTeamEnergy: 8_000, dailyTeamCeiling: 3_000, monthlyOvertimeCap: 10_000, monthlyCostCapMicro: 50_000_000 },
};

/** Headroom above the visible allowance for our own Claude checks and redo, which the client does not see. */
const COST_CAP_HEADROOM = 1.25;
const DAYS_IN_LONGEST_MONTH = 31;

/**
 * The hidden monthly cost cap actually applied: the plan's own cap, raised when needed so it sits above
 * everything the client can see (a month of the pool, add-ons included, plus bought top-ups).
 */
export function effectiveCostCapMicro(plan: EnergyPlan, poolBonus = 0): number {
  if (plan.weeklyTeamEnergy === undefined) return plan.monthlyCostCapMicro;
  const visibleEnergy = plan.expiresAt
    ? plan.weeklyTeamEnergy + poolBonus
    : ((plan.weeklyTeamEnergy + poolBonus) * DAYS_IN_LONGEST_MONTH) / 7 + plan.monthlyOvertimeCap;
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
    return { pool, used, left, leftToday: ceiling === null ? left : Math.min(left, Math.max(0, ceiling - usedToday)), dailyCeiling: ceiling, refillsAt };
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

  /** Ask before doing work. Does not change anything. */
  check(workspaceId: string, employeeId: string): Verdict {
    const plan = this.planOf(workspaceId);
    if (plan.expiresAt && this.now().toISOString() > plan.expiresAt) return { allowed: false, reason: "trial_ended" };
    const day = this.today();
    const month = day.slice(0, 7);
    const mine = this.usage.filter((u) => u.workspaceId === workspaceId);
    const monthRows = mine.filter((u) => u.day.startsWith(month));
    if (monthRows.reduce((s, u) => s + u.costMicro, 0) >= effectiveCostCapMicro(plan, this.poolBonus(workspaceId, plan)))
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
