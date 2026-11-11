import { describe, expect, it } from "vitest";
import { AuditLog, EnergyMeter, EventBus, IdentityService, ModelGateway, PermissionError, WorkforceService, costMicro } from "../src/index.js";
import { PLANS, effectiveCostCapMicro, weekStart, type EnergyPlan } from "../src/modules/energy/index.js";

/** A plan without a team pool: each employee has its own daily quota (plans made before the pool). */
const PER_EMPLOYEE: EnergyPlan = { dailyQuotaPerEmployee: 300, monthlyOvertimeCap: 0, monthlyCostCapMicro: 5_000_000 };
import type { CompletionResult, ModelAdapter } from "../src/modules/model-gateway/types.js";

class Fixed implements ModelAdapter {
  readonly name = "anthropic";
  readonly tiers = ["standard", "premium"] as const;
  constructor(private inTok: number, private outTok: number) {}
  async complete(): Promise<CompletionResult> {
    return { text: "ok", provider: "anthropic", model: "m", inputTokens: this.inTok, outputTokens: this.outTok };
  }
}

async function setup(inTok = 1000, outTok = 1000, clock = { d: new Date("2026-03-10T10:00:00Z") }, plan: EnergyPlan | undefined = PER_EMPLOYEE) {
  const audit = new AuditLog();
  const bus = new EventBus();
  const identity = new IdentityService(audit, bus);
  const energy = new EnergyMeter(identity, audit, () => clock.d);
  const wf = new WorkforceService(identity, audit, bus, new ModelGateway([new Fixed(inTok, outTok)]), energy);
  const ws = await identity.createWorkspace("owner", { name: "Acme" });
  const emp = await wf.hire("owner", ws.id, "marketing-manager");
  if (plan) energy.setPlan("owner", ws.id, plan);
  return { identity, energy, wf, ws: ws.id, emp: emp.id, clock };
}

describe("energy", () => {
  it("converts real cost into energy (1 energy = $0.001)", () => {
    expect(costMicro("anthropic", 1000, 1000)).toBe(6000);
    expect(costMicro("mock", 5000, 5000)).toBe(0);
    expect(costMicro("openai-compatible", 1000, 1000)).toBeLessThan(costMicro("anthropic", 1000, 1000));
  });

  it("records energy on each task and shows what is left today", async () => {
    const { wf, energy, ws, emp } = await setup();
    const t = await wf.assign("owner", ws, emp, "post ideas");
    expect(t.status).toBe("ready_for_review");
    expect(t.energyUsed).toBe(6);
    expect(energy.remainingToday("owner", ws, emp)).toBe(300 - 6);
  });

  it("stops work when the daily quota is used (trial has no overtime)", async () => {
    const { wf, ws, emp } = await setup(40_000, 20_000); // 140 energy per task
    expect((await wf.assign("owner", ws, emp, "a")).status).toBe("ready_for_review");
    expect((await wf.assign("owner", ws, emp, "b")).status).toBe("ready_for_review");
    expect((await wf.assign("owner", ws, emp, "c")).status).toBe("ready_for_review"); // 280 < 300 before this one
    const blocked = await wf.assign("owner", ws, emp, "d");
    expect(blocked).toMatchObject({ status: "no_energy", reason: "daily_quota_used" });
  });

  it("quota resets the next day", async () => {
    const { wf, ws, emp, clock } = await setup(400_000, 0);
    await wf.assign("owner", ws, emp, "a");
    expect((await wf.assign("owner", ws, emp, "b")).status).toBe("no_energy");
    clock.d = new Date("2026-03-11T00:05:00Z");
    expect((await wf.assign("owner", ws, emp, "c")).status).toBe("ready_for_review");
  });

  it("allows paid overtime up to a cap, then stops", async () => {
    const { wf, energy, ws, emp } = await setup(400_000, 0); // 400 energy per task
    energy.setPlan("owner", ws, { dailyQuotaPerEmployee: 300, monthlyOvertimeCap: 500, monthlyCostCapMicro: 1e12 });
    await wf.assign("owner", ws, emp, "a"); // uses quota (400 > 300)
    const o1 = await wf.assign("owner", ws, emp, "b"); // overtime 400
    expect(o1.status).toBe("ready_for_review");
    await wf.assign("owner", ws, emp, "c"); // overtime 800 (started under cap of 500)
    expect(await wf.assign("owner", ws, emp, "d")).toMatchObject({ status: "no_energy", reason: "overtime_cap_reached" });
    expect(energy.monthSummary("owner", ws).overtimeEnergy).toBe(800);
  });

  it("monthly cost cap protects margin even with overtime", async () => {
    const { wf, energy, ws, emp } = await setup(400_000, 0);
    energy.setPlan("owner", ws, { dailyQuotaPerEmployee: 1e9, monthlyOvertimeCap: 0, monthlyCostCapMicro: 700_000 });
    await wf.assign("owner", ws, emp, "a");
    await wf.assign("owner", ws, emp, "b");
    expect(await wf.assign("owner", ws, emp, "c")).toMatchObject({ reason: "monthly_cost_cap_reached" });
  });

  it("only owners see cost; members see energy", async () => {
    const { identity, energy, ws, emp } = await setup();
    identity.addMember("owner", ws, "m", "member");
    expect(energy.remainingToday("m", ws, emp)).toBe(300);
    expect(() => energy.monthSummary("m", ws)).toThrow(PermissionError);
    expect(() => energy.setPlan("m", ws, { dailyQuotaPerEmployee: 1, monthlyOvertimeCap: 0, monthlyCostCapMicro: 1 })).toThrow(PermissionError);
  });
});

describe("team energy pool", () => {
  // 2026-03-10 is a Tuesday; the week runs from Monday 2026-03-09.
  const PAID: EnergyPlan = { ...PLANS.starter! };

  it("starts the week on Monday 00:00 UTC", () => {
    expect(weekStart(new Date("2026-03-10T10:00:00Z")).toISOString()).toBe("2026-03-09T00:00:00.000Z");
    expect(weekStart(new Date("2026-03-15T23:59:00Z")).toISOString()).toBe("2026-03-09T00:00:00.000Z");
    expect(weekStart(new Date("2026-03-16T00:00:00Z")).toISOString()).toBe("2026-03-16T00:00:00.000Z");
  });

  it("lets one employee use the team's energy beyond the old per-employee daily amount", async () => {
    const { wf, energy, ws, emp } = await setup(500_000, 0, undefined, PAID); // 500 energy per task
    for (const b of ["a", "b", "c"]) expect((await wf.assign("owner", ws, emp, b)).status).toBe("ready_for_review");
    const team = energy.teamEnergy("owner", ws)!;
    expect(team).toMatchObject({ pool: 8_000, used: 1_500, left: 6_500, leftToday: 1_500, dailyCeiling: 3_000, refillsAt: "2026-03-16T00:00:00.000Z" });
    expect(energy.remainingToday("owner", ws, emp)).toBe(1_500);
  });

  it("stops at the daily ceiling, then carries on the next day from the same week", async () => {
    const { wf, energy, ws, emp, clock } = await setup(1_000_000, 0, undefined, PAID); // 1,000 per task
    for (const b of ["a", "b", "c"]) await wf.assign("owner", ws, emp, b);
    expect(await wf.assign("owner", ws, emp, "d")).toMatchObject({ status: "no_energy", reason: "daily_ceiling_reached" });
    clock.d = new Date("2026-03-11T09:00:00Z");
    expect((await wf.assign("owner", ws, emp, "e")).status).toBe("ready_for_review");
    expect(energy.teamEnergy("owner", ws)!.left).toBe(4_000);
  });

  it("stops when the weekly pool is used and refills on Monday", async () => {
    const { wf, energy, ws, emp, clock } = await setup(1_000_000, 0, undefined, { ...PAID, monthlyOvertimeCap: 0, dailyTeamCeiling: undefined });
    for (let i = 0; i < 8; i++) await wf.assign("owner", ws, emp, `t${i}`);
    expect(await wf.assign("owner", ws, emp, "x")).toMatchObject({ status: "no_energy", reason: "weekly_pool_used" });
    clock.d = new Date("2026-03-16T00:01:00Z");
    expect((await wf.assign("owner", ws, emp, "y")).status).toBe("ready_for_review");
    expect(energy.teamEnergy("owner", ws)!.used).toBe(1_000);
  });

  it("uses bought top-ups (overtime) once the pool is empty", async () => {
    const { wf, energy, ws, emp } = await setup(1_000_000, 0, undefined, { ...PAID, weeklyTeamEnergy: 1_000, dailyTeamCeiling: undefined, monthlyOvertimeCap: 1_000 });
    await wf.assign("owner", ws, emp, "a");
    expect((await wf.assign("owner", ws, emp, "b")).status).toBe("ready_for_review");
    expect(energy.monthSummary("owner", ws).overtimeEnergy).toBe(1_000);
    expect(await wf.assign("owner", ws, emp, "c")).toMatchObject({ reason: "overtime_cap_reached" });
  });

  it("adds add-on energy to a paid pool but not to a trial", async () => {
    const { energy, ws } = await setup(1, 1, undefined, PAID);
    energy.setPoolBonusResolver(() => 2_500);
    expect(energy.teamEnergyOf(ws)!.pool).toBe(10_500);
    energy.setPlan("owner", ws, { ...PLANS.trial!, startedAt: "2026-03-10T09:00:00Z", expiresAt: "2026-03-17T09:00:00Z" });
    expect(energy.teamEnergyOf(ws)).toMatchObject({ pool: 3_000, refillsAt: null });
  });

  it("gives a trial one pool for the whole trial, even across a Monday", async () => {
    const clock = { d: new Date("2026-03-14T10:00:00Z") }; // Saturday
    const { wf, energy, ws, emp } = await setup(1_000_000, 0, clock, { ...PLANS.trial!, startedAt: "2026-03-14T09:00:00Z", expiresAt: "2026-03-21T09:00:00Z" });
    for (const b of ["a", "b"]) await wf.assign("owner", ws, emp, b);
    clock.d = new Date("2026-03-16T10:00:00Z"); // Monday: no refill during a trial
    await wf.assign("owner", ws, emp, "c");
    expect(await wf.assign("owner", ws, emp, "d")).toMatchObject({ reason: "weekly_pool_used" });
    expect(energy.teamEnergyOf(ws)!.left).toBe(0);
  });

  it("holds an agent to its own daily cap only when the platform owner set one", async () => {
    const { wf, energy, ws, emp } = await setup(500_000, 0, undefined, PAID);
    energy.setQuotaResolver(() => 500);
    await wf.assign("owner", ws, emp, "a");
    expect(energy.remainingToday("owner", ws, emp)).toBe(0);
    expect(await wf.assign("owner", ws, emp, "b")).toMatchObject({ reason: "daily_quota_used" });
  });

  it("never lets the hidden cost cap stop work before the visible pool and top-ups run out", () => {
    for (const [name, plan] of Object.entries(PLANS)) {
      for (const bonus of [0, 1_000, 20_000]) {
        const trial = name === "trial";
        const visible = trial ? plan.weeklyTeamEnergy! : ((plan.weeklyTeamEnergy! + bonus) * 31) / 7 + plan.monthlyOvertimeCap;
        expect(effectiveCostCapMicro(trial ? { ...plan, expiresAt: "2099-01-01T00:00:00Z" } : plan, trial ? 0 : bonus)).toBeGreaterThan(visible * 1_000);
      }
    }
  });
});
