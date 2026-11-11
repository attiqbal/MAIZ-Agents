import { describe, expect, it } from "vitest";
import { PLANS } from "../../src/modules/energy/index.js";
import { inParallel, metric, uid, world, type World } from "./harness.js";

/** Makes every RunPod answer cost a known amount: about 64 energy per task (640 output tokens at $0.10 per 1k). */
function pricedWorld(start?: string): World {
  const w = world({ start });
  w.platform.ai.update(uid("owner@maiz.test"), { runpod: { billing: "tokens", tokenPrice: { inputPer1k: 0, outputPer1k: 100_000 } }, reviewer: { enabled: false } });
  return w;
}

async function paidClient(w: World, email: string, name: string) {
  const s = await w.signUp(email, name);
  w.platform.energy.setPlan(uid(email), s.workspaceId, { ...PLANS.starter! });
  const team = ((await w.call("GET", "/api/org", undefined, s.auth)).body as any).team.filter((e: any) => e.templateKey !== "admin-manager");
  return { ...s, team };
}

const used = (w: World, ws: string) => w.platform.energy.teamEnergyOf(ws)!;

describe("energy pool and caps under load", () => {
  it("300 urgent tasks fired at once cannot spend far past the 3,000 daily ceiling", async () => {
    const w = pricedWorld();
    w.runpod.latencyMs = 40;
    const c = await paidClient(w, "rush@client.test", "Rush Ltd");
    const results = await inParallel(Array.from({ length: 300 }, (_, i) => i), 300, (i) =>
      w.call("POST", "/api/ask", { employeeId: c.team[i % c.team.length].id, text: `Draft supplier email number ${i} about late deliveries`, urgent: true }, c.auth));
    const by: Record<string, number> = {};
    for (const r of results) { const k = (r.body as any).status ?? `http${r.status}`; by[k] = (by[k] ?? 0) + 1; }
    const te = used(w, c.workspaceId);
    const usedToday = te.used;
    metric("energy.burst_300_urgent", { fired: 300, outcomes: by, dailyCeiling: te.dailyCeiling, energyUsedToday: usedToday, overCeilingBy: usedToday - (te.dailyCeiling ?? 0), perTaskEnergy: Math.round(usedToday / (by.ready_for_review ?? 1)) });
    // Every task checks the meter before it starts but pays after it ends, so a burst all passes the same check.
    expect(usedToday).toBeLessThanOrEqual((te.dailyCeiling ?? 0) * 1.1);
  });

  it("a whole week of steady use stops cleanly at the 8,000 pool and refills on Monday", async () => {
    const w = pricedWorld("2026-11-16T08:00:00Z");
    const c = await paidClient(w, "steady@client.test", "Steady Ltd");
    const log: { day: string; done: number; blocked: number; reason?: string }[] = [];
    for (let d = 0; d < 8; d++) {
      w.clock.d = new Date(Date.UTC(2026, 10, 16 + d, 8));
      const auth = w.sessionFor("steady@client.test");
      let done = 0, blocked = 0, reason: string | undefined;
      for (let i = 0; i < 60; i++) {
        const r = (await w.call("POST", "/api/ask", { employeeId: c.team[i % c.team.length].id, text: `Prepare the report part ${i}`, urgent: true }, auth)).body as any;
        if (r.status === "ready_for_review") done++; else { blocked++; reason = r.reason; }
      }
      log.push({ day: w.clock.d.toISOString().slice(0, 10), done, blocked, reason, usedAfter: used(w, c.workspaceId).used } as any);
    }
    metric("energy.week_of_use", { pool: 8_000, dailyCeiling: 3_000, perDay: log });
    // Monday 23rd: the pool is full again.
    expect(log[7]!.done).toBeGreaterThan(0);
    // What the week used, read from the meter on Sunday: the pool, plus at most the last task that crossed it.
    expect((log[6] as any).usedAfter).toBeLessThanOrEqual(8_000 + 100);
  });

  it("a trial ending before tonight's batch does the work now instead of queueing it to fail", async () => {
    const w = pricedWorld("2026-11-16T09:00:00Z");
    const s = await w.signUp("trial@client.test", "Trial Ltd");
    const team = ((await w.call("GET", "/api/org", undefined, s.auth)).body as any).team.filter((e: any) => e.templateKey !== "admin-manager");
    // Queue three normal (batch) jobs on the last afternoon of the trial.
    w.clock.d = new Date("2026-11-23T08:00:00Z");
    const auth = w.sessionFor("trial@client.test");
    const queued = [];
    for (let i = 0; i < 3; i++) queued.push((await w.call("POST", "/api/ask", { employeeId: team[i].id, text: `Write a long marketing plan for spring part ${i}`, when: "tonight" }, auth)).body as any);
    // The batch runs after closing time, which is after the trial ended at 09:00.
    w.clock.d = new Date("2026-11-23T20:00:00Z");
    await w.platform.batch.tick();
    const q = (await w.call("GET", "/api/queue", undefined, auth)).body as any;
    const msgs = ((await w.call("GET", "/api/setup", undefined, auth)).body as any).messages.map((m: any) => m.text).slice(-2);
    metric("energy.trial_end_with_queue", { trialEndsAt: "2026-11-23T09:00:00Z", queuedStatuses: queued.map((x) => x.status), runsAt: queued[0].runsAt, afterBatch: q.jobs.map((j: any) => j.status), clientTold: msgs });
    // The trial ends before tonight's batch, so the work is done straight away instead of being promised for tonight.
    expect(queued.every((x) => x.status === "ready_for_review")).toBe(true);
    expect(q.jobs.filter((j: any) => j.status === "failed")).toHaveLength(0);
  });

  it("one client queues 2,000 jobs with almost no energy left: how many are accepted only to fail", async () => {
    const w = pricedWorld("2026-11-16T09:00:00Z");
    const c = await paidClient(w, "flood@client.test", "Flood Ltd");
    // Monday used the pool down to its last 10 points; the flood comes on Tuesday.
    w.platform.energy.record(c.workspaceId, c.team[0].id, "runpod", 0, 0, false, (8_000 - 10) * 1_000);
    w.clock.d = new Date("2026-11-17T09:00:00Z");
    c.auth = w.sessionFor("flood@client.test");
    let accepted = 0, refused = 0;
    for (let i = 0; i < 2_000; i++) {
      const r = (await w.call("POST", "/api/ask", { employeeId: c.team[i % c.team.length].id, text: `Write blog post ${i} for the website`, when: "tonight" }, c.auth)).body as any;
      if (r.status === "queued") accepted++; else refused++;
    }
    w.clock.d = new Date(w.clock.d.getTime() + 13 * 3_600_000);
    const t0 = performance.now();
    const run = await w.platform.batch.tick();
    metric("energy.queue_flood_without_energy", { queuedAccepted: accepted, refusedAtAsk: refused, batchJobs: run?.jobs, batchDone: run?.done, batchFailed: run?.failed, batchMs: Math.round(performance.now() - t0), energyLeftBefore: 10 });
    // Accepting 2,000 jobs that can never run is a promise the system cannot keep.
    expect(accepted).toBeLessThan(50);
  });

  it("Monday refill follows UTC, not the business's own clock", async () => {
    // A client in Auckland (UTC+13 in November): their Monday starts at 11:00 UTC on Sunday.
    const w = pricedWorld("2026-11-22T12:00:00Z"); // Monday 01:00 in Auckland
    const c = await paidClient(w, "kiwi@client.test", "Kiwi Ltd");
    w.platform.energy.record(c.workspaceId, c.team[0].id, "runpod", 0, 0, false, 8_000 * 1_000);
    const left = used(w, c.workspaceId).left;
    metric("energy.refill_timezone", { client: "Auckland", localTime: "Monday 01:00", poolLeft: left, refillsAt: used(w, c.workspaceId).refillsAt });
    expect(left).toBe(0); // documents today's behaviour: still empty on their Monday morning
  });
});
