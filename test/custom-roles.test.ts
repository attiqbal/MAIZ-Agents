import { describe, expect, test } from "vitest";
import { allRoles, DEPARTMENTS } from "../src/modules/workforce/blueprints.js";
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
    expect(similarRoles("Payroll helper")).toContain("Payroll specialist");
    const d = draftCustomRole({ ...brief, title: "Barista trainer", purpose: "Teach new baristas our recipes" });
    expect(d.ok && d.similar.length).toBe(0);
    expect(similarRoles("Bookkeeper and accounts")).toContain("Bookkeeper");
  });

  test("the Admin manager's job description includes designing specialists and the sign-off gate", () => {
    const jd = getJobDescription("admin-manager")!;
    const areas = jd.responsibilities.map((r) => r.area);
    expect(areas).toContain("Designing new specialists");
    expect(areas).toContain("Sign-off before specialised work");
    expect(jd.authority.needsApproval).toContain("Create, change or retire a custom specialist");
  });

  test("the blueprint covers roles likely to come up later, each complete and unique", () => {
    const keys = allRoles().map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ["ai-automation-specialist", "licensing-officer", "ecommerce-manager", "rota-coordinator", "import-export-coordinator", "bookings-coordinator"]) expect(keys).toContain(k);
    const studio = DEPARTMENTS.find((d) => d.key === "creative-studio")!;
    expect(studio.roles.map((r) => r.key)).toEqual(["creative-director", "campaign-producer", "video-content-producer", "graphic-designer", "image-producer", "print-designer", "motion-designer", "copywriter"]);
    for (const r of allRoles().filter((x) => !x.jd)) {
      expect(r.duties.length, r.key).toBeGreaterThanOrEqual(3);
      expect(r.legal.length, r.key).toBeGreaterThanOrEqual(2);
      expect(r.records.length, r.key).toBeGreaterThanOrEqual(2);
    }
    expect(DEPARTMENTS.length).toBeGreaterThanOrEqual(12);
  });
});
