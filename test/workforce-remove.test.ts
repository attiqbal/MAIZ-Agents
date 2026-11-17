import { describe, expect, it } from "vitest";
import { AuditLog, EventBus, IdentityService, MockAdapter, ModelGateway, WorkforceService, STANDARD_TEAM, ADMIN_MANAGER } from "../src/index.js";
import { CORE_TEMPLATE_KEYS } from "../src/modules/workforce/index.js";
import type { Sink } from "../src/core/persistence.js";

async function setup() {
  const audit = new AuditLog();
  const bus = new EventBus();
  const identity = new IdentityService(audit, bus);
  const workforce = new WorkforceService(identity, audit, bus, new ModelGateway([new MockAdapter()]));
  const ws = (await identity.createWorkspace("user_ann", { name: "Kestrel Coffee" })).id;
  const other = (await identity.createWorkspace("user_bob", { name: "Northside Bikes" })).id;
  return { audit, identity, workforce, ws, other };
}

describe("taking an add-on employee off the team", () => {
  it("removes the employee from the team and from the count that sets the team's energy", async () => {
    const s = await setup();
    const core = await s.workforce.hire("user_ann", s.ws, "finance-manager");
    const extra = await s.workforce.hire("user_ann", s.ws, "supply-chain-manager");

    const removed = s.workforce.remove(s.ws, extra.id, "payment:line_ended");

    expect(removed).toBe(true);
    expect(s.workforce.team("user_ann", s.ws).map((e) => e.id)).toEqual([core.id]);
    expect(s.workforce.templatesIn(s.ws)).toEqual(["finance-manager"]);
    expect(s.workforce.countIn(s.ws)).toBe(1);
    expect(s.workforce.templateOf(extra.id)).toBeUndefined();
    expect(s.audit.list(s.ws).some((e) => e.action === "employee.removed" && e.target === extra.id)).toBe(true);
  });

  it("keeps the name of an employee who left, so their finished work can still be labelled", async () => {
    const s = await setup();
    const extra = await s.workforce.hire("user_ann", s.ws, "supply-chain-manager", "Sam");

    s.workforce.remove(s.ws, extra.id, "payment:line_ended");

    expect(s.workforce.formerName(extra.id)).toBe("Sam");
    expect(s.workforce.formerName("employee_nobody")).toBeUndefined();
  });

  it("does nothing the second time, and nothing for another client's employee or one that never existed", async () => {
    const s = await setup();
    const extra = await s.workforce.hire("user_ann", s.ws, "supply-chain-manager");
    const theirs = await s.workforce.hire("user_bob", s.other, "supply-chain-manager");

    const first = s.workforce.remove(s.ws, extra.id, "test");
    const second = s.workforce.remove(s.ws, extra.id, "test");
    const wrongClient = s.workforce.remove(s.ws, theirs.id, "test");
    const nobody = s.workforce.remove(s.ws, "employee_nobody", "test");

    expect([first, second, wrongClient, nobody]).toEqual([true, false, false, false]);
    expect(s.workforce.team("user_bob", s.other)).toHaveLength(1);
    expect(s.audit.list(s.ws).filter((e) => e.action === "employee.removed")).toHaveLength(1);
  });

  it("never removes one of the six employees every client has", async () => {
    const s = await setup();
    const core = [...STANDARD_TEAM, ADMIN_MANAGER];
    const hired = [];
    for (const key of core) hired.push(await s.workforce.hire("user_ann", s.ws, key));

    for (const e of hired) expect(() => s.workforce.remove(s.ws, e.id, "test")).toThrow(/core team/);

    expect(s.workforce.team("user_ann", s.ws)).toHaveLength(6);
    expect([...CORE_TEMPLATE_KEYS].sort()).toEqual([...core].sort());
  });

  it("stores the removal, and an employee who left stays off the team after a restart", async () => {
    const s = await setup();
    const records: { kind: string; id: string; data: any }[] = [];
    s.workforce.useSink(new Proxy({} as Sink, { get: (_t, prop) => (prop === "record" ? (_ws: string, kind: string, id: string, data: unknown) => records.push({ kind, id, data }) : () => {}) }));
    const extra = await s.workforce.hire("user_ann", s.ws, "supply-chain-manager");
    s.workforce.remove(s.ws, extra.id, "test");

    const again = await setup();
    again.workforce.restoreEmployee({ ...extra, workspaceId: again.ws });
    for (const r of records) again.workforce.restoreRemoved(r.data);

    expect(records).toEqual([{ kind: "employee_removed", id: extra.id, data: expect.objectContaining({ employeeId: extra.id }) }]);
    expect(again.workforce.team("user_ann", again.ws)).toHaveLength(0);
    expect(again.workforce.formerName(extra.id)).toBe(extra.name);
  });
});
