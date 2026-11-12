import { describe, expect, it } from "vitest";
import { metric, percentiles, timed, uid, world } from "./harness.js";
import { PLANS } from "../../src/modules/energy/index.js";

/**
 * A 50-staff business serving 500 customers a day: the rota for 50 people, a month of sales posted to the books
 * (500 sales a day), the owner and managers asking the AI team through the day, and the screens they open.
 */
describe("a 50-staff, 500-customers-a-day business", () => {
  it("runs a month: rota, 15,000 sales in the books, 40 asks a day, and the screens stay fast", async () => {
    const w = world({ start: "2026-11-02T07:00:00Z" });
    const signed = await w.signUp("boss@bigcafe.test", "Big Cafe", { size: "11-50" });
    let auth = signed.auth;
    const workspaceId = signed.workspaceId;
    // A paying client on the £150 team package (the trial would end after 7 days of this month).
    w.platform.energy.setPlan(uid("boss@bigcafe.test"), workspaceId, { ...PLANS.starter! });

    // 50 staff on the rota, each with an hourly rate.
    const staff: string[] = [];
    for (let i = 0; i < 50; i++) {
      const r = await w.call("POST", "/api/rota/staff", { name: `Person ${i}`, role: i % 5 === 0 ? "Supervisor" : "Barista", hourlyRateMinor: 1150 + i * 5 }, auth);
      expect(r.status).toBe(201);
      staff.push((r.body as any).added.id);
    }
    // Four weeks of shifts: each person works 5 days of 8 hours (within the 48h cap and 11h rest).
    const shiftLat: number[] = [];
    let shifts = 0;
    for (let week = 0; week < 4; week++) {
      for (let day = 0; day < 5; day++) {
        const date = new Date(Date.UTC(2026, 10, 2 + week * 7 + day)).toISOString().slice(0, 10);
        for (let p = 0; p < 50; p++) {
          const start = p % 2 ? "06:00" : "12:00";
          const end = p % 2 ? "14:00" : "20:00";
          const { ms, value } = await timed(() => w.call("POST", "/api/rota/shifts", { date, start, end, staffId: staff[p] }, auth));
          shiftLat.push(ms);
          expect(value.status, JSON.stringify(value.body)).toBe(201);
          shifts++;
        }
      }
    }
    const week = await timed(() => w.call("GET", "/api/rota/week", undefined, auth, "date=2026-11-18"));
    expect((week.value.body as any).totalHours).toBe(50 * 5 * 8);

    // 500 sales a day for 30 days, each posted as a balanced entry.
    const postLat: number[] = [];
    for (let d = 0; d < 30; d++) {
      const date = new Date(Date.UTC(2026, 10, 1 + d)).toISOString().slice(0, 10);
      for (let s = 0; s < 500; s++) {
        const amt = 350 + ((s * 37) % 900);
        const { ms, value } = await timed(() => w.call("POST", "/api/finance/entries", { date, memo: `Sale ${d}-${s}`, source: `till:${d}-${s}`, lines: [{ account: "1000", debit: amt, credit: 0 }, { account: "4000", debit: 0, credit: amt }] }, auth));
        postLat.push(ms);
        if (value.status !== 201) throw new Error(JSON.stringify(value.body));
      }
    }
    w.clock.d = new Date("2026-11-30T18:00:00Z");
    // Sessions last 7 days and are not renewed: sign in again after the month.
    expect((await w.call("GET", "/api/org", undefined, auth)).status).toBe(401);
    auth = w.sessionFor("boss@bigcafe.test");
    const summary = await timed(() => w.call("GET", "/api/finance/summary", undefined, auth));
    expect(summary.value.status).toBe(200);

    // Through the day: 40 asks across the team (the AI providers answer in 0 ms, so this measures our own overhead).
    const team = (((await w.call("GET", "/api/org", undefined, auth)).body as any).team as any[]).filter((e) => e.templateKey !== "admin-manager");
    const askLat: number[] = [];
    const outcomes: Record<string, number> = {};
    for (let i = 0; i < 40; i++) {
      const e = team[i % team.length];
      const { ms, value } = await timed(() => w.call("POST", "/api/ask", { employeeId: e.id, text: i % 3 ? `Write the weekly staff update number ${i} for the team` : `What's on the rota tomorrow?`, urgent: i % 5 === 0 }, auth));
      askLat.push(ms);
      const st = (value.body as any).status ?? `http${value.status}`;
      outcomes[st] = (outcomes[st] ?? 0) + 1;
    }
    await w.platform.batch.idle();
    const dash = await timed(() => w.call("GET", "/api/dashboard", undefined, auth));
    expect(dash.value.status).toBe(200);
    const recon = await timed(() => w.platform.reconciliation.runOne(workspaceId));
    const ownerClients = await timed(() => w.call("GET", "/api/owner/clients", undefined, w.owner));
    const ctx = w.platform.rota.contextFor(workspaceId, "rota-coordinator", "2026-11-18") ?? "";
    metric("busy_business.month", {
      staff: staff.length, shifts, shiftAddMs: percentiles(shiftLat), rotaWeekMs: Math.round(week.ms),
      salesPosted: postLat.length, postEntryMs: percentiles(postLat), financeSummaryMs: Math.round(summary.ms),
      asks: askLat.length, askMs: percentiles(askLat), askOutcomes: outcomes,
      dashboardMs: Math.round(dash.ms), reconciliationMs: Math.round(recon.ms), ownerClientsMs: Math.round(ownerClients.ms),
      rotaContextChars: ctx.length, heapMb: Math.round(process.memoryUsage().heapUsed / 1e6),
      teamEnergy: ((await w.call("GET", "/api/org", undefined, auth)).body as any).teamEnergy,
    });
    // Screens a person waits on must answer well under a second even with a month of records.
    expect(summary.ms).toBeLessThan(1000);
    expect(dash.ms).toBeLessThan(1000);
    expect(week.ms).toBeLessThan(500);
  });
});
