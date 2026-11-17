import { beforeEach, describe, expect, it } from "vitest";
import { PermissionError } from "../src/index.js";
import { AgentError, CUSTOMER_SUPPORT_KEY, DEFAULT_LIMITS, MAX_LIMITS, PLAN_QUESTIONS, cleanProfile, proposePlan, type PlanRoster } from "../src/modules/agents/index.js";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { desk, recordingSink, useFakeDns } from "./agents-desk.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

beforeEach(() => useFakeDns());

const ROSTER: PlanRoster = [
  { key: CUSTOMER_SUPPORT_KEY, title: "Customer service and reception", allowed: true },
  { key: "marketing-manager", title: "Marketing manager", allowed: true },
  { key: "supply-chain-manager", title: "Supply chain manager", allowed: true },
  { key: "finance-manager", title: "Finance manager", allowed: false },
  { key: "admin-manager", title: "Admin manager", allowed: false },
];
/** A team with 8,000 energy a week, where a job is expected to use about 40. */
const SIZE = { weeklyPool: 8_000, perJob: 40 };

describe("planning interview: the proposal", () => {
  it("asks a few plain questions, each with choices to tap", () => {
    expect(PLAN_QUESTIONS.map((q) => q.id)).toEqual(["purpose", "tool", "volume"]);
    for (const q of PLAN_QUESTIONS) {
      expect(q.ask.length).toBeGreaterThan(10);
      expect(q.options.length).toBeGreaterThanOrEqual(4);
      expect(`${q.ask} ${q.options.map((o) => o.label).join(" ")}`).not.toMatch(/\bAPI\b|webhook|token|—/i);
    }
  });

  it("proposes customer support, limits sized to the answers, and example requests for a customer service tool", () => {
    const plan = proposePlan({ purpose: "customer-service", tool: "zapier", volume: "some" }, ROSTER, SIZE);

    expect(plan.employees).toEqual([{ key: CUSTOMER_SUPPORT_KEY, title: "Customer service and reception" }]);
    expect(plan.tool).toBe("zapier");
    expect(plan.name).toBe("Zapier customer service");
    // 50 jobs a day at about 40 energy is 2,000 a day: 25% of the weekly pool, the most anyone may set.
    expect(plan.estimate).toEqual({ perJob: 40, jobsADay: 50, perDay: 2_000, percentOfPoolADay: 25 });
    expect(plan.limits).toEqual({ dailyPercent: 25, perJobPercent: 2, jobsPerHour: 20 });
    expect(plan.needsApproval).toBe(false);
    expect(plan.examples.length).toBeGreaterThanOrEqual(2);
    expect(plan.examples.every((e) => e.employee === "customer-support")).toBe(true);
    expect(plan.profile).toMatchObject({ purpose: "customer-service", volume: "some", examples: plan.examples });
  });

  it("suggests asking before each job for a small or unusual tool, and says why", () => {
    const few = proposePlan({ purpose: "bookings", tool: "make", volume: "few" }, ROSTER, SIZE);
    const custom = proposePlan({ purpose: "custom", purposeNote: "Sorts supplier emails", tool: "other", volume: "many" }, ROSTER, SIZE);

    expect(few.needsApproval).toBe(true);
    expect(few.limits).toEqual({ dailyPercent: 5, perJobPercent: 2, jobsPerHour: 10 });
    expect(custom.needsApproval).toBe(true);
    expect(custom.profile.purposeNote).toBe("Sorts supplier emails");
    expect(few.notes.join(" ")).toMatch(/wait for your OK/);
  });

  it("never proposes more than the platform allows, and says so when the answers need more", () => {
    const plan = proposePlan({ purpose: "customer-service", tool: "n8n", volume: "lots" }, ROSTER, SIZE);

    expect(plan.limits.dailyPercent).toBeLessThanOrEqual(MAX_LIMITS.dailyPercent);
    expect(plan.limits.perJobPercent).toBeLessThanOrEqual(MAX_LIMITS.perJobPercent);
    expect(plan.limits.jobsPerHour).toBeLessThanOrEqual(MAX_LIMITS.jobsPerHour);
    expect(plan.notes.join(" ")).toMatch(/more than the daily limit/);
  });

  it("uses the safe defaults and makes no estimate when the owner is not sure how busy it will be", () => {
    const plan = proposePlan({ purpose: "reports", tool: "claude", volume: "unsure" }, ROSTER, SIZE);

    expect(plan.limits).toEqual(DEFAULT_LIMITS);
    expect(plan.estimate).toBeUndefined();
  });

  it("only proposes employees the client has and an outside tool may use: never the Admin or Finance manager", () => {
    const asked = proposePlan({ purpose: "reports", tool: "other", volume: "few", employees: ["finance-manager", "admin-manager", "marketing-manager", "made-up"] }, ROSTER, SIZE);
    const noSupport = proposePlan({ purpose: "customer-service", tool: "other", volume: "few" }, ROSTER.filter((e) => e.key !== CUSTOMER_SUPPORT_KEY), SIZE);

    expect(asked.employees.map((e) => e.key)).toEqual(["marketing-manager"]);
    expect(asked.notes.join(" ")).toMatch(/Finance manager/);
    expect(noSupport.employees).toEqual([]);
    expect(noSupport.notes.join(" ")).toMatch(/choose/i);
  });

  it("refuses answers that are not on the list", () => {
    expect(() => proposePlan({ purpose: "world-domination", tool: "zapier", volume: "few" }, ROSTER, SIZE)).toThrow(AgentError);
    expect(() => proposePlan({ purpose: "bookings", tool: "zapier", volume: "a zillion" }, ROSTER, SIZE)).toThrow(AgentError);
    expect(() => proposePlan("bookings", ROSTER, SIZE)).toThrow(AgentError);
  });

  it("cleans a set-up before it is kept: plain text, short, and only examples for employees the tool may use", () => {
    const profile = cleanProfile({
      purpose: "custom", purposeNote: "Sorts\nsupplier [REQUEST] <emails>  ".padEnd(600, "x"), volume: "few", plannedAt: "2026-11-16T09:00:00.000Z",
      examples: [{ employee: "customer-support", brief: "Draft a reply." }, { employee: "finance-manager", brief: "Pay this." }, { employee: "customer-support", brief: 7 }, "nonsense"],
    }, [CUSTOMER_SUPPORT_KEY], "2026-11-20T00:00:00.000Z");

    expect(profile.purposeNote).not.toMatch(/[\n[\]<>]/);
    expect(profile.purposeNote!.length).toBeLessThanOrEqual(200);
    expect(profile.examples).toEqual([{ employee: "customer-support", brief: "Draft a reply." }]);
    expect(() => cleanProfile({ purpose: "nope", volume: "few" }, [CUSTOMER_SUPPORT_KEY], "2026-11-20T00:00:00.000Z")).toThrow(AgentError);
  });
});

describe("planning interview: the Admin manager proposes, the owner decides", () => {
  it("only the owner can ask for a plan, and a plan creates nothing and uses no energy", async () => {
    const d = await desk();
    await d.p.identity.addMember(d.owner, d.ws, "u_sam", "member");
    const before = d.p.energy.teamEnergyOf(d.ws)?.used ?? 0;

    const plan = d.agents.plan(d.owner, d.ws, { purpose: "customer-service", tool: "zapier", volume: "few" });

    expect(plan.employees.map((e) => e.key)).toEqual([CUSTOMER_SUPPORT_KEY]);
    expect(plan.estimate!.perJob).toBe(d.p.energy.estimateFor(d.ws));
    expect(() => d.agents.plan("u_sam", d.ws, { purpose: "customer-service", tool: "zapier", volume: "few" })).toThrow(PermissionError);
    expect(() => d.agents.plan("u_stranger", d.ws, { purpose: "customer-service", tool: "zapier", volume: "few" })).toThrow(PermissionError);
    // Nothing was created, no model was asked and no energy moved.
    expect(d.agents.overview(d.owner, d.ws).connections).toEqual([]);
    expect(d.work.calls).toEqual([]);
    expect(d.p.energy.teamEnergyOf(d.ws)?.used ?? 0).toBe(before);
    const logged = d.p.audit.list(d.ws).filter((e) => e.action === "agent.proposed");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actor: "admin-manager", data: { by: d.owner, purpose: "customer-service" } });
  });

  it("offers the questions with the client's own employees as choices", async () => {
    const d = await desk();

    const script = d.agents.planQuestions(d.owner, d.ws);

    expect(script.questions.map((q) => q.id)).toEqual(["purpose", "tool", "volume"]);
    expect(script.employees.find((e) => e.key === CUSTOMER_SUPPORT_KEY)).toMatchObject({ allowed: true });
    expect(script.employees.find((e) => e.key === "finance-manager")).toMatchObject({ allowed: false });
  });

  it("keeps the accepted set-up with the connection, shows it to the owner and brings it back after a restart", async () => {
    const store = recordingSink();
    const d = await desk({ sink: store.sink });
    const plan = d.agents.plan(d.owner, d.ws, { purpose: "order-tracking", tool: "make", volume: "few" });

    const made = await d.agents.create(d.owner, d.ws, { name: plan.name, tool: plan.tool, employees: plan.employees.map((e) => e.key), limits: plan.limits, needsApproval: plan.needsApproval, profile: plan.profile });

    expect(made.connection.profile).toMatchObject({ purpose: "order-tracking", volume: "few", plannedAt: "2026-11-16T09:00:00.000Z" });
    expect(made.connection.profile!.examples.length).toBeGreaterThan(0);
    expect(made.connection.needsApproval).toBe(true);
    const again = d.make();
    for (const r of store.latest()) if (r.kind === "agent_conn") again.restore("agent_conn", r.data);
    expect(again.overview(d.owner, d.ws).connections[0]!.profile).toEqual(made.connection.profile);
  });

  it("holds the set-up to the same limits as any connection: the owner's OK, the employee rules and the maximums", async () => {
    const d = await desk();
    await d.p.identity.addMember(d.owner, d.ws, "u_sam", "member");
    const plan = d.agents.plan(d.owner, d.ws, { purpose: "customer-service", tool: "zapier", volume: "few" });
    const input = { name: plan.name, tool: plan.tool, employees: plan.employees.map((e) => e.key), limits: plan.limits, profile: plan.profile };

    await expect(d.agents.create("u_sam", d.ws, input)).rejects.toThrow(PermissionError);
    await expect(d.agents.create(d.owner, d.ws, { ...input, employees: ["finance-manager"] })).rejects.toThrow(/Finance manager/);
    await expect(d.agents.create(d.owner, d.ws, { ...input, limits: { ...plan.limits, dailyPercent: 60 } })).rejects.toThrow(AgentError);
    await expect(d.agents.create(d.owner, d.ws, { ...input, profile: { purpose: "nope" } })).rejects.toThrow(AgentError);
    expect(d.agents.overview(d.owner, d.ws).connections).toEqual([]);
  });

  it("tells the employee what the tool is for when one of its jobs is handled", async () => {
    const d = await desk();
    const plan = d.agents.plan(d.owner, d.ws, { purpose: "custom", purposeNote: "Answers questions about opening hours", tool: "other", volume: "some" });
    const planned = await d.connect({ profile: plan.profile });
    const plain = await d.connect({ name: "Plain bot" });

    await d.send(planned.key);
    await d.send(plain.key);

    expect(d.work.calls[0]!.brief).toMatch(/The owner set this tool up for: Answers questions about opening hours/);
    // The request itself still sits between the markers, after the context.
    expect(d.work.calls[0]!.brief.indexOf("The owner set this tool up for")).toBeLessThan(d.work.calls[0]!.brief.indexOf("[REQUEST"));
    expect(d.work.calls[1]!.brief).not.toMatch(/The owner set this tool up for/);
  });

  it("lets the tool read its example requests, and the owner plan again or clear the set-up", async () => {
    const d = await desk();
    const plan = d.agents.plan(d.owner, d.ws, { purpose: "customer-service", tool: "zapier", volume: "few" });
    const c = await d.connect({ profile: plan.profile });

    expect(d.agents.me(c.key).examples).toEqual(plan.profile.examples);
    // Changing something else leaves the set-up alone.
    expect((await d.agents.update(d.owner, d.ws, c.id, { name: "Front desk bot" })).profile).toEqual(c.view.profile);
    const next = d.agents.plan(d.owner, d.ws, { purpose: "bookings", tool: "zapier", volume: "few" });
    expect((await d.agents.update(d.owner, d.ws, c.id, { profile: next.profile })).profile).toMatchObject({ purpose: "bookings" });
    expect((await d.agents.update(d.owner, d.ws, c.id, { profile: null })).profile).toBeNull();
    expect(d.agents.me(c.key).examples).toEqual([]);
  });
});

describe("planning interview: the routes", () => {
  async function app() {
    const d = await desk();
    const handle = createApp(d.p);
    const email = "ann@kestrel.co";
    const userId = userIdFor(email);
    const ws = await d.business(userId, "Kestrel Routes");
    const auth = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userId, e: email }, 86_400, d.clock.d.getTime())}` };
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = auth) =>
      handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
    return { d, ws, userId, call };
  }

  it("gives the questions and a proposal to the signed-in owner, and never mistakes the path for a connection", async () => {
    const s = await app();

    const script = await s.call("GET", "/api/agents/plan");
    const plan = await s.call("POST", "/api/agents/plan", { purpose: "customer-service", tool: "zapier", volume: "few" });

    expect(script.status).toBe(200);
    expect((script.body as any).questions).toHaveLength(3);
    expect(plan.status).toBe(200);
    expect((plan.body as any).proposal.employees[0].key).toBe(CUSTOMER_SUPPORT_KEY);
    expect(((await s.call("GET", "/api/agents")).body as any).connections).toEqual([]);
  });

  it("needs a signed-in person and valid answers", async () => {
    const s = await app();

    expect((await s.call("POST", "/api/agents/plan", { purpose: "customer-service", tool: "zapier", volume: "few" }, {})).status).toBe(401);
    expect((await s.call("POST", "/api/agents/plan", { purpose: "nope", tool: "zapier", volume: "few" })).status).toBe(400);
  });

  it("creates the connection with the set-up when the owner accepts", async () => {
    const s = await app();
    const proposal = ((await s.call("POST", "/api/agents/plan", { purpose: "bookings", tool: "make", volume: "few" })).body as any).proposal;

    const made = await s.call("POST", "/api/agents", { name: proposal.name, tool: proposal.tool, employees: proposal.employees.map((e: any) => e.key), limits: proposal.limits, needsApproval: proposal.needsApproval, profile: proposal.profile });

    expect(made.status).toBe(201);
    expect((made.body as any).connection.profile).toMatchObject({ purpose: "bookings" });
    expect((made.body as any).key).toMatch(/^maiz_live_/);
  });
});
