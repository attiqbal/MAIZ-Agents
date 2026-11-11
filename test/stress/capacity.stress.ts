/**
 * How the in-memory design scales: every record lives in the server's memory and several lookups scan
 * every client's rows. These numbers say when one server stops being enough.
 */
import { describe, expect, it } from "vitest";
import { PLANS } from "../../src/modules/energy/index.js";
import { inParallel, metric, percentiles, timed, uid, world } from "./harness.js";

describe("capacity of one server", () => {
  it("energy checks and the owner's clients screen as usage rows grow to 1 million", async () => {
    const w = world();
    const cs = await inParallel(Array.from({ length: 1_000 }, (_, i) => i), 50, async (i) => {
      const email = `cap${i}@cap.test`;
      const s = await w.signUp(email, `Cap ${i}`);
      w.platform.energy.setPlan(uid(email), s.workspaceId, { ...PLANS.starter! });
      return { ...s, emp: w.platform.workforce.team(uid(email), s.workspaceId)[1]!.id };
    });
    const rows: Record<string, unknown>[] = [];
    let total = 0;
    for (const target of [10_000, 100_000, 1_000_000]) {
      while (total < target) {
        const c = cs[total % cs.length]!;
        w.platform.energy.record(c.workspaceId, c.emp, "runpod", 1000, 600, false, 1_000);
        total++;
      }
      const checks: number[] = [];
      for (let k = 0; k < 50; k++) { const c = cs[k * 7 % cs.length]!; checks.push((await timed(async () => w.platform.energy.check(c.workspaceId, c.emp))).ms); }
      const owner = await timed(() => w.call("GET", "/api/owner/clients", undefined, w.owner));
      const dash = await timed(() => w.call("GET", "/api/dashboard", undefined, cs[3]!.auth));
      rows.push({ usageRows: total, energyCheckMs: percentiles(checks), ownerClientsMs: Math.round(owner.ms), dashboardMs: Math.round(dash.ms), heapMb: Math.round(process.memoryUsage().heapUsed / 1e6) });
    }
    metric("capacity.usage_rows", { clients: 1_000, steps: rows, note: "each task makes 1 usage row; 1,000 clients x 40 tasks a day is about 1.2 million rows a month, all kept in memory and scanned by every energy check" });
    expect(rows.length).toBe(3);
  });
});
