import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JOB_DESCRIPTIONS, getJobDescription, renderJobDescription } from "../src/modules/workforce/job-descriptions.js";
import { TEMPLATES } from "../src/modules/workforce/templates.js";
import { skillFiles } from "../src/modules/workforce/skill-files.js";
import { AuditLog } from "../src/modules/audit/index.js";
import { EventBus } from "../src/core/events.js";
import { IdentityService } from "../src/modules/identity/index.js";
import { ModelGateway } from "../src/modules/model-gateway/gateway.js";
import { WorkforceService } from "../src/modules/workforce/index.js";

describe("job descriptions", () => {
  it("exist for every employee template, with a full corporate-style JD", () => {
    expect(JOB_DESCRIPTIONS.map((j) => j.key).sort()).toEqual(TEMPLATES.map((t) => t.key).sort());
    for (const jd of JOB_DESCRIPTIONS) {
      expect(getJobDescription(jd.key)?.jobTitle).toBe(TEMPLATES.find((t) => t.key === jd.key)!.title);
      expect(jd.purpose.length).toBeGreaterThan(80);
      expect(jd.responsibilities.length).toBeGreaterThanOrEqual(3);
      expect(jd.competencies.length).toBeGreaterThanOrEqual(5);
      expect(jd.deliverables.length).toBeGreaterThanOrEqual(3);
      expect(jd.kpis.length).toBeGreaterThanOrEqual(2);
      expect(jd.authority.never.length).toBeGreaterThan(0);
      expect(jd.escalate.length).toBeGreaterThan(0);
      // Every job knows its legal requirements and keeps its required records up to date.
      expect(jd.legal.length).toBeGreaterThanOrEqual(2);
      expect(jd.records.length).toBeGreaterThanOrEqual(3);
      for (const d of jd.deliverables) expect(d.energy[0]).toBeLessThanOrEqual(d.energy[1]);
    }
  });

  it("tell the employee only about tools that work today", () => {
    const text = renderJobDescription(getJobDescription("finance-manager")!);
    expect(text).toContain("MAIZ ledger");
    expect(text).not.toContain("Xero");
  });

  it("are sent to the model with every task", async () => {
    const audit = new AuditLog();
    const bus = new EventBus();
    const identity = new IdentityService(audit, bus);
    const seen: string[] = [];
    const gateway = new ModelGateway([{ name: "spy", tiers: ["standard", "premium"], complete: async (r: any) => { seen.push(r.messages[0].content); return { text: "ok", provider: "spy", inputTokens: 1, outputTokens: 1 }; } } as any]);
    const workforce = new WorkforceService(identity, audit, bus, gateway);
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    const e = await workforce.hire("owner", ws.id, "compliance-manager");
    await workforce.assign("owner", ws.id, e.id, "What do I need to do this quarter?");
    expect(seen[0]).toContain("Your job description: Compliance manager");
    expect(seen[0]).toContain("Invent a law, section number, deadline or fine");
    expect(seen[0]).toContain("Documents and records you keep complete and up to date");
  });

  it("match the generated skills/ folder (run `npm run skills` after editing)", () => {
    for (const f of skillFiles()) expect(readFileSync(new URL(`../${f.path}`, import.meta.url), "utf8"), f.path).toBe(f.content);
  });
});

describe("org blueprints", () => {
  it("cover the big departments, and every ready-made role points at a real employee", async () => {
    const { DEPARTMENTS, allRoles } = await import("../src/modules/workforce/blueprints.js");
    expect(DEPARTMENTS.length).toBeGreaterThanOrEqual(10);
    const keys = allRoles().map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of TEMPLATES) expect(keys).toContain(t.key);
    for (const r of allRoles()) {
      if (r.jd) expect(TEMPLATES.some((t) => t.key === r.jd)).toBe(true);
      else {
        expect(r.duties.length).toBeGreaterThanOrEqual(3);
        expect(r.legal.length).toBeGreaterThan(0);
        expect(r.records.length).toBeGreaterThan(0);
      }
    }
  });

  it("let the owner hire a custom specialist trained from its blueprint, with a full JD", async () => {
    const audit = new AuditLog();
    const bus = new EventBus();
    const identity = new IdentityService(audit, bus);
    const seen: string[] = [];
    const gateway = new ModelGateway([{ name: "spy", tiers: ["standard", "premium"], complete: async (r: any) => { seen.push(r.messages[0].content); return { text: "ok", provider: "spy", inputTokens: 1, outputTokens: 1 }; } } as any]);
    const workforce = new WorkforceService(identity, audit, bus, gateway);
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    const e = await workforce.hire("owner", ws.id, "payroll-specialist");
    expect(e.name).toBe("Payroll specialist");
    await workforce.assign("owner", ws.id, e.id, "Prepare this month's payroll");
    expect(seen[0]).toContain("Your job description: Payroll specialist (Finance and accounting");
    expect(seen[0]).toContain("Payroll registers and pay slips");
    expect(getJobDescription("not-a-role")).toBeUndefined();
  });
});
