import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";
import { localParts, localToInstant } from "../batch/schedule.js";

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
  /**
   * Set when a client moves from the free trial to a paid plan: how many usage rows the workspace had then.
   * Those rows (the trial's) do not count against the paid pool or its daily ceiling, so the client starts
   * the paid plan with a full pool. They still count towards the hidden cost cap, which is real spend.
   */
  paidFromRow?: number;
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
const MAX_TRIAL_EXTENSION_DAYS = 90;
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
  /** When the pool refills: the client's next Monday 00:00, or null on a trial (it ends instead). */
  refillsAt: string | null;
}

/** A task's energy set aside while it runs. */
export interface EnergyHold { workspaceId: string; energy: number; overtime: boolean }

/** Expected energy of a task before a workspace has any history (a typical drafted document). */
const DEFAULT_TASK_ESTIMATE = 60;
const RECENT_TASKS = 20;

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
  /** Usage rows by workspace, so a check reads one client's rows rather than every client's. */
  private usage = new Map<string, UsageRecord[]>();
  private rowsOf(workspaceId: string): UsageRecord[] {
    return this.usage.get(workspaceId) ?? [];
  }
  /** Rows that count against the team pool and daily ceiling: everything since the client went paid. */
  private poolRowsOf(workspaceId: string): UsageRecord[] {
    const from = this.plans.get(workspaceId)?.paidFromRow;
    const rows = this.rowsOf(workspaceId);
    return from ? rows.slice(from) : rows;
  }
  private addRow(u: UsageRecord): void {
    const rows = this.usage.get(u.workspaceId);
    if (rows) rows.push(u);
    else this.usage.set(u.workspaceId, [u]);
  }
  /**
   * Energy promised to tasks that are running now, by workspace. A task is checked before it starts but only
   * pays when it ends, so without this a burst of tasks all pass the same check and overspend the pool.
   */
  private held = new Map<string, { pool: number; topUp: number }>();
  /** Energy of each workspace's last few finished tasks, to estimate what a new one will use. */
  private recent = new Map<string, number[]>();
  private sink?: Sink;

  useSink(sink: Sink): void {
    this.sink = sink;
  }

  restorePlan(workspaceId: string, plan: EnergyPlan): void {
    this.plans.set(workspaceId, plan);
  }

  restoreUsage(u: UsageRecord): void {
    this.addRow(u);
    this.recent.set(u.workspaceId, [...(this.recent.get(u.workspaceId) ?? []), u.energy].slice(-RECENT_TASKS));
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
  private windowStart(plan: EnergyPlan, workspaceId: string): string {
    if (plan.expiresAt && plan.startedAt) return plan.startedAt.slice(0, 10);
    return this.weekOf(workspaceId).date;
  }

  /** The shared team pool right now, or undefined for a plan without one. Platform-level, no user check. */
  teamEnergyOf(workspaceId: string): TeamEnergy | undefined {
    const plan = this.planOf(workspaceId);
    if (plan.weeklyTeamEnergy === undefined) return undefined;
    const from = this.windowStart(plan, workspaceId);
    const day = this.today(workspaceId);
    const rows = this.poolRowsOf(workspaceId).filter((u) => !u.overtime && u.day >= from);
    const used = rows.reduce((s, u) => s + u.energy, 0);
    const usedToday = rows.filter((u) => u.day === day).reduce((s, u) => s + u.energy, 0);
    const pool = plan.weeklyTeamEnergy + this.poolBonus(workspaceId, plan);
    const held = this.held.get(workspaceId)?.pool ?? 0;
    const left = Math.max(0, pool - used - held);
    const ceiling = plan.dailyTeamCeiling ?? null;
    const refillsAt = plan.expiresAt ? null : this.nextRefill(workspaceId).toISOString();
    const percentUsed = pool > 0 ? Math.min(100, Math.round((used / pool) * 100)) : 100;
    return {
      pool, used, left, percentUsed, topUpLeft: this.topUpLeft(workspaceId), autoReload: plan.autoReload ?? null,
      leftToday: ceiling === null ? left : Math.min(left, Math.max(0, ceiling - usedToday - held)), dailyCeiling: ceiling, refillsAt,
    };
  }

  /** Bought top-up energy not used yet. */
  topUpLeft(workspaceId: string): number {
    const bought = this.planOf(workspaceId).topUpEnergyBought ?? 0;
    const used = this.rowsOf(workspaceId).filter((u) => u.overtime).reduce((s, u) => s + u.energy, 0);
    return Math.max(0, bought - used - (this.held.get(workspaceId)?.topUp ?? 0));
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

  /** True while the client is on the free trial (it has an end date). */
  onTrial(workspaceId: string): boolean {
    return this.planOf(workspaceId).expiresAt !== undefined;
  }

  /**
   * A coupon gives a trial more days: counted from the later of today and the current end, so an ended trial
   * restarts for the days given. The trial's energy stays the same. Platform-level, no user check.
   */
  extendTrial(workspaceId: string, days: number, by: string): string {
    const plan = this.planOf(workspaceId);
    if (!plan.expiresAt) throw new EnergyError("only a free trial can be extended");
    if (!Number.isInteger(days) || days <= 0 || days > MAX_TRIAL_EXTENSION_DAYS) throw new EnergyError("trial extension is not valid");
    const from = Math.max(this.now().getTime(), Date.parse(plan.expiresAt));
    const expiresAt = new Date(from + days * 86_400_000).toISOString();
    this.savePlan(workspaceId, { ...plan, expiresAt });
    this.audit.record({ workspaceId, actor: by, action: "energy.trial_extended", data: { days, expiresAt } });
    return expiresAt;
  }

  /**
   * A coupon gives free energy. On the trial it raises the trial's shared pool (and the daily limit with it);
   * on a paid plan it is added like a bought top-up, so it rolls over and never expires. Platform-level, no user check.
   */
  grantEnergy(workspaceId: string, energy: number, by: string): void {
    if (!Number.isInteger(energy) || energy <= 0 || energy > MAX_TOP_UP_ENERGY) throw new EnergyError("energy credit is not valid");
    const plan = this.planOf(workspaceId);
    if (plan.weeklyTeamEnergy === undefined) throw new EnergyError("this plan has no shared energy pool");
    if (plan.expiresAt) {
      this.savePlan(workspaceId, { ...plan, weeklyTeamEnergy: plan.weeklyTeamEnergy + energy, dailyTeamCeiling: (plan.dailyTeamCeiling ?? plan.weeklyTeamEnergy) + energy });
    } else {
      this.savePlan(workspaceId, { ...plan, topUpEnergyBought: (plan.topUpEnergyBought ?? 0) + energy });
    }
    this.audit.record({ workspaceId, actor: by, action: "energy.credit_granted", data: { energy, trial: !!plan.expiresAt } });
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
    const month = this.today(workspaceId).slice(0, 7);
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

  /**
   * The client moves from the free trial to a paid plan (called when their first paid order is fulfilled).
   * The paid plan starts with a full pool: what the trial used is not held against it. Returns false, and
   * changes nothing, when the client is already on a paid plan, so later orders never reset the pool again.
   * Platform-level, no user check: the payment has already been taken.
   */
  switchToPaid(workspaceId: string, paid: EnergyPlan, by: string): boolean {
    const current = this.planOf(workspaceId);
    if (!current.expiresAt && current.paidFromRow !== undefined) return false;
    const rows = this.rowsOf(workspaceId).length;
    const { expiresAt: _ends, ...rest } = paid;
    const plan: EnergyPlan = { ...rest, startedAt: this.now().toISOString(), paidFromRow: rows, ...(current.autoReload ? { autoReload: current.autoReload } : {}) };
    this.savePlan(workspaceId, plan);
    this.audit.record({ workspaceId, actor: by, action: "energy.switched_to_paid", data: { trialEnergyUsed: this.rowsOf(workspaceId).filter((u) => !u.overtime).reduce((s, u) => s + u.energy, 0), weeklyTeamEnergy: plan.weeklyTeamEnergy ?? null } });
    return true;
  }

  planOf(workspaceId: string): EnergyPlan {
    return this.plans.get(workspaceId) ?? PLANS.trial!;
  }

  /** Ask before doing work. Changes nothing, except buying a pack when the client turned auto-reload on. */
  check(workspaceId: string, employeeId: string): Verdict {
    const plan = this.planOf(workspaceId);
    if (plan.expiresAt && this.now().toISOString() > plan.expiresAt) return { allowed: false, reason: "trial_ended" };
    const day = this.today(workspaceId);
    const month = day.slice(0, 7);
    const mine = this.rowsOf(workspaceId);
    const monthRows = mine.filter((u) => u.day.startsWith(month));
    const topUpThisMonth = this.topUpLeft(workspaceId) + monthRows.filter((u) => u.overtime).reduce((s, u) => s + u.energy, 0);
    if (monthRows.reduce((s, u) => s + u.costMicro, 0) >= effectiveCostCapMicro(plan, this.poolBonus(workspaceId, plan), topUpThisMonth))
      return { allowed: false, reason: "monthly_cost_cap_reached" };
    const pooled = this.poolRowsOf(workspaceId);
    const usedToday = pooled.filter((u) => u.employeeId === employeeId && u.day === day).reduce((s, u) => s + u.energy, 0);
    const team = this.teamEnergyOf(workspaceId);
    if (team) {
      // Shared pool: the daily ceiling and an agent's own cap are safety limits, not something to buy past.
      if (team.dailyCeiling !== null && team.left > 0 && team.leftToday === 0) return { allowed: false, reason: "daily_ceiling_reached" };
      // Top-up work counts towards the daily ceiling too, so an empty pool does not switch the safety limit off.
      if (team.dailyCeiling !== null && team.left === 0) {
        const allToday = pooled.filter((u) => u.day === day).reduce((s, u) => s + u.energy, 0) + this.heldTotal(workspaceId);
        if (allToday >= team.dailyCeiling) return { allowed: false, reason: "daily_ceiling_reached" };
      }
      const cap = this.agentCap(workspaceId, employeeId);
      // Same count as remainingToday: an agent's cap is measured on pool energy, not on bought top-ups.
      const poolUsedToday = pooled.filter((u) => u.employeeId === employeeId && u.day === day && !u.overtime).reduce((s, u) => s + u.energy, 0);
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

  /** What a new task for this workspace may use: the largest of its last few tasks. */
  estimateFor(workspaceId: string): number {
    const r = this.recent.get(workspaceId);
    // The largest recent task, not the average: holding a little too much only delays a task, holding too little overspends.
    return r?.length ? Math.max(1, ...r) : DEFAULT_TASK_ESTIMATE;
  }

  private heldTotal(workspaceId: string): number {
    const h = this.held.get(workspaceId);
    return h ? h.pool + h.topUp : 0;
  }

  /**
   * Sets aside the expected energy of a task that is about to run, so tasks running at the same time cannot all
   * spend the same energy. Call `release` with the result once the task has been recorded (or failed).
   */
  hold(workspaceId: string, verdict: Verdict & { allowed: true }): EnergyHold {
    const energy = this.estimateFor(workspaceId);
    const h = this.held.get(workspaceId) ?? { pool: 0, topUp: 0 };
    this.held.set(workspaceId, verdict.overtime ? { ...h, topUp: h.topUp + energy } : { ...h, pool: h.pool + energy });
    return { workspaceId, energy, overtime: verdict.overtime };
  }

  release(hold: EnergyHold): void {
    const h = this.held.get(hold.workspaceId);
    if (!h) return;
    const next = hold.overtime ? { ...h, topUp: Math.max(0, h.topUp - hold.energy) } : { ...h, pool: Math.max(0, h.pool - hold.energy) };
    if (next.pool === 0 && next.topUp === 0) this.held.delete(hold.workspaceId);
    else this.held.set(hold.workspaceId, next);
  }

  /** Energy still available to spend this week: the pool left plus unused top-ups (platform-level, no user check). */
  spendableOf(workspaceId: string): number {
    const team = this.teamEnergyOf(workspaceId);
    return team ? team.left + team.topUpLeft : Number.POSITIVE_INFINITY;
  }

  /** Record what a finished piece of work actually cost. */
  record(workspaceId: string, employeeId: string, provider: string, inputTokens: number, outputTokens: number, overtime: boolean, measuredCostMicro?: number): UsageRecord {
    // The routing gateway measures the real cost of everything done for a task (answer, checks, redo); otherwise estimate from tokens.
    const cost = measuredCostMicro ?? costMicro(provider, inputTokens, outputTokens);
    const rec: UsageRecord = {
      workspaceId,
      employeeId,
      day: this.today(workspaceId),
      provider,
      inputTokens,
      outputTokens,
      costMicro: cost,
      energy: Math.ceil(cost / MICRO_PER_ENERGY),
      overtime,
    };
    this.addRow(rec);
    this.recent.set(workspaceId, [...(this.recent.get(workspaceId) ?? []), rec.energy].slice(-RECENT_TASKS));
    this.sink?.usage(rec);
    return rec;
  }

  /** What the customer sees: energy left today for one employee. Can go negative only through overtime. */
  remainingToday(userId: string, workspaceId: string, employeeId: string): number {
    this.identity.require(userId, workspaceId, "task.read");
    const day = this.today(workspaceId);
    const used = this.poolRowsOf(workspaceId).filter((u) => u.employeeId === employeeId && u.day === day && !u.overtime).reduce((s, u) => s + u.energy, 0);
    const team = this.teamEnergyOf(workspaceId);
    if (!team) return Math.max(0, this.dailyQuota(workspaceId, employeeId) - used);
    // With a pool, an employee can use whatever the team has left today, up to its own cap if it has one.
    const cap = this.agentCap(workspaceId, employeeId);
    return cap === undefined ? team.leftToday : Math.min(team.leftToday, Math.max(0, cap - used));
  }

  /** Daily allowance of one employee (the platform owner's per-agent figure, else the plan's). */
  quotaOf(userId: string, workspaceId: string, employeeId: string): number {
    this.identity.require(userId, workspaceId, "task.read");
    return this.dailyQuota(workspaceId, employeeId);
  }

  /** Energy used by each employee on each of the last `days` days, oldest first, today last. */
  recentDays(userId: string, workspaceId: string, days: number): { days: string[]; byEmployee: Map<string, number[]> } {
    this.identity.require(userId, workspaceId, "task.read");
    const end = Date.parse(`${this.today(workspaceId)}T00:00:00Z`);
    const labels = Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
    const byEmployee = new Map<string, number[]>();
    for (const u of this.rowsOf(workspaceId)) {
      const i = labels.indexOf(u.day);
      if (i < 0) continue;
      const row = byEmployee.get(u.employeeId) ?? byEmployee.set(u.employeeId, new Array(days).fill(0)).get(u.employeeId)!;
      row[i]! += u.energy;
    }
    return { days: labels, byEmployee };
  }

  /** What we see: real cost and energy for the month. Admin/owner view. */
  monthSummary(userId: string, workspaceId: string, month = this.today(workspaceId).slice(0, 7)) {
    this.identity.require(userId, workspaceId, "workspace.manage");
    const rows = this.rowsOf(workspaceId).filter((u) => u.day.startsWith(month));
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
    const day = this.today(workspaceId);
    const rows = this.rowsOf(workspaceId).filter((u) => u.day.startsWith(day.slice(0, 7)));
    return {
      energyToday: rows.filter((u) => u.day === day).reduce((s, u) => s + u.energy, 0),
      energyMonth: rows.reduce((s, u) => s + u.energy, 0),
      costMicroMonth: rows.reduce((s, u) => s + u.costMicro, 0),
    };
  }

  /** The client's own time zone (IANA). UTC until a resolver says otherwise. */
  private zoneFor?: (workspaceId: string) => string | undefined;
  setZoneResolver(fn: (workspaceId: string) => string | undefined): void {
    this.zoneFor = fn;
  }

  private zone(workspaceId: string): string {
    const z = this.zoneFor?.(workspaceId) ?? "UTC";
    try { new Intl.DateTimeFormat("en-GB", { timeZone: z }); return z; } catch { return "UTC"; }
  }

  /** The client's calendar day, so "today" and "this week" mean their day and their Monday. */
  private today(workspaceId: string): string {
    const l = localParts(this.now(), this.zone(workspaceId));
    return `${l.y}-${String(l.m).padStart(2, "0")}-${String(l.d).padStart(2, "0")}`;
  }

  /** The client's current Monday: its calendar date, and the instant their Monday 00:00 began. */
  private weekOf(workspaceId: string): { date: string; startsAt: Date } {
    const tz = this.zone(workspaceId);
    const l = localParts(this.now(), tz);
    const day = new Date(Date.UTC(l.y, l.m - 1, l.d));
    const monday = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 86_400_000);
    return { date: monday.toISOString().slice(0, 10), startsAt: localToInstant(tz, monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), 0, 0) };
  }

  /** When the pool next refills: the client's next Monday 00:00. */
  private nextRefill(workspaceId: string): Date {
    const next = new Date(Date.parse(`${this.weekOf(workspaceId).date}T00:00:00Z`) + 7 * 86_400_000);
    return localToInstant(this.zone(workspaceId), next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
  }
}
