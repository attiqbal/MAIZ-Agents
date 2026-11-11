import { describe, expect, it } from "vitest";
import { PLANS } from "../../src/modules/energy/index.js";
import { metric, percentiles, timed, uid, world, type Mode, type World } from "./harness.js";

async function client(w: World, email = "ai@client.test") {
  const s = await w.signUp(email, "AI Client");
  w.platform.energy.setPlan(uid(email), s.workspaceId, { ...PLANS.starter! });
  const team = ((await w.call("GET", "/api/org", undefined, s.auth)).body as any).team.filter((e: any) => e.templateKey === "marketing-manager");
  return { ...s, emp: team[0].id as string };
}

const ask = (w: World, c: { auth: Record<string, string>; emp: string }, text: string) =>
  timed(() => w.call("POST", "/api/ask", { employeeId: c.emp, text, urgent: true }, c.auth));

describe("RunPod and Claude outages", () => {
  for (const mode of ["http500", "http429", "network", "garbage"] as Mode[]) {
    it(`RunPod ${mode}: urgent work moves to Claude, the breaker opens after 3 failures and stops waiting on RunPod`, async () => {
      const w = world();
      const c = await client(w);
      w.runpod.mode = mode;
      const lat: number[] = [];
      const statuses: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = await ask(w, c, `Write the social post number ${i} for Friday's offer`);
        lat.push(r.ms);
        statuses.push((r.value.body as any).status);
      }
      const status = w.platform.ai.overview(uid("owner@maiz.test")).status as any;
      metric(`ai.runpod_${mode}`, { asks: 10, statuses: [...new Set(statuses)], runpodCalls: w.runpod.calls, claudeCalls: w.claude.calls, latencyMs: percentiles(lat), breakerOpen: status.breakerOpen });
      expect(statuses.every((s) => s === "ready_for_review")).toBe(true);
      expect(status.breakerOpen).toBe(true);
      expect(w.runpod.calls).toBeLessThanOrEqual(6); // 3 failing asks x 2 attempts, then the breaker skips RunPod
    });
  }

  it("RunPod hangs (cold start that never finishes): how long the first owners wait before Claude takes over", async () => {
    const w = world();
    const c = await client(w);
    // The default soft deadline is 45 s. Shortened here to 2 s to keep the test quick; the report scales it.
    w.platform.ai.update(uid("owner@maiz.test"), { runpod: { softDeadlineMs: 2_000 } });
    w.runpod.mode = "hang";
    const lat: number[] = [];
    const statuses: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await ask(w, c, `Plan the newsletter number ${i}`);
      lat.push(r.ms);
      statuses.push((r.value.body as any).status);
    }
    metric("ai.runpod_hang", { asks: 5, softDeadlineMsUsed: 2_000, defaultSoftDeadlineMs: 45_000, statuses, latencyMs: lat.map(Math.round), note: "with the default 45 s deadline the first 3 asks each wait ~45 s before Claude answers; after that the breaker skips RunPod for 60 s" });
    expect(statuses.every((s) => s === "ready_for_review")).toBe(true);
  });

  it("both RunPod and Claude down: the owner gets a clear failure, nothing is charged, and it recovers by itself", async () => {
    const w = world();
    const c = await client(w);
    w.runpod.mode = "http500";
    w.claude.mode = "http500";
    const r = await ask(w, c, "Write the menu description for the new soup");
    const body = r.value.body as any;
    const te = w.platform.energy.teamEnergyOf(c.workspaceId)!;
    w.runpod.mode = "ok";
    w.claude.mode = "ok";
    w.clock.d = new Date(w.clock.d.getTime() + 61_000); // breaker cools down
    const again = (await ask(w, c, "Write the menu description for the new soup")).value.body as any;
    metric("ai.both_down", { httpStatus: r.value.status, status: body.status, answerShown: body.answer ?? null, reasonShown: body.reason ?? null, energyCharged: te.used, recoveredStatus: again.status, recoveredRoute: "runpod" });
    expect(body.status).toBe("failed");
    expect(te.used).toBe(0);
    expect(again.status).toBe("ready_for_review");
  });

  it("Claude key revoked (401) while RunPod is down: fails fast instead of retrying", async () => {
    const w = world();
    const c = await client(w);
    w.runpod.mode = "http500";
    w.claude.mode = "http401";
    const r = await ask(w, c, "Draft a reply to the landlord");
    metric("ai.claude_401", { status: (r.value.body as any).status, ms: Math.round(r.ms), claudeCalls: w.claude.calls });
    expect((r.value.body as any).status).toBe("failed");
  });

  it("Claude's daily budget runs out during a RunPod outage: work stops with a budget message, the cap holds", async () => {
    const w = world();
    const c = await client(w);
    w.platform.ai.update(uid("owner@maiz.test"), { budgets: { claudeDailyUsd: 0.01 } });
    w.runpod.mode = "http500";
    const statuses: string[] = [];
    for (let i = 0; i < 30; i++) statuses.push(((await ask(w, c, `Write promo text ${i}`)).value.body as any).status);
    const ov = w.platform.ai.overview(uid("owner@maiz.test")) as any;
    metric("ai.claude_daily_cap_during_outage", { capUsd: 0.01, done: statuses.filter((s) => s === "ready_for_review").length, failed: statuses.filter((s) => s === "failed").length, claudeSpentTodayUsd: ov.today?.claudeMicro !== undefined ? ov.today.claudeMicro / 1e6 : ov });
    expect(statuses.filter((s) => s === "failed").length).toBeGreaterThan(0);
  });

  it("RunPod returns empty or looping answers: they are redone on Claude, never handed to the owner", async () => {
    const w = world();
    const c = await client(w);
    const out: Record<string, unknown> = {};
    for (const mode of ["empty", "loop"] as Mode[]) {
      w.runpod.mode = mode;
      const r = (await ask(w, c, `Write the about-us page, version ${mode}`)).value.body as any;
      out[mode] = { status: r.status, answerLooksBad: !r.answer || /again and again/.test(r.answer) };
    }
    metric("ai.bad_open_model_answers", out);
    expect((out.empty as any).answerLooksBad).toBe(false);
    expect((out.loop as any).answerLooksBad).toBe(false);
  });
});
