import { describe, expect, it } from "vitest";
import { PLANS } from "../../src/modules/energy/index.js";
import { inParallel, metric, uid, world, type World } from "./harness.js";

async function clients(w: World, n: number, prefix: string) {
  return inParallel(Array.from({ length: n }, (_, i) => i), 25, async (i) => {
    const email = `${prefix}${i}@batch.test`;
    const s = await w.signUp(email, `${prefix} ${i}`);
    w.platform.energy.setPlan(uid(email), s.workspaceId, { ...PLANS.starter! });
    const emp = ((await w.call("GET", "/api/org", undefined, s.auth)).body as any).team.find((e: any) => e.templateKey === "marketing-manager").id as string;
    return { ...s, emp, email };
  });
}

const queueWork = (w: World, c: { auth: Record<string, string>; emp: string }, text: string) => w.call("POST", "/api/ask", { employeeId: c.emp, text }, c.auth);

describe("the batch queue at scale", () => {
  it("200 clients x 10 tasks run in one closing-time batch; time per task scales to real RunPod speed", async () => {
    const w = world();
    w.runpod.latencyMs = 20;
    const cs = await clients(w, 200, "c");
    for (const c of cs) for (let i = 0; i < 10; i++) expect(((await queueWork(w, c, `Plan the posts for week ${i}`)).body as any).status).toBe("queued");
    w.clock.d = new Date("2026-11-16T18:01:00Z");
    const t0 = performance.now();
    const run = await w.platform.batch.tick();
    const ms = performance.now() - t0;
    const conc = w.platform.ai.overview(uid("owner@maiz.test")).settings.batch.concurrency;
    const perJobMs = (ms / (run?.jobs ?? 1)) * conc;
    // A real RunPod answer for a 4,000-token deliverable takes 15-40 s. At 6 at a time:
    const hoursAt = (secs: number) => Math.round(((run?.jobs ?? 0) * secs) / conc / 3600 * 10) / 10;
    metric("batch.200_clients_x_10", { jobs: run?.jobs, done: run?.done, failed: run?.failed, clients: run?.clients, concurrency: conc, wallMs: Math.round(ms), simulatedRunpodMs: 20, ourOverheadPerJobMs: Math.round(perJobMs - 20), realisticHours: { at15s: hoursAt(15), at30s: hoursAt(30), at40s: hoursAt(40) }, emailsOrMessagesPerClient: 1 });
    expect(run?.done).toBe(2_000);
  });

  it("noisy neighbour: one client's 200 tasks are all ahead of everyone else in the same batch", async () => {
    const w = world();
    const [big, ...small] = await clients(w, 6, "n");
    for (let i = 0; i < 200; i++) await queueWork(w, big!, `Write product description ${i}`);
    for (const c of small) await queueWork(w, c, "Write this week's newsletter");
    const order: string[] = [];
    const orig = w.platform.workforce.runQueued.bind(w.platform.workforce);
    w.platform.workforce.runQueued = async (job, b) => { order.push(job.workspaceId); return orig(job, b); };
    w.clock.d = new Date("2026-11-16T18:01:00Z");
    await w.platform.batch.tick();
    const firstSmall = order.findIndex((ws) => ws !== big!.workspaceId);
    metric("batch.noisy_neighbour", { bigClientTasks: 200, smallClients: small.length, positionOfFirstSmallClientTask: firstSmall, totalTasks: order.length, waitAt30sPerTask6Wide: `${Math.round((firstSmall * 30) / 6 / 60)} min` });
    // Fair order: every client's first task should start in the first round.
    expect(firstSmall).toBeLessThan(12);
  });

  it("RunPod down for the whole night: retries at +15 and +30 minutes, Claude only on the last try", async () => {
    const w = world();
    const cs = await clients(w, 20, "f");
    for (const c of cs) for (let i = 0; i < 5; i++) await queueWork(w, c, `Write the offer email ${i}`);
    w.runpod.mode = "http500";
    w.clock.d = new Date("2026-11-16T18:01:00Z");
    const r1 = await w.platform.batch.tick();
    const claudeAfter1 = w.claude.calls;
    w.clock.d = new Date("2026-11-16T18:17:00Z");
    const r2 = await w.platform.batch.tick();
    const claudeAfter2 = w.claude.calls;
    w.clock.d = new Date("2026-11-16T18:48:00Z");
    const r3 = await w.platform.batch.tick();
    const statuses = (await w.call("GET", "/api/queue", undefined, cs[0]!.auth)).body as any;
    metric("batch.runpod_down_all_night", { jobs: 100, try1: { done: r1?.done, retried: r1?.retried }, try2: { done: r2?.done, retried: r2?.retried }, try3: { done: r3?.done, failed: r3?.failed }, claudeCallsBeforeLastTry: claudeAfter2, claudeCallsTotal: w.claude.calls, runpodCalls: w.runpod.calls, clientJobStatuses: statuses.jobs.map((j: any) => j.status) });
    expect(claudeAfter1).toBe(0);
    expect((r3?.done ?? 0) + (r3?.failed ?? 0)).toBe(100);
  });

  it("RunPod flaky (1 in 3 calls fail): every task still ends filed", async () => {
    const w = world();
    const cs = await clients(w, 10, "k");
    for (const c of cs) for (let i = 0; i < 10; i++) await queueWork(w, c, `Write the reel script ${i}`);
    const real = w.runpod;
    real.failEvery = 3;
    w.clock.d = new Date("2026-11-16T18:01:00Z");
    let done = 0, failed = 0, ticks = 0;
    for (const t of ["18:01", "18:20", "18:50", "19:30"]) {
      w.clock.d = new Date(`2026-11-16T${t}:00Z`);
      const r = await w.platform.batch.tick();
      ticks++;
      done += r?.done ?? 0; failed += r?.failed ?? 0;
    }
    metric("batch.flaky_runpod", { jobs: 100, done, failed, ticks, runpodCalls: real.calls, runpodFailures: real.failures, claudeCalls: w.claude.calls });
    expect(done + failed).toBe(100);
  });
});
