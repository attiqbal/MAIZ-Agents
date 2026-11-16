import { localParts, localToInstant } from "../batch/schedule.js";
import type { EnergyMeter } from "../energy/index.js";
import type { JobStore } from "./jobs.js";
import type { AgentConnection, AgentEnergy } from "./types.js";

/** Older plans have no weekly team pool, only a daily amount per employee: a week of one employee stands in for it. */
const DAYS_IN_WEEK = 7;

export interface BudgetDeps {
  energy: Pick<EnergyMeter, "teamEnergyOf" | "planOf">;
  /** The client's own time zone. UTC when not given or not a real zone. */
  timezone?: (workspaceId: string) => string | undefined;
  now: () => Date;
}

/**
 * What a connection may spend. Its limits are percentages of the team's weekly energy pool, turned into energy here,
 * and "today" is the client's own calendar day, the same day the team's energy meter uses. Reads only: nothing is
 * held, charged or bought here. The energy itself is charged by the workforce when a job runs.
 */
export class AgentBudget {
  constructor(private readonly d: BudgetDeps, private readonly jobs: JobStore) {}

  /** The team's weekly energy pool, add-ons included. */
  pool(workspaceId: string): number {
    return this.d.energy.teamEnergyOf(workspaceId)?.pool ?? this.d.energy.planOf(workspaceId).dailyQuotaPerEmployee * DAYS_IN_WEEK;
  }

  of(c: AgentConnection): AgentEnergy {
    const weeklyPool = this.pool(c.workspaceId);
    const dailyCeiling = Math.max(1, Math.floor((weeklyPool * c.limits.dailyPercent) / 100));
    const perJobCap = Math.max(1, Math.floor((weeklyPool * c.limits.perJobPercent) / 100));
    const usedToday = this.jobs.usedOn(c.id, this.dayOf(c.workspaceId));
    return { weeklyPool, dailyCeiling, perJobCap, usedToday, leftToday: Math.max(0, dailyCeiling - usedToday), resetsAt: this.nextMidnight(c.workspaceId) };
  }

  /** Set when the whole team has nothing left to spend, with when that changes (null: it does not refill by itself). */
  teamEmpty(workspaceId: string): { resetsAt: string | null } | undefined {
    const plan = this.d.energy.planOf(workspaceId);
    if (plan.expiresAt && this.d.now().toISOString() > plan.expiresAt) return { resetsAt: null };
    const team = this.d.energy.teamEnergyOf(workspaceId);
    return team && team.left === 0 && team.topUpLeft === 0 && !team.autoReload?.enabled ? { resetsAt: team.refillsAt } : undefined;
  }

  /** The client's calendar day (YYYY-MM-DD), so "today" is their day and not the server's. */
  dayOf(workspaceId: string): string {
    const l = localParts(this.d.now(), this.zone(workspaceId));
    return `${l.y}-${String(l.m).padStart(2, "0")}-${String(l.d).padStart(2, "0")}`;
  }

  private nextMidnight(workspaceId: string): string {
    const tz = this.zone(workspaceId);
    const l = localParts(this.d.now(), tz);
    const next = new Date(Date.UTC(l.y, l.m - 1, l.d + 1));
    return localToInstant(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0).toISOString();
  }

  private zone(workspaceId: string): string {
    const z = this.d.timezone?.(workspaceId) ?? "UTC";
    try { new Intl.DateTimeFormat("en-GB", { timeZone: z }); return z; } catch { return "UTC"; }
  }
}
