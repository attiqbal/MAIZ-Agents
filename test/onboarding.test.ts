import { describe, expect, it } from "vitest";
import { AuditLog, EnergyMeter, EventBus, IdentityService, Ledger, MockAdapter, ModelGateway, OnboardingService, SignupError, WorkforceService, buildBlueprint } from "../src/index.js";

const base = { businessName: "Acme", businessType: "startup", description: "We sell tea", country: "GB", teamSize: "2-10" as const };

function setup(clock = { d: new Date("2026-05-01T12:00:00Z") }) {
  const audit = new AuditLog();
  const bus = new EventBus();
  const identity = new IdentityService(audit, bus);
  const energy = new EnergyMeter(identity, audit, () => clock.d);
  const wf = new WorkforceService(identity, audit, bus, new ModelGateway([new MockAdapter()]), energy);
  const ledger = new Ledger(identity, audit);
  return { clock, identity, wf, ledger, energy, onboarding: new OnboardingService(identity, wf, ledger, energy, audit, () => clock.d) };
}

describe("blueprint", () => {
  it("always includes the five basic-package employees and waitlists unbuilt add-ons", () => {
    const b = buildBlueprint({ ...base, addOns: ["video-editor", "finance-manager", "admin-manager"] });
    expect(b.employees).toEqual(["finance-manager", "marketing-manager", "business-consultant", "hr-manager", "compliance-manager"]);
    expect(b.waitlist).toEqual(["video-editor"]);
    expect(b.trialDays).toBe(7);
  });
  it("sizes assistants by company size or volume", () => {
    expect(buildBlueprint(base).assistants).toEqual({ finance: 0, marketing: 0 });
    expect(buildBlueprint({ ...base, teamSize: "11-50" }).assistants.finance).toBe(2);
    expect(buildBlueprint({ ...base, monthlyVolume: 900 }).assistants.finance).toBe(2);
  });
  it("gives own database free for 6+ months prepaid or 51+ team, not otherwise", () => {
    expect(buildBlueprint(base).privacy).toBe("shared");
    expect(buildBlueprint({ ...base, prepaidMonths: 5 }).privacy).toBe("shared");
    expect(buildBlueprint({ ...base, prepaidMonths: 6 }).privacy).toBe("own-database");
    expect(buildBlueprint({ ...base, teamSize: "51+" }).privacy).toBe("own-database");
    expect(buildBlueprint({ ...base, privacy: "own-server" }).privacy).toBe("own-server");
  });
  it("contacts the owner on the dashboard unless they chose a chat app they can use", () => {
    expect(buildBlueprint(base).contact).toBe("dashboard");
    expect(buildBlueprint({ ...base, contact: "slack" }).contact).toBe("slack");
    expect(buildBlueprint({ ...base, contact: "teams" }).contact).toBe("dashboard");
    expect(buildBlueprint({ ...base, contact: "teams", addOns: ["teams"] }).contact).toBe("teams");
  });
  it("rejects missing basics", () => {
    expect(() => buildBlueprint({ ...base, businessName: " " })).toThrow(SignupError);
    expect(() => buildBlueprint({ ...base, country: "" })).toThrow(SignupError);
  });
});

describe("signUp", () => {
  it("provisions workspace, team, books and a 7-day trial in one step", async () => {
    const { onboarding, wf, ledger, energy, clock } = setup();
    const org = await onboarding.signUp("founder", base);
    expect(wf.team("founder", org.workspaceId)).toHaveLength(6); // 5 employees + free Admin manager
    expect(org.employeeIds).toHaveLength(5);
    expect(wf.team("founder", org.workspaceId).find((e) => e.id === org.adminManagerId)?.templateKey).toBe("admin-manager");
    expect(ledger.chart("founder", org.workspaceId).length).toBeGreaterThan(5);
    expect(org.trialEndsAt).toBe("2026-05-08T12:00:00.000Z");
    const t = await wf.assign("founder", org.workspaceId, org.employeeIds[0]!, "hello");
    expect(t.status).toBe("ready_for_review");
    clock.d = new Date("2026-05-08T12:00:01Z");
    expect(await wf.assign("founder", org.workspaceId, org.employeeIds[0]!, "again")).toMatchObject({ status: "no_energy", reason: "trial_ended" });
    expect(energy.planOf(org.workspaceId).expiresAt).toBe(org.trialEndsAt);
  });
  it("keeps two customers separate", async () => {
    const { onboarding, wf } = setup();
    const a = await onboarding.signUp("a", base);
    const b = await onboarding.signUp("b", { ...base, businessName: "Beta" });
    expect(() => wf.team("a", b.workspaceId)).toThrow();
    expect(a.workspaceId).not.toBe(b.workspaceId);
  });
});
