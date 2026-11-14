import { describe, expect, it } from "vitest";
import { defaultRegistry } from "../src/modules/integrations/catalogue.js";
import { PERSONAS, connectOptions, introLines, personaFor } from "../src/modules/onboarding/people.js";
import { TEMPLATES } from "../src/modules/workforce/templates.js";

describe("team personas", () => {
  it("gives every ready-made role a unique first name and avatar", () => {
    for (const t of TEMPLATES.filter((x) => x.kind === "employee" || x.kind === "manager")) expect(PERSONAS.some((p) => p.key === t.key), t.key).toBe(true);
    expect(new Set(PERSONAS.map((p) => p.name)).size).toBe(PERSONAS.length);
  });
  it("says what each person will not do and fills in the business name", () => {
    for (const p of PERSONAS) {
      const lines = introLines(p, "Kestrel Coffee");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.join(" ")).not.toContain("{biz}");
    }
    expect(introLines(personaFor("admin-manager"), "Kestrel Coffee").join(" ")).toContain("Kestrel Coffee");
  });
  it("falls back to the role title for a custom specialist", () => {
    const p = personaFor("specialist:legal", "Legal adviser");
    expect(p.name).toBe("Legal adviser");
    expect(introLines(p, "X").length).toBeGreaterThan(0);
  });
  it("offers the apps the owner uses first, then direct ones, only in the person's categories", () => {
    const cat = defaultRegistry().list().map((c) => ({ key: c.key, name: c.name, category: c.category, summary: c.summary, availability: c.availability }));
    const finance = connectOptions(personaFor("finance-manager"), cat, ["square"]);
    expect(finance[0]!.key).toBe("square");
    expect(finance.every((a) => ["accounting", "payments", "till", "ecommerce"].includes(a.category))).toBe(true);
    expect(connectOptions(personaFor("marketing-manager"), cat, [])).toEqual([]);
    expect(connectOptions(personaFor("hr-manager"), cat, []).every((a) => a.category === "payroll")).toBe(true);
  });
});
