import { describe, expect, it } from "vitest";
import {
  AdminManager,
  AuditLog,
  ChannelRouter,
  EnergyMeter,
  EventBus,
  IdentityService,
  InMemoryModelProvisioner,
  InMemoryStorageProvisioner,
  Ledger,
  MockAdapter,
  ModelGateway,
  OnboardingService,
  PermissionError,
  SetupError,
  WorkforceService,
  drivePlan,
  formFor,
  modelsFor,
  validateAnswers,
  type ChatChannel,
  type ModelNeed,
  type SignupChoices,
} from "../src/index.js";

const base: SignupChoices = { businessName: "Kestrel Coffee", businessType: "startup", description: "Coffee subscriptions", country: "GB", teamSize: "2-10" };
const answers = {
  goals: "More subscribers and tidy books",
  customers: "Home coffee drinkers",
  tone: "Warm and friendly",
  financialYearStart: "April",
  salesTaxRegistered: false,
  marketingChannels: ["Instagram", "Email"],
  staffCount: 3,
  hiringSoon: true,
};

class FakeSlack implements ChatChannel {
  readonly kind = "slack" as const;
  sent: { ws: string; conv: string; text: string }[] = [];
  async send(ws: string, conv: string, text: string) {
    this.sent.push({ ws, conv, text });
  }
}

class FlakyModels extends InMemoryModelProvisioner {
  constructor(private failOn: string) {
    super();
  }
  override async install(ws: string, need: ModelNeed, mode: Parameters<InMemoryModelProvisioner["install"]>[2], drive: Parameters<InMemoryModelProvisioner["install"]>[3]) {
    if (need.id === this.failOn) throw new Error("GPU host unavailable");
    return super.install(ws, need, mode, drive);
  }
}

async function setup(choices: Partial<SignupChoices> = {}, models = new InMemoryModelProvisioner()) {
  const audit = new AuditLog();
  const bus = new EventBus();
  const identity = new IdentityService(audit, bus);
  const energy = new EnergyMeter(identity, audit);
  const wf = new WorkforceService(identity, audit, bus, new ModelGateway([new MockAdapter()]), energy);
  const onboarding = new OnboardingService(identity, wf, new Ledger(identity, audit), energy, audit);
  const router = new ChannelRouter(identity, wf, audit);
  const slack = new FakeSlack();
  router.register(slack);
  const storage = new InMemoryStorageProvisioner();
  const events: string[] = [];
  bus.on("*", (e) => void events.push(e.type));
  const admin = new AdminManager(identity, wf, audit, bus, storage, models, router, { formUrl: "https://app.example.com/app.html#setup" });
  const org = await onboarding.signUp("owner", { ...base, ...choices });
  return { audit, identity, wf, router, slack, storage, models, admin, org, events, ws: org.workspaceId };
}

describe("welcome", () => {
  it("introduces every free employee with capabilities and sends the form, on the dashboard by default", async () => {
    const { admin, org, ws } = await setup();
    const msgs = await admin.welcome("owner", org);
    expect(msgs.map((m) => m.kind)).toEqual(["welcome", "form"]);
    const intro = msgs[0]!.text;
    for (const title of ["Finance manager", "Marketing manager", "Business consultant", "HR manager"]) expect(intro).toContain(title);
    expect(intro).toContain("Job ads, interview questions");
    expect(msgs[1]!.link).toContain("#setup");
    expect(admin.messages("owner", ws).every((m) => m.delivered.includes("dashboard"))).toBe(true);
    expect(admin.status("owner", ws).state).toBe("awaiting_form");
  });

  it("messages the owner in Slack when connected, and holds messages until Slack is connected otherwise", async () => {
    const { admin, org, ws, router, slack } = await setup({ contact: "slack" });
    await admin.welcome("owner", org);
    let msgs = admin.messages("owner", ws);
    expect(msgs.every((m) => m.pendingOn === "slack")).toBe(true);
    expect(slack.sent).toHaveLength(0);

    router.connect("owner", { workspaceId: ws, channel: "slack", externalWorkspace: "T1", defaultEmployeeId: org.adminManagerId }, []);
    router.linkUser("owner", ws, "slack", "T1", "U_OWNER");
    expect(await admin.deliverPending("owner", ws)).toBe(2);
    expect(slack.sent.map((s) => s.conv)).toEqual(["U_OWNER", "U_OWNER"]);
    expect(slack.sent[1]!.text).toContain("https://app.example.com/app.html#setup");
    msgs = admin.messages("owner", ws);
    expect(msgs.every((m) => m.delivered.includes("slack") && !m.pendingOn)).toBe(true);

    await admin.submitForm("owner", ws, answers);
    expect(slack.sent.at(-1)!.text).toContain("Your team is set up");
  });

  it("only the owner can be welcomed, and only once", async () => {
    const { admin, org, identity, ws } = await setup();
    identity.addMember("owner", ws, "mo", "member");
    await expect(admin.welcome("mo", org)).rejects.toThrow(PermissionError);
    await admin.welcome("owner", org);
    await expect(admin.welcome("owner", org)).rejects.toThrow(SetupError);
  });
});

describe("setup form", () => {
  it("only asks about employees the customer has", () => {
    const keys = formFor(["finance-manager"]).map((f) => f.for);
    expect(keys).toContain("finance-manager");
    expect(keys).not.toContain("hr-manager");
    expect(formFor(["hr-manager"]).some((f) => f.key === "staffCount")).toBe(true);
  });
  it("requires the two shared questions and checks types", () => {
    const fields = formFor(["finance-manager", "hr-manager"]);
    const bad = validateAnswers(fields, { goals: " ", tone: "Shouty", staffCount: -1, financialYearStart: "Smarch" });
    expect(Object.keys(bad.errors).sort()).toEqual(["customers", "financialYearStart", "goals", "staffCount", "tone"]);
    const good = validateAnswers(fields, { goals: "Grow", customers: "Cafes", staffCount: "1,200", unknown: "x" });
    expect(good.ok).toBe(true);
    expect(good.clean).toEqual({ goals: "Grow", customers: "Cafes", staffCount: 1200 });
  });
  it("rejects a form with errors before changing anything", async () => {
    const { admin, org, ws, storage } = await setup();
    await admin.welcome("owner", org);
    await expect(admin.submitForm("owner", ws, { goals: "" })).rejects.toThrow("form has errors");
    expect(storage.drives.size).toBe(0);
    expect(admin.status("owner", ws).state).toBe("awaiting_form");
  });
});

describe("setup run", () => {
  it("saves the profile, creates a shared drive, attaches shared models, trains the team, and records each step", async () => {
    const { admin, org, ws, wf, storage, models, audit, events } = await setup();
    await admin.welcome("owner", org);
    const run = await admin.submitForm("owner", ws, answers);
    expect(run.status).toBe("completed");
    expect(run.steps.map((s) => [s.key, s.status])).toEqual([
      ["profile", "done"],
      ["storage", "done"],
      ["models", "done"],
      ["training", "done"],
      ["finish", "done"],
    ]);
    expect(wf.profileOf("owner", ws)).toMatchObject({ audience: "Home coffee drinkers", tone: "Warm and friendly", description: "Coffee subscriptions" });
    const [drive] = [...storage.drives.values()];
    expect(drive).toMatchObject({ kind: "shared", workspaceId: ws, location: `shared://customers/${ws}/` });
    expect([...models.installs.values()].map((i) => [i.modelId, i.mode])).toEqual([
      ["qwen3-embedding-0.6b", "shared-pool"],
      ["qwen3.6-35b-a3b", "shared-pool"],
      ["claude-sonnet", "api"],
    ]);
    // Each employee learns the shared answers plus its own; the Admin manager learns everything.
    const team = wf.team("owner", ws);
    const notes = (key: string) => wf.trainingOf("owner", ws, team.find((e) => e.templateKey === key)!.id)!;
    expect(notes("hr-manager")).toContain("Yes");
    expect(notes("hr-manager")).not.toContain("April");
    expect(notes("finance-manager")).toContain("April");
    expect(notes("marketing-manager")).toContain("Instagram, Email");
    expect(notes("admin-manager")).toContain("April");
    expect(notes("admin-manager")).toContain("Home coffee drinkers");
    expect(admin.status("owner", ws).state).toBe("ready");
    expect(admin.messages("owner", ws).at(-1)!.text).toContain("HR manager: People basics checklist");
    expect(audit.list(ws).filter((a) => a.action === "setup.step_done")).toHaveLength(5);
    expect(events).toContain("setup.completed");
    await expect(admin.submitForm("owner", ws, answers)).rejects.toThrow("already set up");
  });

  it("gives standalone customers their own drive and downloads open models to it", async () => {
    const { admin, org, ws, storage, models } = await setup({ prepaidMonths: 6 });
    expect(org.blueprint.privacy).toBe("own-database");
    await admin.welcome("owner", org);
    await admin.submitForm("owner", ws, answers);
    const [drive] = [...storage.drives.values()];
    expect(drive!.kind).toBe("standalone");
    const installs = [...models.installs.values()];
    expect(installs.filter((i) => i.mode === "download").every((i) => i.driveId === drive!.id)).toBe(true);
    expect(installs.find((i) => i.modelId === "claude-sonnet")!.mode).toBe("api");
  });

  it("rolls back every finished step when one fails, and lets the owner try again", async () => {
    const { admin, org, ws, wf, storage, models, events } = await setup({}, new FlakyModels("claude-sonnet"));
    await admin.welcome("owner", org);
    const profileBefore = wf.profileOf("owner", ws);
    const run = await admin.submitForm("owner", ws, answers);
    expect(run.status).toBe("rolled_back");
    expect(run.failedStep).toBe("models");
    expect(run.steps.map((s) => s.status)).toEqual(["undone", "undone", "failed", "pending", "pending"]);
    expect(storage.drives.size).toBe(0);
    expect(models.installs.size).toBe(0); // the two models installed before the failure were removed too
    expect(wf.profileOf("owner", ws)).toEqual(profileBefore);
    expect(admin.status("owner", ws).state).toBe("awaiting_form");
    expect(admin.messages("owner", ws).at(-1)).toMatchObject({ kind: "failed" });
    expect(events).toContain("setup.failed");
  });

  it("lets the owner undo a finished setup completely", async () => {
    const { admin, org, ws, wf, storage, models, identity } = await setup();
    await admin.welcome("owner", org);
    const profileBefore = wf.profileOf("owner", ws);
    await admin.submitForm("owner", ws, answers);
    identity.addMember("owner", ws, "mo", "member");
    await expect(admin.rollback("mo", ws)).rejects.toThrow(PermissionError);
    const run = await admin.rollback("owner", ws);
    expect(run.status).toBe("rolled_back");
    expect(run.rollbackReason).toBe("owner_request");
    expect(run.steps.every((s) => s.status === "undone")).toBe(true);
    expect(storage.drives.size).toBe(0);
    expect(models.installs.size).toBe(0);
    expect(wf.profileOf("owner", ws)).toEqual(profileBefore);
    for (const e of wf.team("owner", ws)) expect(wf.trainingOf("owner", ws, e.id)).toBeUndefined();
    expect(admin.status("owner", ws).state).toBe("awaiting_form");
    await expect(admin.rollback("owner", ws)).rejects.toThrow("nothing to roll back");
    // and setup can run again
    expect((await admin.submitForm("owner", ws, answers)).status).toBe("completed");
  });

  it("says when an undo itself fails instead of pretending all is well", async () => {
    const storage = new InMemoryStorageProvisioner();
    storage.remove = async () => {
      throw new Error("volume busy");
    };
    const audit = new AuditLog();
    const bus = new EventBus();
    const identity = new IdentityService(audit, bus);
    const energy = new EnergyMeter(identity, audit);
    const wf = new WorkforceService(identity, audit, bus, new ModelGateway([new MockAdapter()]), energy);
    const org = await new OnboardingService(identity, wf, new Ledger(identity, audit), energy, audit).signUp("owner", base);
    const admin = new AdminManager(identity, wf, audit, bus, storage, new FlakyModels("qwen3-embedding-0.6b"));
    await admin.welcome("owner", org);
    const run = await admin.submitForm("owner", org.workspaceId, answers);
    expect(run.status).toBe("rollback_failed");
    expect(run.steps.find((s) => s.key === "storage")!.status).toBe("undo_failed");
    expect(admin.status("owner", org.workspaceId).state).toBe("needs_attention");
    expect(audit.list(org.workspaceId).map((a) => a.action)).toContain("setup.undo_failed");
  });

  it("keeps two customers' setups apart", async () => {
    const a = await setup();
    await a.admin.welcome("owner", a.org);
    expect(() => a.admin.status("stranger", a.ws)).toThrow(PermissionError);
    await expect(a.admin.submitForm("stranger", a.ws, answers)).rejects.toThrow(PermissionError);
  });
});

describe("storage and model plans", () => {
  it("shared privacy gets a shared drive, any own tier a standalone one with room for models", () => {
    expect(drivePlan("shared", "trial")).toEqual({ kind: "shared", quotaGb: 5 });
    expect(drivePlan("own-database", "trial").kind).toBe("standalone");
    expect(drivePlan("own-server", "growth").kind).toBe("standalone");
    const downloads = modelsFor(["standard", "premium"]).filter((m) => m.source === "open-weights").reduce((a, m) => a + m.sizeGb, 0);
    expect(downloads).toBeLessThanOrEqual(drivePlan("own-database", "trial").quotaGb);
  });
  it("only calls the paid API model when a premium employee needs it", () => {
    expect(modelsFor(["standard"]).map((m) => m.id)).toEqual(["qwen3-embedding-0.6b", "qwen3.6-35b-a3b"]);
    expect(modelsFor(["premium"]).map((m) => m.id)).toContain("claude-sonnet");
  });
});
