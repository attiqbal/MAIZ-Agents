/**
 * The HR desk under load: a full staff list, many clients' staff in one server, every document and
 * leave limit, and cross-client probing of staff ids.
 */
import { describe, expect, it } from "vitest";
import { inParallel, metric, percentiles, timed, uid, world } from "./harness.js";

const JOBS = ["Barista", "Chef", "Delivery driver", "Shop assistant", "Care worker", "Kitchen porter", "Supervisor", "Cleaner"];
const person = (i: number) => ({ name: `Staff ${i}`, jobTitle: JOBS[i % JOBS.length], startDate: "2026-01-05", hoursPerWeek: 10 + (i % 30), payPence: 1250, payBasis: "hour", phone: "07700900123" });

describe("HR desk", () => {
  it("one client fills the staff list to its 1,000 limit: add, desk, record and document times", async () => {
    const w = world();
    const c = await w.signUp("hr@hr.test", "Big Kitchen Ltd");
    await w.call("POST", "/api/people/settings", { sector: "hospitality" }, c.auth);
    const adds: number[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 1_000; i++) {
      const r = await timed(() => w.call("POST", "/api/people", person(i), c.auth));
      expect(r.value.status).toBe(201);
      adds.push(r.ms);
      ids.push((r.value.body as any).member.id);
    }
    const over = await w.call("POST", "/api/people", person(1_000), c.auth);
    const docs: number[] = [];
    for (const id of ids.slice(0, 200)) docs.push((await timed(() => w.call("POST", `/api/people/${id}/documents/right_to_work`, { status: "checked" }, c.auth))).ms);
    const desk = await timed(() => w.call("GET", "/api/people", undefined, c.auth));
    const one = await timed(() => w.call("GET", `/api/people/${ids[500]}`, undefined, c.auth));
    const week = await timed(() => w.call("GET", "/api/rota/week", undefined, c.auth));
    const ctx = w.platform.people.contextFor(c.workspaceId, "hr-manager")!;
    const body = desk.value.body as any;
    metric("people.full_staff_list", {
      staff: 1_000, addMs: percentiles(adds), the1001st: { status: over.status, error: (over.body as any).error },
      documentUpdateMs: percentiles(docs), deskMs: Math.round(desk.ms), deskBytes: JSON.stringify(body).length,
      recordMs: Math.round(one.ms), rotaWeekMs: Math.round(week.ms), rotaStaff: (week.value.body as any).staff.length,
      actionsOnDesk: body.summary.actions.length, hrManagerContextChars: ctx.length, payOrPhoneInDesk: /1250|07700/.test(JSON.stringify(body)),
    });
    expect(over.status).toBe(400);
    expect(body.summary.headcount).toBe(1_000);
    expect(JSON.stringify(body)).not.toMatch(/07700/);
  });

  it("500 clients with 40 staff each in one server: is a small client's desk slowed by everyone else's staff?", async () => {
    const w = world();
    const cs = await inParallel(Array.from({ length: 500 }, (_, i) => i), 50, (i) => w.signUp(`hrc${i}@hr.test`, `Client ${i}`));
    const firstDesk = await timed(() => w.call("GET", "/api/people", undefined, cs[0]!.auth));
    await inParallel(cs, 25, async (c) => { for (let k = 0; k < 40; k++) await w.call("POST", "/api/people", person(k), c.auth); });
    const desks: number[] = [];
    const adds: number[] = [];
    for (let k = 0; k < 30; k++) {
      const c = cs[(k * 17) % cs.length]!;
      desks.push((await timed(() => w.call("GET", "/api/people", undefined, c.auth))).ms);
      adds.push((await timed(() => w.call("POST", "/api/people", person(99), c.auth))).ms);
    }
    metric("people.20k_staff_one_server", { clients: 500, staffEach: 40, totalStaff: 20_000, emptyDeskBeforeMs: Math.round(firstDesk.ms), deskMs: percentiles(desks), addMs: percentiles(adds), heapMb: Math.round(process.memoryUsage().heapUsed / 1e6) });
    expect(desks.length).toBe(30);
  });

  it("leave, reviews and documents at their limits, and odd dates", async () => {
    const w = world();
    const c = await w.signUp("lim@hr.test", "Limits Ltd");
    const id = ((await w.call("POST", "/api/people", person(1), c.auth)).body as any).member.id;
    const leave: number[] = [];
    for (let i = 0; i < 405; i++) leave.push((await w.call("POST", `/api/people/${id}/leave`, { kind: "holiday", from: "2026-12-01", to: "2026-12-01", days: 1 }, c.auth)).status);
    const reviews: number[] = [];
    for (let i = 0; i < 103; i++) reviews.push((await w.call("POST", `/api/people/${id}/reviews`, { kind: "one_to_one", dueOn: "2026-12-01" }, c.auth)).status);
    const odd = {
      leaveOverAYear: (await w.call("POST", `/api/people/${id}/leave`, { from: "2026-01-01", to: "2027-06-01", days: 300 }, c.auth)).status,
      leaveFeb30: (await w.call("POST", `/api/people/${id}/leave`, { from: "2026-02-30", days: 1 }, c.auth)).status,
      futureCheck: (await w.call("POST", `/api/people/${id}/documents/right_to_work`, { status: "checked", checkedOn: "2030-01-01" }, c.auth)).status,
      unknownDoc: (await w.call("POST", `/api/people/${id}/documents/nope`, { status: "checked" }, c.auth)).status,
      leavingBeforeStart: (await w.call("POST", `/api/people/${id}/leaving`, { endDate: "2025-01-01" }, c.auth)).status,
      deleteBeforeLeaving: (await w.call("DELETE", `/api/people/${id}`, undefined, c.auth)).status,
      hugeNote: (await w.call("POST", `/api/people/${id}/documents/right_to_work`, { status: "checked", note: "x".repeat(50_000) }, c.auth)).status,
      htmlName: (await w.call("POST", "/api/people", { ...person(2), name: "<img src=x onerror=alert(1)>" }, c.auth)).status,
    };
    const rec = (await w.call("GET", `/api/people/${id}`, undefined, c.auth)).body as any;
    metric("people.limits", { leaveAccepted: leave.filter((s) => s === 200).length, leaveRefused: leave.filter((s) => s === 400).length, reviewsAccepted: reviews.filter((s) => s === 200).length, reviewsRefused: reviews.filter((s) => s === 400).length, odd, recordBytes: JSON.stringify(rec).length });
    expect(leave.filter((s) => s === 200)).toHaveLength(400);
    expect(odd.futureCheck).toBe(400);
    expect(odd.deleteBeforeLeaving).toBe(400);
  });

  it("staff records stay inside their client: 50 clients probe each other's staff ids", async () => {
    const w = world();
    const cs = await inParallel(Array.from({ length: 50 }, (_, i) => i), 25, (i) => w.signUp(`iso${i}@hr.test`, `Iso ${i}`));
    const ids = await inParallel(cs, 25, async (c) => ((await w.call("POST", "/api/people", person(0), c.auth)).body as any).member.id as string);
    let attempts = 0, crossed = 0;
    const probes: [string, string, unknown?][] = [["GET", ""], ["POST", "", { name: "Hijacked" }], ["POST", "/documents/right_to_work", { status: "checked" }], ["POST", "/leave", { from: "2026-12-01", days: 1 }], ["POST", "/leaving", { endDate: "2026-11-10" }], ["DELETE", ""]];
    for (let a = 0; a < cs.length; a++) for (let b = 0; b < cs.length; b++) {
      if (a === b) continue;
      for (const [m, suffix, body] of probes) {
        attempts++;
        const r = await w.call(m as any, `/api/people/${ids[b]}${suffix}`, body, cs[a]!.auth);
        if (r.status < 400) crossed++;
      }
    }
    // A member who is not owner or admin cannot open the desk.
    const ws = cs[0]!.workspaceId;
    await w.platform.identity.addMember(uid("iso0@hr.test"), ws, uid("member@hr.test"), "member");
    const member = (await w.call("GET", "/api/people", undefined, w.sessionFor("member@hr.test"))).status;
    const untouched = ((await w.call("GET", `/api/people/${ids[1]}`, undefined, cs[1]!.auth)).body as any).member.name;
    metric("people.isolation", { clients: 50, crossClientAttempts: attempts, crossed, memberDeskStatus: member, victimRecordName: untouched });
    expect(crossed).toBe(0);
    expect(member).toBe(403);
    expect(untouched).toBe("Staff 0");
  });

  it("two managers update the same person's documents at once: no update is lost", async () => {
    const w = world();
    const c = await w.signUp("race@hr.test", "Race Ltd");
    await w.call("POST", "/api/people/settings", { sector: "care" }, c.auth);
    const id = ((await w.call("POST", "/api/people", { ...person(0), jobTitle: "Care worker driver first aider" }, c.auth)).body as any).member.id;
    const keys = ((await w.call("GET", `/api/people/${id}`, undefined, c.auth)).body as any).documents.map((d: any) => d.key) as string[];
    await Promise.all(keys.map((k) => w.call("POST", `/api/people/${id}/documents/${k}`, { status: "checked" }, c.auth)));
    const after = ((await w.call("GET", `/api/people/${id}`, undefined, c.auth)).body as any);
    const checkedCount = after.documents.filter((d: any) => d.doc?.status === "checked").length;
    metric("people.concurrent_document_updates", { documents: keys.length, checkedAfter: checkedCount, completeness: after.completeness ?? after.summary?.complete });
    expect(checkedCount).toBe(keys.length);
  });
});
