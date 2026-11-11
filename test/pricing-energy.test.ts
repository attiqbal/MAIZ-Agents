import { describe, expect, it } from "vitest";
import { DEFAULT_GENERAL, PriceBook, paidTeamPlan } from "../src/modules/pricing/index.js";
import { noEnergyMessage } from "../src/modules/channels/index.js";
import { CATALOGUE } from "../src/modules/store/cart.js";

describe("launch prices and team energy", () => {
  it("starts at £100 a month with 8,000 energy a week shared by the team, extra employees £20 with 2,000 more", () => {
    expect(DEFAULT_GENERAL).toMatchObject({ addOnEmployeeMonthlyGbp: 20, addOnWeeklyEnergy: 2_000 });
    expect(DEFAULT_GENERAL).toMatchObject({ basicPackageMonthlyGbp: 100, weeklyTeamEnergy: 8_000, dailyTeamCeiling: 3_000, trialTeamEnergy: 3_000 });
  });

  it("adds weekly energy for add-ons and specialists, none for the core team", () => {
    const book = new PriceBook(() => false);
    const addOn = CATALOGUE.find((i) => i.kind === "employee")!;
    const standard = CATALOGUE.find((i) => i.kind === "specialist" && i.tier === "standard")!;
    const premium = CATALOGUE.find((i) => i.kind === "specialist" && i.tier === "premium")!;
    expect(book.weeklyEnergyFor(addOn.key)).toBe(2_000);
    expect(book.weeklyEnergyFor(standard.key)).toBe(1_500);
    expect(book.weeklyEnergyFor(premium.key)).toBe(2_500);
    expect(book.weeklyEnergyFor("finance-manager")).toBe(0);
    expect(book.weeklyEnergyFor("admin-manager")).toBe(0);
  });

  it("builds a paid plan from the owner's pool settings", () => {
    const plan = paidTeamPlan({ ...DEFAULT_GENERAL, weeklyTeamEnergy: 20_000, dailyTeamCeiling: 6_000 });
    expect(plan).toMatchObject({ weeklyTeamEnergy: 20_000, dailyTeamCeiling: 6_000 });
    expect(plan.expiresAt).toBeUndefined();
  });

  it("tells the client what happens next for every energy limit", () => {
    expect(noEnergyMessage("weekly_pool_used")).toMatch(/Monday/);
    expect(noEnergyMessage("daily_ceiling_reached")).toMatch(/tomorrow/);
    expect(noEnergyMessage("trial_ended")).toMatch(/trial/);
    expect(noEnergyMessage("overtime_cap_reached")).toMatch(/Monday/);
  });
});
