import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import {
  addMonths, completeness, documentViews, hrSummary, leaveBalance, leaveYear, requestMessage, requiredDocuments,
  sectorFromText, staffActions, staffStatus, type StaffMember,
} from "../src/modules/people/index.js";

const TODAY = "2026-11-11";

function person(over: Partial<StaffMember> = {}): StaffMember {
  return {
    id: "p1", workspaceId: "w1", name: "Priya Shah", jobTitle: "Barista", startDate: "2026-03-02", contract: "part_time",
    hoursPerWeek: 24, daysPerWeek: 3, pension: "enrolled", rtwRoute: "british_irish",
    documents: {}, checklist: {}, leave: [], reviews: [], createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z",
    ...over,
  };
}
const checked = (checkedOn = "2026-03-01", extra: Record<string, string> = {}) => ({ status: "checked" as const, checkedOn, updatedAt: "x", ...extra });
function complete(m: StaffMember, sector: Parameters<typeof requiredDocuments>[1]): StaffMember {
  const docs = Object.fromEntries(requiredDocuments(m, sector, TODAY).map((r) => [r.key, checked("2026-10-01")]));
  return { ...m, documents: docs, profile: { updatedOn: "2026-10-01" } };
}

describe("HR desk rules: which documents a person needs", () => {
  it("matches the setup form's industry answer to a sector", () => {
    expect(sectorFromText("Coffee shop and roastery")).toBe("hospitality");
    expect(sectorFromText("Domiciliary home care")).toBe("care");
    expect(sectorFromText("Day nursery")).toBe("childcare");
    expect(sectorFromText("Plumbing and heating")).toBe("construction");
    expect(sectorFromText("Something unusual")).toBe("other");
    expect(sectorFromText(undefined)).toBe("other");
  });

  it("gives everyone the core set and adds the sector's extras", () => {
    const keys = (s: Parameters<typeof requiredDocuments>[1]) => requiredDocuments(person(), s, TODAY).map((r) => r.key);
    for (const s of ["other", "hospitality", "care", "childcare", "construction", "retail", "transport", "security", "beauty", "office"] as const) {
      expect(keys(s)).toEqual(expect.arrayContaining(["right_to_work", "written_statement", "ni_number", "pension_assessment"]));
    }
    expect(keys("hospitality")).toContain("food_hygiene");
    expect(keys("care")).toContain("dbs_enhanced_adults");
    expect(keys("childcare")).toEqual(expect.arrayContaining(["dbs_enhanced_children", "safeguarding"]));
    expect(keys("security")).toContain("sia_licence");
    expect(requiredDocuments(person({ jobTitle: "Shop assistant" }), "other", TODAY).map((r) => r.key)).not.toContain("food_hygiene");
  });

  it("adds job and age extras once, whatever the sector", () => {
    const driver = requiredDocuments(person({ jobTitle: "Delivery driver and first aider" }), "retail", TODAY).map((r) => r.key);
    expect(driver).toEqual(expect.arrayContaining(["driving_licence_check", "first_aid"]));
    const chef = requiredDocuments(person({ jobTitle: "Chef" }), "hospitality", TODAY).map((r) => r.key);
    expect(chef.filter((k) => k === "food_hygiene")).toHaveLength(1);
    expect(requiredDocuments(person({ dateOfBirth: "2009-06-01" }), "retail", TODAY).map((r) => r.key)).toContain("young_worker_risk");
    expect(requiredDocuments(person({ dateOfBirth: "2000-06-01" }), "retail", TODAY).map((r) => r.key)).not.toContain("young_worker_risk");
  });
});

describe("HR desk rules: expiry, completeness and actions", () => {
  it("dates renewals from the check and warns 60 days ahead", () => {
    const m = person({ documents: { food_hygiene: checked(addMonths(TODAY, -35)) } });
    const v = documentViews(m, "hospitality", TODAY).find((d) => d.key === "food_hygiene")!;
    expect(v.state).toBe("expiring");
    expect(v.daysLeft).toBeGreaterThan(0);
    const old = documentViews(person({ documents: { food_hygiene: checked("2020-01-01") } }), "hospitality", TODAY).find((d) => d.key === "food_hygiene")!;
    expect(old.state).toBe("expired");
  });

  it("follows a time-limited right to work to its end date", () => {
    const m = person({ rtwRoute: "share_code", rtwExpiresOn: "2026-11-01", documents: { right_to_work: checked() } });
    const acts = staffActions(m, "other", TODAY);
    expect(acts[0]).toMatchObject({ severity: "critical", kind: "renew", ref: "right_to_work" });
    // British or Irish passport: no follow-up check, ever.
    const uk = person({ documents: { right_to_work: checked() } });
    expect(documentViews(uk, "other", TODAY).find((d) => d.key === "right_to_work")!.state).toBe("ok");
  });

  it("is critical when someone has started without a right-to-work check or contract", () => {
    const acts = staffActions(person(), "other", TODAY);
    const crit = acts.filter((a) => a.severity === "critical").map((a) => a.ref);
    expect(crit).toEqual(expect.arrayContaining(["right_to_work", "written_statement"]));
    expect(acts[0]!.severity).toBe("critical");
  });

  it("is high, not critical, for a starter next week, and low for one months away", () => {
    const soon = staffActions(person({ startDate: "2026-11-16" }), "other", TODAY).find((a) => a.ref === "right_to_work")!;
    expect(soon.severity).toBe("high");
    const later = staffActions(person({ startDate: "2027-03-01" }), "other", TODAY).find((a) => a.ref === "right_to_work")!;
    expect(later.severity).toBe("low");
  });

  it("asks to check a received document, and counts only checked, in-date ones as complete", () => {
    const m = person({ documents: { right_to_work: { status: "received", updatedAt: "x" } } });
    expect(staffActions(m, "other", TODAY).find((a) => a.ref === "right_to_work")).toMatchObject({ kind: "check", severity: "critical" });
    const full = complete(person(), "hospitality");
    expect(completeness(documentViews(full, "hospitality", TODAY))).toBe(100);
    expect(staffActions(full, "hospitality", TODAY)).toEqual([]);
    expect(completeness(documentViews(person(), "hospitality", TODAY))).toBe(0);
  });

  it("raises leave requests, due probation reviews and leaving checklists", () => {
    const m = complete(person({
      probationEndsOn: "2026-11-20",
      leave: [{ id: "l1", kind: "holiday", from: "2026-12-22", to: "2026-12-24", days: 3, status: "requested" }],
      endDate: "2026-11-30",
    }), "other");
    const kinds = staffActions(m, "other", TODAY).map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["approve_leave", "review", "checklist"]));
    expect(staffStatus(m, TODAY)).toBe("leaving");
    expect(staffStatus(m, "2026-12-01")).toBe("left");
  });

  it("summarises the desk: headcount, completeness, who is off", () => {
    const a = complete(person({ id: "a", leave: [{ id: "x", kind: "sick", from: TODAY, to: TODAY, days: 1, status: "approved" }] }), "other");
    const b = person({ id: "b", name: "Tom Reed" });
    const gone = person({ id: "c", name: "Old Hand", endDate: "2026-01-01" });
    const s = hrSummary([a, b, gone], "other", TODAY);
    expect(s.headcount).toBe(2);
    expect(s.offToday).toBe(1);
    expect(s.recordsComplete).toBe(50);
    expect(s.rows[0]!.name).toBe("Tom Reed");
    expect(s.rows.at(-1)!.status).toBe("left");
    expect(s.bySeverity.critical).toBeGreaterThan(0);
  });
});

describe("HR desk rules: holiday", () => {
  it("gives 5.6 weeks pro rata to days, capped at 28", () => {
    const full = person({ contract: "full_time", daysPerWeek: 6, startDate: "2020-01-01" });
    expect(leaveBalance(full, TODAY).allowance).toBe(28);
    expect(leaveBalance(person({ startDate: "2020-01-01" }), TODAY).allowance).toBeCloseTo(16.8);
  });

  it("pro-rates a first year to the half day, and follows the leave year", () => {
    const b = leaveBalance(person({ contract: "full_time", daysPerWeek: 5, startDate: "2026-07-01" }), TODAY);
    // 28 days x 184 of 365 days = 14.1, rounded up to the half day.
    expect(b.allowance).toBe(14.5);
    expect(leaveYear("2026-02-10", 4)).toEqual({ start: "2025-04-01", end: "2026-03-31" });
  });

  it("splits taken, booked and requested, and uses accrual for zero-hours staff", () => {
    const m = person({ startDate: "2020-01-01", leave: [
      { id: "1", kind: "holiday", from: "2026-08-03", to: "2026-08-07", days: 3, status: "approved" },
      { id: "2", kind: "holiday", from: "2026-12-28", to: "2026-12-29", days: 2, status: "approved" },
      { id: "3", kind: "holiday", from: "2026-12-30", to: "2026-12-30", days: 1, status: "requested" },
      { id: "4", kind: "sick", from: "2026-05-01", to: "2026-05-01", days: 1, status: "approved" },
    ] });
    const b = leaveBalance(m, TODAY);
    expect(b).toMatchObject({ taken: 3, booked: 2, requested: 1, sickDays: 1 });
    expect(b.left).toBeCloseTo(11.8);
    expect(leaveBalance(person({ contract: "zero_hours" }), TODAY).basis).toBe("accrual");
  });

  it("writes a ready-to-send request for a missing document", () => {
    const req = requiredDocuments(person(), "other", TODAY).find((r) => r.key === "right_to_work")!;
    expect(requestMessage(person(), req, "Kestrel Coffee")).toMatch(/^Hi Priya, .*right-to-work check before your first day/);
  });
});

function setup() {
  const clock = { d: new Date("2026-11-11T09:00:00Z") };
  const platform = createPlatform({ sessionSecret: "s4", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", now: () => clock.d });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const sessionFor = (email: string) => ({ authorization: `Bearer ${makeToken("s4", { k: "session", u: userIdFor(email), e: email }, 7 * 86400, clock.d.getTime())}` });
  const signUp = async (email: string, businessName: string) => {
    const r = await call("POST", "/api/signup", { email, businessName, sells: "Coffee", size: "2–10", country: "GB" });
    return { authorization: `Bearer ${(r.body as any).token}` };
  };
  return { platform, call, clock, sessionFor, signUp };
}

describe("HR desk API", () => {
  it("adds a person with five answers, puts them on the rota, and tracks their documents", async () => {
    const { call, signUp, platform } = setup();
    const me = await signUp("owner@kestrel.test", "Kestrel Coffee");
    expect((await call("POST", "/api/people/settings", { sector: "hospitality" }, me)).status).toBe(200);
    const add = await call("POST", "/api/people", { name: "Priya Shah", jobTitle: "Barista", startDate: "2026-11-16", contract: "part_time", hoursPerWeek: 24, payPence: 1250, payBasis: "hour" }, me);
    expect(add.status).toBe(201);
    const d = add.body as any;
    expect(d.member.daysPerWeek).toBe(3);
    expect(d.status).toBe("starting");
    expect(d.documents.map((x: any) => x.key)).toContain("food_hygiene");
    expect(d.member.rotaStaffId).toBeTruthy();
    const week = await call("GET", "/api/rota/week", undefined, me);
    expect((week.body as any).staff.map((s: any) => s.name)).toContain("Priya Shah");

    const id = d.member.id;
    const doc = await call("POST", `/api/people/${id}/documents/right_to_work`, { status: "checked" }, me);
    expect((doc.body as any).documents.find((x: any) => x.key === "right_to_work").state).toBe("ok");
    expect((doc.body as any).documents.find((x: any) => x.key === "right_to_work").doc.checkedOn).toBe("2026-11-11");

    const ov = (await call("GET", "/api/people", undefined, me)).body as any;
    expect(ov.summary.headcount).toBe(1);
    expect(ov.summary.rows[0]).not.toHaveProperty("payPence");

    const leave = await call("POST", `/api/people/${id}/leave`, { from: "2026-12-22", to: "2026-12-23", days: 2, status: "requested" }, me);
    const lid = (leave.body as any).member.leave[0].id;
    const ok = await call("POST", `/api/people/${id}/leave/${lid}/decide`, { approve: true }, me);
    expect((ok.body as any).leave.booked).toBe(2);

    const tick = await call("POST", `/api/people/${id}/checklist/on_offer`, { done: true }, me);
    expect((tick.body as any).onboarding.find((i: any) => i.key === "on_offer").doneOn).toBe("2026-11-11");
    const ws = platform.identity.workspacesFor(userIdFor("owner@kestrel.test"))[0]!;
    const actions = platform.audit.list(ws.id).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["people.added", "people.document_updated", "people.leave_decided", "people.checklist_updated"]));
  });

  it("says when a person could not also go on the rota, and caps the overview's action list", async () => {
    const { call, signUp } = setup();
    const me = await signUp("owner@kestrel.test", "Kestrel Coffee");
    const person = (name: string) => ({ name, jobTitle: "Barista", startDate: "2026-11-16", hoursPerWeek: 20 });
    expect((await call("POST", "/api/people", person("Sam Lee"), me)).body).not.toHaveProperty("rotaNote");
    const twin = (await call("POST", "/api/people", person("Sam Lee"), me)).body as any;
    expect(twin.member.rotaStaffId).toBeUndefined();
    expect(twin.rotaNote).toMatch(/not added to the rota: someone with that name/);
    for (let i = 0; i < 10; i++) await call("POST", "/api/people", person(`Person ${i}`), me);
    const ov = (await call("GET", "/api/people", undefined, me)).body as any;
    expect(ov.summary.actionsTotal).toBeGreaterThan(50);
    expect(ov.summary.actions).toHaveLength(50);
    expect(ov.summary.headcount).toBe(12);
  });

  it("refuses bad input with a clear message", async () => {
    const { call, signUp } = setup();
    const me = await signUp("owner@kestrel.test", "Kestrel Coffee");
    const bad = async (b: unknown) => (await call("POST", "/api/people", b, me)) as any;
    expect((await bad({ jobTitle: "Barista", startDate: "2026-11-16", hoursPerWeek: 20 })).body.error).toMatch(/name is needed/);
    expect((await bad({ name: "A", jobTitle: "B", startDate: "2026-02-30", hoursPerWeek: 20 })).body.error).toMatch(/date/);
    expect((await bad({ name: "A", jobTitle: "B", startDate: "2026-11-16", hoursPerWeek: 200 })).body.error).toMatch(/between/);
    expect((await bad({ name: "A".repeat(500), jobTitle: "B", startDate: "2026-11-16", hoursPerWeek: 20 })).body.error).toMatch(/too long/);
    expect((await bad({ name: "A", jobTitle: "B", startDate: "2026-11-16", hoursPerWeek: 20, contract: "slave" })).status).toBe(400);
    const p = (await bad({ name: "A", jobTitle: "B", startDate: "2026-11-16", hoursPerWeek: 20 })).body.member;
    expect((await call("POST", `/api/people/${p.id}/documents/not_a_doc`, { status: "checked" }, me)).status).toBe(400);
    expect((await call("POST", `/api/people/${p.id}/documents/right_to_work`, { status: "checked", checkedOn: "2027-01-01" }, me)).status).toBe(400);
    expect((await call("POST", `/api/people/${p.id}/leave`, { from: "2026-12-10", to: "2026-12-01", days: 1 }, me)).status).toBe(400);
    expect((await call("POST", `/api/people/${p.id}/leave`, { from: "2026-12-10", days: 0.3 }, me)).status).toBe(400);
  });

  it("keeps one client's staff away from another and from members", async () => {
    const { call, signUp, platform, sessionFor } = setup();
    const a = await signUp("a@one.test", "One Ltd");
    const b = await signUp("b@two.test", "Two Ltd");
    const p = ((await call("POST", "/api/people", { name: "Secret", jobTitle: "Chef", startDate: "2026-01-05", hoursPerWeek: 40 }, a)).body as any).member;
    expect((await call("GET", `/api/people/${p.id}`, undefined, b)).status).toBe(400);
    expect(((await call("GET", "/api/people", undefined, b)).body as any).summary.headcount).toBe(0);
    // A member of One Ltd (not owner or admin) cannot read staff records.
    const ws = platform.identity.workspacesFor(userIdFor("a@one.test"))[0]!;
    await platform.identity.addMember(userIdFor("a@one.test"), ws.id, userIdFor("m@one.test"), "member");
    expect((await call("GET", "/api/people", undefined, sessionFor("m@one.test"))).status).toBe(403);
  });

  it("only deletes a record after the person has left, and takes leavers off the rota", async () => {
    const { call, signUp, clock } = setup();
    const me = await signUp("owner@kestrel.test", "Kestrel Coffee");
    const p = ((await call("POST", "/api/people", { name: "Leaver", jobTitle: "Barista", startDate: "2026-01-05", hoursPerWeek: 30 }, me)).body as any).member;
    expect((await call("DELETE", `/api/people/${p.id}`, undefined, me)).status).toBe(400);
    const left = await call("POST", `/api/people/${p.id}/leaving`, { endDate: "2026-11-10" }, me);
    expect((left.body as any).status).toBe("left");
    const week = (await call("GET", "/api/rota/week", undefined, me)).body as any;
    expect(week.staff.map((s: any) => s.name)).not.toContain("Leaver");
    clock.d = new Date("2026-11-12T09:00:00Z");
    expect((await call("DELETE", `/api/people/${p.id}`, undefined, me)).status).toBe(200);
    expect((await call("GET", `/api/people/${p.id}`, undefined, me)).status).toBe(400);
  });

  it("tells the HR manager the action list, without pay or contact details", async () => {
    const { call, signUp, platform } = setup();
    const me = await signUp("owner@kestrel.test", "Kestrel Coffee");
    await call("POST", "/api/people", { name: "Priya Shah", jobTitle: "Barista", startDate: "2026-01-05", hoursPerWeek: 24, payPence: 1250, payBasis: "hour", phone: "07700900123" }, me);
    const ws = platform.identity.workspacesFor(userIdFor("owner@kestrel.test"))[0]!;
    const ctx = platform.people.contextFor(ws.id, "hr-manager")!;
    expect(ctx).toMatch(/Priya Shah: Right-to-work check missing/);
    expect(ctx).not.toMatch(/1250|07700/);
    expect(platform.people.contextFor(ws.id, "marketing-manager")).toBeUndefined();
  });
});
