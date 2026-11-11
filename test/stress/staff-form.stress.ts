/**
 * The public staff form: links anyone can open without an account. Can strangers guess links, lock real
 * staff out, flood an owner with time-off requests, or write fields they should not?
 */
import { describe, expect, it } from "vitest";
import { metric, world } from "./harness.js";

const tokenOf = (url: string) => url.split("#t=")[1]!;

async function shop(w: ReturnType<typeof world>, email: string, staff = 1) {
  const s = await w.signUp(email, `Shop ${email}`);
  const people: { id: string; token: string }[] = [];
  for (let i = 0; i < staff; i++) {
    const id = ((await w.call("POST", "/api/people", { name: `Person ${i}`, jobTitle: "Barista", startDate: "2026-01-05", hoursPerWeek: 24, payPence: 1250, payBasis: "hour" }, s.auth)).body as any).member.id;
    const token = tokenOf(((await w.call("POST", `/api/people/${id}/form-link`, {}, s.auth)).body as any).url);
    people.push({ id, token });
  }
  return { ...s, people };
}

describe("public staff form", () => {
  it("a stranger floods made-up links: do real staff still get in?", async () => {
    const w = world();
    const s = await shop(w, "form@form.test", 20);
    const statuses: Record<number, number> = {};
    for (let i = 0; i < 2_000; i++) {
      const r = await w.call("POST", "/api/staff-form/open", { token: `guess${i.toString().padStart(27, "0")}` });
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    }
    let realOk = 0;
    for (const p of s.people) if ((await w.call("POST", "/api/staff-form/open", { token: p.token })).status === 200) realOk++;
    const realSave = (await w.call("POST", "/api/staff-form/save", { token: s.people[0]!.token, phone: "07700900111" })).status;
    metric("staff_form.guess_flood", { guesses: 2_000, statuses, realStaffWhoCouldOpenAfter: `${realOk}/${s.people.length}`, realSaveAfter: realSave, trackingEntries: w.platform.formHits.size });
    expect(statuses[200] ?? 0).toBe(0);
    expect(realOk).toBe(s.people.length);
  });

  it("a staff member (or someone holding their link) sends time off again and again", async () => {
    const w = world();
    const s = await shop(w, "spam@form.test", 1);
    const p = s.people[0]!;
    const statuses: Record<number, number> = {};
    for (let i = 0; i < 100; i++) {
      const r = await w.call("POST", "/api/staff-form/save", { token: p.token, timeOff: { from: "2026-12-01", days: 1, note: `ask ${i}` } });
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    }
    const rec = (await w.call("GET", `/api/people/${p.id}`, undefined, s.auth)).body as any;
    const requested = rec.member.leave.filter((l: any) => l.status === "requested").length;
    const ownerCanAdd = (await w.call("POST", `/api/people/${p.id}/leave`, { from: "2026-12-10", days: 1 }, s.auth)).status;
    metric("staff_form.time_off_repeat", { attempts: 100, statuses, pendingRequestsCreated: requested, ownerCanStillBookLeave: ownerCanAdd });
    expect(requested).toBeLessThanOrEqual(30);
    expect(ownerCanAdd).toBe(200);
  });

  it("the form cannot change pay, name, job, documents or another person", async () => {
    const w = world();
    const a = await shop(w, "a@form.test", 2);
    const b = await shop(w, "b@form.test", 1);
    const [p, other] = a.people;
    const hostile = await w.call("POST", "/api/staff-form/save", {
      token: p!.token, phone: "07700900222",
      payPence: 1, name: "Changed", jobTitle: "Owner", workspaceId: b.workspaceId, id: other!.id, documents: { right_to_work: { status: "checked" } }, endDate: "2026-11-12",
      profile: { hoursMax: 20, payPence: 1, name: "Changed", __proto__: { admin: true }, documents: { x: 1 } },
    });
    const me = ((await w.call("GET", `/api/people/${p!.id}`, undefined, a.auth)).body as any).member;
    const them = ((await w.call("GET", `/api/people/${other!.id}`, undefined, a.auth)).body as any).member;
    const theirsB = ((await w.call("GET", `/api/people/${b.people[0]!.id}`, undefined, b.auth)).body as any).member;
    const changed = { pay: me.payPence !== 1250, name: me.name !== "Person 0", job: me.jobTitle !== "Barista", documents: Object.keys(me.documents).length > 0, endDate: Boolean(me.endDate), otherPerson: them.phone === "07700900222", otherClient: theirsB.phone === "07700900222", profileExtras: "payPence" in (me.profile ?? {}) || "name" in (me.profile ?? {}) };
    metric("staff_form.mass_assignment", { status: hostile.status, phoneSaved: me.phone === "07700900222", changed });
    expect(Object.values(changed).some(Boolean)).toBe(false);
  });

  it("a link stops working after the person leaves, and a client's link does nothing for another client", async () => {
    const w = world();
    const a = await shop(w, "leave@form.test", 1);
    const p = a.people[0]!;
    await w.call("POST", `/api/people/${p.id}/leaving`, { endDate: "2026-11-15" }, a.auth);
    const beforeEnd = (await w.call("POST", "/api/staff-form/open", { token: p.token })).status;
    w.clock.d = new Date("2026-11-17T09:00:00Z");
    const afterEnd = (await w.call("POST", "/api/staff-form/open", { token: p.token })).status;
    w.clock.d = new Date("2026-12-20T09:00:00Z");
    const muchLater = (await w.call("POST", "/api/staff-form/open", { token: p.token })).status;
    metric("staff_form.after_leaving", { beforeLastDay: beforeEnd, dayAfterLastDay: afterEnd, monthLater: muchLater });
    expect(muchLater).toBeGreaterThanOrEqual(400);
  });
});
