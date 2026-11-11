import { describe, expect, it } from "vitest";
import { defaultRegistry } from "../src/modules/integrations/catalogue.js";
import { formFor, validateAnswers } from "../src/modules/admin-manager/form.js";
import { STANDARD_TEAM, buildBlueprint } from "../src/modules/onboarding/index.js";
import { APPS, NEEDS, SECTORS, countryFacts, getSector } from "../src/modules/onboarding/sectors.js";
import { MAX_NEEDS, guessSector, planSignup, readSignupAnswers } from "../src/modules/onboarding/recommend.js";
import { getTemplate } from "../src/modules/workforce/templates.js";

const base = { businessName: "Kestrel Coffee", sector: "food-drink", needs: ["know-my-numbers", "staff"], apps: ["square", "xero"], size: "2-10" as const, country: "GB" };

describe("sector data", () => {
  it("gives every sector three starting needs and at least four apps, all of which exist", () => {
    const needKeys = new Set(NEEDS.map((n) => n.key));
    const appKeys = new Set(APPS.map((a) => a.key));
    for (const s of SECTORS) {
      expect(s.needs, s.key).toHaveLength(3);
      expect(s.apps.length, s.key).toBeGreaterThanOrEqual(4);
      for (const n of s.needs) expect(needKeys.has(n), `${s.key}:${n}`).toBe(true);
      for (const a of s.apps) expect(appKeys.has(a), `${s.key}:${a}`).toBe(true);
    }
  });
  it("is honest about how each app connects, matching the integrations registry", () => {
    const registry = defaultRegistry();
    for (const a of APPS) {
      if (a.how === "chat") continue;
      const c = registry.get(a.key);
      expect(c, a.key).toBeDefined();
      const how = c!.availability === "live" && c!.auth.kind !== "file" ? "direct" : c!.auth.kind === "file" ? "file" : "bridge";
      expect(a.how, a.key).toBe(how);
    }
  });
  it("names a real employee as the lead for every need", () => {
    for (const n of NEEDS) expect(getTemplate(n.lead), n.key).toBeDefined();
  });
  it("falls back to 'Something else' for an unknown sector", () => {
    expect(getSector("nope").key).toBe("other");
  });
});

describe("guessing the sector from a few words", () => {
  it.each([
    ["Freshly roasted coffee and cakes", "food-drink"],
    ["We are a plumbing and heating firm", "trades"],
    ["B2B SaaS for dentists", "tech"],
    ["Hair salon in Leeds", "health-beauty"],
    ["After-school tutoring", "education-care"],
    ["Something nobody has heard of", "other"],
  ])("%s -> %s", (text, sector) => {
    expect(guessSector(text)).toBe(sector);
  });
});

describe("the signup plan", () => {
  it("leads with the employees who own what the owner asked for, and keeps the rest on standby", () => {
    const plan = planSignup(base);
    expect(plan.team.filter((t) => t.focus).map((t) => t.key)).toEqual(["finance-manager", "hr-manager"]);
    expect(plan.team.map((t) => t.key).sort()).toEqual([...STANDARD_TEAM, "admin-manager"].sort());
    expect(plan.team.find((t) => t.key === "finance-manager")!.firstJob).toMatch(/cash snapshot/i);
    expect(plan.team.find((t) => t.key === "marketing-manager")!.focus).toBe(false);
  });
  it("names every employee exactly as their template does", () => {
    const plan = planSignup({ ...base, needs: ["stock"], addOns: ["supply-chain-manager"] });
    for (const m of plan.team) expect(getTemplate(m.key)?.title, m.key).toBe(m.title);
    for (const o of [...planSignup({ ...base, needs: ["raise-money", "online-presence", "staff"] }).later]) expect(getTemplate(o.key)?.title, o.key).toBe(o.title);
  });
  it("orders needs by what matters most to the sector, not by tap order", () => {
    expect(planSignup({ ...base, needs: ["cut-costs", "more-customers", "know-my-numbers"] }).needs).toEqual(["know-my-numbers", "more-customers", "cut-costs"]);
  });
  it("uses the sector's usual needs when the owner picks none", () => {
    const plan = planSignup({ ...base, needs: [] });
    expect(plan.needs).toEqual(getSector("food-drink").needs);
  });
  it("offers the stock manager as an add-on only when stock is asked for, never adding it silently", () => {
    expect(planSignup(base).addOns).toEqual([]);
    const plan = planSignup({ ...base, needs: ["stock"] });
    expect(plan.addOns.map((a) => a.key)).toEqual(["supply-chain-manager"]);
    expect(plan.addOns[0]!.reason).toMatch(/stock/i);
  });
  it("suggests a consultant for raising money and for looking better online", () => {
    expect(planSignup({ ...base, needs: ["raise-money"] }).later.map((l) => l.key)).toContain("finance-funding-consultant");
    expect(planSignup({ ...base, needs: ["online-presence"] }).later.map((l) => l.key)).toContain("web-developer");
  });
  it("lists the apps the owner ticked with an honest way to connect, and drops unknown ones", () => {
    const plan = planSignup({ ...base, apps: ["square", "brightpay", "made-up"] });
    expect(plan.apps.map((a) => [a.key, a.how])).toEqual([["square", "direct"], ["brightpay", "file"]]);
  });
  it("fills in currency and financial year from the country, and marks them as a guess", () => {
    const plan = planSignup(base);
    expect(plan.currency).toBe("GBP");
    expect(plan.prefill.answers.financialYearStart).toBe("April");
    expect(plan.prefill.source.financialYearStart).toBe("guess");
    expect(planSignup({ ...base, country: "US" }).currency).toBe("USD");
    expect(planSignup({ ...base, country: "ZZ" }).currency).toBeUndefined();
  });
  it("prefills the setup form with answers that pass the form's own validation", () => {
    const plan = planSignup({ ...base, sells: "Coffee by subscription" });
    const fields = formFor([...STANDARD_TEAM]);
    const v = validateAnswers(fields, plan.prefill.answers);
    expect(v.errors).toEqual({});
    expect(v.clean.goals).toMatch(/cash and profit/);
    expect(plan.prefill.source.goals).toBe("you");
    expect(v.clean.industry).toMatch(/food/i);
    expect(v.clean.customers).toBe("Local customers and regulars");
    expect(plan.prefill.source.customers).toBe("guess");
  });
  it("counts staff from team size only when it is certain", () => {
    expect(planSignup({ ...base, size: "solo" }).prefill.answers.staffCount).toBe(0);
    expect(planSignup(base).prefill.answers.staffCount).toBeUndefined();
  });
  it("never needs more than three taps of typing: only the business name is required", () => {
    expect(() => planSignup({ ...base, businessName: " " })).toThrow(/business name/);
    expect(planSignup({ businessName: "Acme" }).team.length).toBeGreaterThan(0);
  });
});

describe("reading signup answers from the website", () => {
  it("keeps only known needs and apps, and caps the list", () => {
    const a = readSignupAnswers({ businessName: "  Acme ", sector: "shop", needs: ["stock", "hack", 7, ...NEEDS.map((n) => n.key)], apps: ["xero", "<script>"], size: "Just me", country: "gb" });
    expect(a.businessName).toBe("Acme");
    expect(a.needs!.length).toBeLessThanOrEqual(MAX_NEEDS);
    expect(a.needs).not.toContain("hack");
    expect(a.apps).toEqual(["xero"]);
    expect(a.size).toBe("solo");
    expect(a.country).toBe("GB");
  });
  it("guesses the sector from the description when none was tapped", () => {
    expect(readSignupAnswers({ businessName: "Acme", sells: "Wood-fired pizza" }).sector).toBe("food-drink");
  });
  it("guesses the sector when 'Something else' was tapped and a few words were typed", () => {
    expect(readSignupAnswers({ businessName: "Acme", sector: "other", sells: "Mobile hair salon" }).sector).toBe("health-beauty");
    expect(planSignup({ businessName: "Acme", sector: "other", sells: "Wood-fired pizza" }).sector).toBe("food-drink");
    expect(planSignup({ businessName: "Acme", sector: "other", sells: "Mobile dog grooming" }).sector).toBe("other");
  });
  it("never reads an inherited property as a size, and drops over-long add-on keys", () => {
    const a = readSignupAnswers({ businessName: "Acme", size: "constructor", addOns: ["supply-chain-manager", "x".repeat(500)] });
    expect(a.size).toBeUndefined();
    expect(a.addOns).toEqual(["supply-chain-manager"]);
  });
  it("cuts long text and ignores wrong types", () => {
    const a = readSignupAnswers({ businessName: "x".repeat(500), sells: { a: 1 }, website: "y".repeat(900) });
    expect(a.businessName.length).toBeLessThanOrEqual(120);
    expect(a.sells).toBeUndefined();
    expect(a.website!.length).toBeLessThanOrEqual(200);
  });
});

describe("blueprint with a signup plan", () => {
  it("carries the plan so the Admin manager can prefill the setup form", () => {
    const plan = planSignup(base);
    const b = buildBlueprint({ businessName: "Kestrel Coffee", businessType: "food-drink", description: "Coffee", country: "GB", teamSize: "2-10", currency: plan.currency, plan });
    expect(b.signup?.prefill.answers.industry).toMatch(/food/i);
    expect(b.profile.currency).toBe("GBP");
    expect(countryFacts("gb")?.name).toBe("United Kingdom");
  });
});
