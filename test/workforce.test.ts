import { describe, expect, it } from "vitest";
import {
  AuditLog,
  EventBus,
  IdentityService,
  MockAdapter,
  ModelGateway,
  PermissionError,
  EMPLOYEE_TEMPLATES,
  TEMPLATES,
  WorkforceService,
  packFor,
  registerPack,
} from "../src/index.js";
import type { CompletionRequest, CompletionResult, ModelAdapter } from "../src/modules/model-gateway/types.js";

function setup(adapters: ModelAdapter[] = [new MockAdapter()]) {
  const audit = new AuditLog();
  const bus = new EventBus();
  const identity = new IdentityService(audit, bus);
  const workforce = new WorkforceService(identity, audit, bus, new ModelGateway(adapters));
  return { audit, bus, identity, workforce };
}

class Recorder implements ModelAdapter {
  readonly name = "recorder";
  readonly tiers = ["standard", "premium"] as const;
  last?: CompletionRequest;
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.last = req;
    return { text: "draft", provider: "recorder", model: "r", inputTokens: 5, outputTokens: 7 };
  }
}

describe("templates", () => {
  it("has the five basic-package employees plus the free Admin manager", () => {
    expect(EMPLOYEE_TEMPLATES.map((t) => t.key).sort()).toEqual(["business-consultant", "compliance-manager", "finance-manager", "hr-manager", "marketing-manager"]);
    expect(TEMPLATES.filter((t) => t.kind === "manager").map((t) => t.key)).toEqual(["admin-manager"]);
  });
  it("every template lists plain-language capabilities and a first job", () => {
    for (const t of TEMPLATES) {
      expect(t.capabilities.length).toBeGreaterThanOrEqual(3);
      expect(t.firstJob).toBeTruthy();
    }
  });
});

describe("hiring", () => {
  it("owner can hire, and it is audited", async () => {
    const { identity, workforce, audit } = setup();
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    const e = await workforce.hire("owner", ws.id, "marketing-manager");
    expect(e.name).toBe("Marketing manager");
    expect(audit.list(ws.id).map((x) => x.action)).toContain("employee.hired");
  });

  it("members and outsiders cannot hire", async () => {
    const { identity, workforce } = setup();
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    identity.addMember("owner", ws.id, "m", "member");
    await expect(workforce.hire("m", ws.id, "marketing-manager")).rejects.toThrow(PermissionError);
    await expect(workforce.hire("stranger", ws.id, "marketing-manager")).rejects.toThrow(PermissionError);
  });

  it("rejects unknown templates", async () => {
    const { identity, workforce } = setup();
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    await expect(workforce.hire("owner", ws.id, "nope")).rejects.toThrow(/unknown employee template/);
  });
});

describe("assigning work", () => {
  it("returns a draft for review and records usage", async () => {
    const { identity, workforce, audit } = setup();
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    const e = await workforce.hire("owner", ws.id, "marketing-manager");
    const t = await workforce.assign("owner", ws.id, e.id, "Write a launch post");
    expect(t.status).toBe("ready_for_review");
    expect(t.deliverable).toContain("Write a launch post");
    expect(audit.list(ws.id).map((x) => x.action)).toEqual(
      expect.arrayContaining(["task.created", "task.completed"]),
    );
  });

  it("gives the model the role instructions and the business profile", async () => {
    const rec = new Recorder();
    const { identity, workforce } = setup([rec]);
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    workforce.setProfile("owner", ws.id, { description: "A bakery in Lagos", tone: "warm" });
    const e = await workforce.hire("owner", ws.id, "marketing-manager");
    await workforce.assign("owner", ws.id, e.id, "Write a post");
    const system = rec.last?.messages[0]?.content ?? "";
    expect(system).toContain("Marketing manager");
    expect(system).toContain("A bakery in Lagos");
  });

  it("finance work asks for the premium tier", async () => {
    const rec = new Recorder();
    const { identity, workforce } = setup([rec]);
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    const e = await workforce.hire("owner", ws.id, "finance-manager");
    await workforce.assign("owner", ws.id, e.id, "Forecast cash");
    expect(rec.last?.tier).toBe("premium");
  });

  it("another workspace cannot use my employee", async () => {
    const { identity, workforce } = setup();
    const a = await identity.createWorkspace("alice", { name: "A" });
    const b = await identity.createWorkspace("bob", { name: "B" });
    const e = await workforce.hire("alice", a.id, "business-consultant");
    await expect(workforce.assign("bob", b.id, e.id, "Research")).rejects.toThrow(/employee not found/);
    await expect(workforce.assign("bob", a.id, e.id, "Research")).rejects.toThrow(PermissionError);
  });

  it("viewers cannot assign work", async () => {
    const { identity, workforce } = setup();
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    identity.addMember("owner", ws.id, "v", "viewer");
    const e = await workforce.hire("owner", ws.id, "business-consultant");
    await expect(workforce.assign("v", ws.id, e.id, "Research")).rejects.toThrow(PermissionError);
  });

  it("marks the task failed, not crashed, when every model is down", async () => {
    const { identity, workforce, audit } = setup([new MockAdapter("down", ["standard", "premium"], true)]);
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    const e = await workforce.hire("owner", ws.id, "marketing-manager");
    const t = await workforce.assign("owner", ws.id, e.id, "Post");
    expect(t.status).toBe("failed");
    expect(audit.list(ws.id).map((x) => x.action)).toContain("task.failed");
  });
});

describe("finance rules packs", () => {
  it("finance manager gets bookkeeping rules and a no-tax-advice instruction", async () => {
    const rec = new Recorder();
    const { identity, workforce } = setup([rec]);
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    const e = await workforce.hire("owner", ws.id, "finance-manager");
    await workforce.assign("owner", ws.id, e.id, "Record this month's sales");
    const system = rec.last?.messages[0]?.content ?? "";
    expect(system).toContain("double-entry");
    expect(system).toContain("You do NOT give tax advice");
    expect(system).toContain("NOT been reviewed");
  });

  it("uses a country pack when one is registered, and says whether it was reviewed", async () => {
    registerPack({
      country: "ZZ",
      name: "Testland",
      reviewed: true,
      recordKeeping: ["Keep invoices in Testland format."],
      doNotGuess: ["Testland tax rates"],
    });
    const rec = new Recorder();
    const { identity, workforce } = setup([rec]);
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    workforce.setProfile("owner", ws.id, { description: "Shop", country: "zz" });
    const e = await workforce.hire("owner", ws.id, "finance-manager");
    await workforce.assign("owner", ws.id, e.id, "Book a sale");
    const system = rec.last?.messages[0]?.content ?? "";
    expect(system).toContain("Testland");
    expect(system).toContain("reviewed by a qualified accountant");
  });

  it("falls back to the generic pack for an unknown country", () => {
    expect(packFor("XX").country).toBe("GENERIC");
    expect(packFor(undefined).country).toBe("GENERIC");
  });

  it("other employees do not receive finance rules", async () => {
    const rec = new Recorder();
    const { identity, workforce } = setup([rec]);
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    const e = await workforce.hire("owner", ws.id, "marketing-manager");
    await workforce.assign("owner", ws.id, e.id, "Post");
    expect(rec.last?.messages[0]?.content).not.toContain("double-entry");
  });
});

describe("deliverable length", () => {
  it("allows long deliverables instead of the small default", async () => {
    const rec = new Recorder();
    const { identity, workforce } = setup([rec]);
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    const e = await workforce.hire("owner", ws.id, "marketing-manager");
    await workforce.assign("owner", ws.id, e.id, "Write a full campaign plan");
    expect(rec.last?.maxTokens).toBeGreaterThanOrEqual(4096);
  });
});

describe("business consultant", () => {
  it("asks for the strong model and is told to rank by value, never invent figures and never spend", async () => {
    const rec = new Recorder();
    const { identity, workforce } = setup([rec]);
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    const e = await workforce.hire("owner", ws.id, "business-consultant");
    await workforce.assign("owner", ws.id, e.id, "Where can we cut costs?");
    expect(rec.last?.tier).toBe("premium");
    const system = rec.last?.messages[0]?.content ?? "";
    expect(system).toContain("best bang for the buck");
    expect(system).toContain("Never invent figures");
    expect(system).toContain("you never spend money");
  });

  it("the old Market analyst is gone", () => {
    expect(TEMPLATES.some((t) => t.key === "market-analyst")).toBe(false);
  });
});

describe("HR manager", () => {
  it("drafts only, protects staff data, avoids discrimination and legal advice", async () => {
    const rec = new Recorder();
    const { identity, workforce } = setup([rec]);
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    const e = await workforce.hire("owner", ws.id, "hr-manager");
    expect(e.name).toBe("HR manager");
    await workforce.assign("owner", ws.id, e.id, "Write a job ad for a barista");
    const system = rec.last!.messages[0]!.content;
    expect(system).toContain("HR manager");
    expect(system).toContain("never hire, dismiss");
    expect(system).toContain("confidential");
    expect(system).toContain("protected characteristics");
    expect(system).toContain("do not give legal advice");
  });
});

describe("training", () => {
  it("adds setup answers to the employee's instructions, and can be cleared", async () => {
    const rec = new Recorder();
    const { identity, workforce } = setup([rec]);
    const ws = await identity.createWorkspace("owner", { name: "Acme" });
    const e = await workforce.hire("owner", ws.id, "marketing-manager");
    workforce.train("owner", ws.id, e.id, "- Customers: dog owners");
    await workforce.assign("owner", ws.id, e.id, "post");
    expect(rec.last!.messages[0]!.content).toContain("dog owners");
    workforce.train("owner", ws.id, e.id, undefined);
    await workforce.assign("owner", ws.id, e.id, "post");
    expect(rec.last!.messages[0]!.content).not.toContain("dog owners");
  });
  it("only owners can train, and never across workspaces", async () => {
    const { identity, workforce } = setup();
    const a = await identity.createWorkspace("alice", { name: "A" });
    const b = await identity.createWorkspace("bob", { name: "B" });
    const e = await workforce.hire("alice", a.id, "hr-manager");
    identity.addMember("alice", a.id, "mo", "member");
    expect(() => workforce.train("mo", a.id, e.id, "x")).toThrow(PermissionError);
    expect(() => workforce.train("bob", b.id, e.id, "x")).toThrow("employee not found");
  });
});
