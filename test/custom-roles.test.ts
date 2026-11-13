import { describe, expect, test } from "vitest";
import { allRoles, DEPARTMENTS, getBlueprint, LEGACY_SPECIALIST_KEYS, specialistHires } from "../src/modules/workforce/blueprints.js";
import { draftCustomRole, similarRoles } from "../src/modules/workforce/custom-roles.js";
import { getJobDescription } from "../src/modules/workforce/job-descriptions.js";

const brief = {
  title: "Wholesale account coordinator",
  purpose: "Look after cafes that buy our coffee in bulk",
  duties: ["Prepare wholesale price lists", "Chase repeat orders each month", "Prepare wholesale price lists"],
};

describe("Admin manager's role designer", () => {
  test("turns an owner's brief into a role with a full job description", () => {
    const d = draftCustomRole(brief);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.role.key).toBe("custom-wholesale-account-coordinator");
    expect(d.role.duties).toEqual(["Prepare wholesale price lists", "Chase repeat orders each month"]);
    expect(d.role.purpose.endsWith(".")).toBe(true);
    expect(d.jobDescription.jobTitle).toBe("Wholesale account coordinator");
    expect(d.jobDescription.legal.length).toBeGreaterThan(0);
    expect(d.jobDescription.records.length).toBeGreaterThan(0);
    expect(d.jobDescription.authority.never).toContain("Spend or move money");
    expect(d.jobDescription.authority.needsApproval.length).toBeGreaterThan(0);
  });

  test("refuses a brief that is too thin and says what is missing", () => {
    const d = draftCustomRole({ title: "X", purpose: "", duties: ["one"] });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.problems).toHaveLength(3);
  });

  test("refuses a title with no letters or numbers and overlong input", () => {
    expect(draftCustomRole({ ...brief, title: "!!!!" }).ok).toBe(false);
    expect(draftCustomRole({ ...brief, title: "a".repeat(61) }).ok).toBe(false);
    expect(draftCustomRole({ ...brief, duties: Array.from({ length: 13 }, (_, i) => `Duty ${i}`) }).ok).toBe(false);
  });

  test("flags regulated work, limits the role and uses the premium lane", () => {
    const d = draftCustomRole({ title: "Tax helper", purpose: "Give tax advice to the owner each quarter", duties: ["Prepare figures", "Explain the rules"] });
    expect(d.ok && d.role.tier).toBe("premium");
    expect(d.ok && d.notes.some((n) => n.includes("qualified professional"))).toBe(true);
    expect(d.ok && draftCustomRole(brief).ok && d.jobDescription.authority.never).toContain("Give legal, tax or medical advice");
  });

  test("points out existing roles that may already cover the job", () => {
    expect(similarRoles("Payroll helper")).toContain("Wealth and savings (includes Payroll specialist)");
    const d = draftCustomRole({ ...brief, title: "Barista trainer", purpose: "Teach new baristas our recipes" });
    expect(d.ok && d.similar.length).toBe(0);
    expect(similarRoles("Bookkeeper and accounts")).toContain("Wealth and savings (includes Bookkeeper)");
  });

  test("the Admin manager's job description includes designing specialists and the sign-off gate", () => {
    const jd = getJobDescription("admin-manager")!;
    const areas = jd.responsibilities.map((r) => r.area);
    expect(areas).toContain("Designing new specialists");
    expect(areas).toContain("Sign-off before specialised work");
    expect(jd.authority.needsApproval).toContain("Create, change or retire a custom specialist");
  });

  test("specialist hires: exactly 12, one per department, each merging its old one-job roles", () => {
    const keys = allRoles().map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    const hires = specialistHires();
    expect(hires.map((h) => h.role.title)).toEqual([
      "Creative studio", "Social media and content", "PR and communications", "Sales and business development",
      "Customer service and reception", "Executive and office support", "Wealth and savings", "Fundraising and investor relations",
      "Legal and contracts", "Operations and logistics", "Technology and data", "Product and research",
    ]);
    expect(DEPARTMENTS).toHaveLength(12);
    for (const d of DEPARTMENTS) expect(d.roles.filter((r) => !r.jd), d.key).toHaveLength(1);
    expect(hires.find((h) => h.role.key === "creative-studio")!.role.covers).toContain("Motion and animation designer");
    expect(hires.find((h) => h.role.key === "customer-service-reception")!.role.covers).toContain("Receptionist");
    expect(hires.find((h) => h.role.key === "wealth-savings")!.role.legal[0]).toMatch(/^Not regulated financial advice/);
    for (const { role } of hires) {
      expect(role.duties.length, role.key).toBeGreaterThanOrEqual(3);
      expect(role.legal.length, role.key).toBeGreaterThanOrEqual(2);
      expect(role.records.length, role.key).toBeGreaterThanOrEqual(2);
      expect(role.covers!.length, role.key).toBeGreaterThanOrEqual(1);
    }
  });

  test("old one-job specialist keys still resolve to the hire that now does the work", () => {
    for (const [old, hire] of Object.entries(LEGACY_SPECIALIST_KEYS)) expect(getBlueprint(old)?.role.key, old).toBe(hire);
    expect(getBlueprint("ai-automation-specialist")?.role.title).toBe("Technology and data");
    expect(getBlueprint("bookkeeper")?.role.title).toBe("Wealth and savings");
  });
});
