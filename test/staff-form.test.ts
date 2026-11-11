import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { PeopleError, readProfile, staffActions, type StaffMember } from "../src/modules/people/index.js";

function setup() {
  const clock = { d: new Date("2026-11-11T09:00:00Z") }; // a Wednesday
  const platform = createPlatform({ sessionSecret: "s5", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", now: () => clock.d });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const sessionFor = (email: string) => ({ authorization: `Bearer ${makeToken("s5", { k: "session", u: userIdFor(email), e: email }, 7 * 86400, clock.d.getTime())}` });
  const signUp = async (email: string, businessName: string) => {
    const r = await call("POST", "/api/signup", { email, businessName, sells: "Coffee", size: "2–10", country: "GB" });
    return { authorization: `Bearer ${(r.body as any).token}` };
  };
  const addPerson = async (me: Record<string, string>, name = "Priya Shah") =>
    ((await call("POST", "/api/people", { name, jobTitle: "Barista", startDate: "2026-01-05", hoursPerWeek: 24 }, me)).body as any).member;
  const tokenOf = (url: string) => url.split("#t=")[1]!;
  return { platform, call, clock, sessionFor, signUp, addPerson, tokenOf };
}

describe("staff profile answers", () => {
  it("keeps only valid answers and the questions for this sector", () => {
    const p = readProfile({
      hoursMin: 16, hoursMax: 30, maxShiftHours: 8,
      availability: [{ day: 0, off: true }, { day: 2, from: "09:00", to: "15:00" }, { day: 4 }],
      prefers: ["early", "early"], avoids: ["night"],
      skills: [{ name: "Food hygiene level 2", expiresOn: "2027-05-01" }, { name: "" }],
      transport: "public",
      sectorAnswers: { allergen_trained: true, languages: "English, Polish", cscs_card: "Gold" },
    }, "hospitality");
    expect(p.availability).toEqual([{ day: 0, off: true }, { day: 2, from: "09:00", to: "15:00" }]);
    expect(p.prefers).toEqual(["early"]);
    expect(p.skills).toEqual([{ name: "Food hygiene level 2", expiresOn: "2027-05-01" }]);
    expect(p.sectorAnswers).toEqual({ allergen_trained: true, languages: "English, Polish" });
  });

  it("refuses answers that cannot be right, with a plain message", () => {
    const bad = (b: Record<string, unknown>) => () => readProfile(b, "retail");
    expect(bad({ hoursMin: 30, hoursMax: 10 })).toThrow(/fewest hours are more than the most/);
    expect(bad({ availability: [{ day: 7 }] })).toThrow(PeopleError);
    expect(bad({ availability: [{ day: 1, from: "9am", to: "5pm" }] })).toThrow(/look like 09:00/);
    expect(bad({ availability: [{ day: 1, off: true }, { day: 1, off: true }] })).toThrow(/listed twice/);
    expect(bad({ prefers: ["late"], avoids: ["late"] })).toThrow(/both preferred and avoided/);
    expect(bad({ skills: Array.from({ length: 31 }, (_, i) => ({ name: `s${i}` })) })).toThrow(/at most 30/);
    expect(bad({ transport: "rocket" })).toThrow(/not one of the choices/);
    expect(bad({ sectorAnswers: { can_open_close: "maybe" } })).toThrow(/yes or no/);
  });

  it("asks for the form when nobody has filled it in, and warns about skills running out", () => {
    const m: StaffMember = {
      id: "p1", workspaceId: "w1", name: "Priya Shah", jobTitle: "Shop assistant", startDate: "2026-03-02", contract: "part_time",
      hoursPerWeek: 24, daysPerWeek: 3, pension: "enrolled", rtwRoute: "british_irish", documents: {}, checklist: {}, leave: [], reviews: [],
      createdAt: "x", updatedAt: "x",
    };
    expect(staffActions(m, "other", "2026-11-11").map((a) => a.kind)).toContain("send_form");
    const filled = { ...m, profile: { updatedOn: "2026-11-01", skills: [{ name: "Forklift", expiresOn: "2026-12-01" }] } };
    const acts = staffActions(filled, "other", "2026-11-11");
    expect(acts.map((a) => a.kind)).not.toContain("send_form");
    expect(acts.find((a) => a.kind === "skill")?.title).toBe("Forklift expires in 20 days");
  });
});

describe("staff form link", () => {
  it("lets the person fill in their details and ask for time off, without an account", async () => {
    const { call, signUp, addPerson, tokenOf, platform } = setup();
    const me = await signUp("owner@kestrel.test", "Kestrel Coffee");
    await call("POST", "/api/people/settings", { sector: "hospitality" }, me);
    const p = await addPerson(me);
    const link = await call("POST", `/api/people/${p.id}/form-link`, {}, me);
    expect(link.status).toBe(201);
    const { url, expiresOn } = link.body as any;
    expect(url).toMatch(/^https:\/\/app\.test\/staff-form\.html#t=[\w-]{32}$/);
    expect(expiresOn).toBe("2026-11-25");

    const token = tokenOf(url);
    const view = (await call("POST", "/api/staff-form/open", { token })).body as any;
    expect(view).toMatchObject({ businessName: "Kestrel Coffee", firstName: "Priya", jobTitle: "Barista" });
    expect(view.questions.map((q: any) => q.key)).toContain("allergen_trained");
    expect(JSON.stringify(view)).not.toMatch(/payPence|documents|hash/);

    const saved = await call("POST", "/api/staff-form/save", {
      token, phone: "07700900123",
      profile: { emergencyName: "Raj Shah", emergencyRelation: "Brother", emergencyPhone: "07700900456", availability: [{ day: 0, off: true }], hoursMax: 30, sectorAnswers: { allergen_trained: true } },
      timeOff: { from: "2026-12-22", to: "2026-12-24", days: 3, note: "Family visit" },
    });
    expect(saved.status).toBe(200);
    expect((saved.body as any).pending).toEqual([{ from: "2026-12-22", to: "2026-12-24", days: 3 }]);

    const d = (await call("GET", `/api/people/${p.id}`, undefined, me)).body as any;
    expect(d.member.profile).toMatchObject({ emergencyName: "Raj Shah", hoursMax: 30, updatedBy: "staff" });
    expect(d.member.phone).toBe("07700900123");
    expect(d.member.formLink).toEqual({ createdOn: "2026-11-11", expiresOn: "2026-11-25", usedOn: "2026-11-11" });
    expect(d.documents.find((x: any) => x.key === "emergency_contact").state).toBe("ok");
    expect(d.actions.find((a: any) => a.kind === "approve_leave")).toBeTruthy();

    const ws = platform.identity.workspacesFor(userIdFor("owner@kestrel.test"))[0]!;
    const log = platform.audit.list(ws.id);
    expect(log.find((e) => e.action === "people.form_submitted")?.actor).toBe(`staff:${p.id}`);
    expect(JSON.stringify(log)).not.toContain(token);
  });

  it("stops working when it expires, is replaced or stopped, or the person leaves", async () => {
    const { call, signUp, addPerson, tokenOf, clock } = setup();
    const me = await signUp("owner@kestrel.test", "Kestrel Coffee");
    const p = await addPerson(me);
    const open = async (token: string) => (await call("POST", "/api/staff-form/open", { token })).status;
    const first = tokenOf(((await call("POST", `/api/people/${p.id}/form-link`, {}, me)).body as any).url);
    const second = tokenOf(((await call("POST", `/api/people/${p.id}/form-link`, {}, me)).body as any).url);
    expect(await open(first)).toBe(400);
    expect(await open(second)).toBe(200);
    expect(await open("x".repeat(32))).toBe(400);
    expect(await open("")).toBe(400);

    clock.d = new Date("2026-11-26T09:00:00Z");
    expect(await open(second)).toBe(400);
    clock.d = new Date("2026-11-11T09:00:00Z");
    expect(await open(second)).toBe(200);
    await call("DELETE", `/api/people/${p.id}/form-link`, undefined, me);
    expect(await open(second)).toBe(400);

    const third = tokenOf(((await call("POST", `/api/people/${p.id}/form-link`, {}, me)).body as any).url);
    await call("POST", `/api/people/${p.id}/leaving`, { endDate: "2026-11-10" }, me);
    expect(await open(third)).toBe(400);
    expect((await call("POST", `/api/people/${p.id}/form-link`, {}, me)).status).toBe(400);
  });

  it("refuses bad time off, too many tries, and anyone but the owner or an admin making links", async () => {
    const { call, signUp, addPerson, tokenOf, platform, sessionFor } = setup();
    const me = await signUp("owner@kestrel.test", "Kestrel Coffee");
    const p = await addPerson(me);
    const token = tokenOf(((await call("POST", `/api/people/${p.id}/form-link`, {}, me)).body as any).url);
    const save = (b: Record<string, unknown>) => call("POST", "/api/staff-form/save", { token, ...b });
    expect(((await save({ timeOff: { from: "2026-11-01", days: 1 } })).body as any).error).toMatch(/today or later/);
    expect(((await save({ timeOff: { from: "2026-12-01", days: 0.3 } })).body as any).error).toMatch(/between 0.5/);
    expect(((await save({ email: "not-an-email" })).body as any).error).toMatch(/does not look right/);

    const ws = platform.identity.workspacesFor(userIdFor("owner@kestrel.test"))[0]!;
    await platform.identity.addMember(userIdFor("owner@kestrel.test"), ws.id, userIdFor("m@kestrel.test"), "member");
    expect((await call("POST", `/api/people/${p.id}/form-link`, {}, sessionFor("m@kestrel.test"))).status).toBe(403);

    let last = 0;
    for (let i = 0; i < 31; i++) last = (await call("POST", "/api/staff-form/open", { token })).status;
    expect(last).toBe(429);
  });
});

describe("availability reaches the rota", () => {
  it("refuses shifts on days off, outside the hours given, too long, or during approved time off", async () => {
    const { call, signUp } = setup();
    const me = await signUp("owner@kestrel.test", "Kestrel Coffee");
    const p = ((await call("POST", "/api/people", { name: "Tom Reed", jobTitle: "Barista", startDate: "2026-01-05", hoursPerWeek: 24 }, me)).body as any).member;
    await call("POST", `/api/people/${p.id}/profile`, { availability: [{ day: 0, off: true }, { day: 1, from: "09:00", to: "15:00" }], maxShiftHours: 6, hoursMax: 10 }, me);
    await call("POST", `/api/people/${p.id}/leave`, { from: "2026-11-20", to: "2026-11-20", days: 1 }, me);
    const shift = async (date: string, start: string, end: string) => (await call("POST", "/api/rota/shifts", { date, start, end, staffId: p.rotaStaffId }, me)) as any;

    expect((await shift("2026-11-16", "09:00", "13:00")).body.error).toMatch(/not available on Mondays/);
    expect((await shift("2026-11-17", "12:00", "17:00")).body.error).toMatch(/only work 09:00 to 15:00 on Tuesdays/);
    expect((await shift("2026-11-19", "08:00", "15:00")).body.error).toMatch(/at most 6 hours/);
    expect((await shift("2026-11-20", "09:00", "12:00")).body.error).toMatch(/approved time off/);
    expect((await shift("2026-11-17", "09:00", "15:00")).status).toBe(201);
    expect((await shift("2026-11-18", "09:00", "14:00")).body.error).toMatch(/over the 10h limit/);

    const week = (await call("GET", "/api/rota/week", { }, me)).body as any;
    expect(week.hoursByPerson.find((h: any) => h.name === "Tom Reed").cap).toBe(10);
  });

  it("tells the HR manager when people can work, but not their emergency contact", async () => {
    const { call, signUp, platform } = setup();
    const me = await signUp("owner@kestrel.test", "Kestrel Coffee");
    const p = ((await call("POST", "/api/people", { name: "Tom Reed", jobTitle: "Barista", startDate: "2026-01-05", hoursPerWeek: 24 }, me)).body as any).member;
    await call("POST", `/api/people/${p.id}/profile`, { availability: [{ day: 6, off: true }], prefers: ["early"], emergencyName: "Ann Reed", emergencyPhone: "07700900999" }, me);
    const ws = platform.identity.workspacesFor(userIdFor("owner@kestrel.test"))[0]!;
    const ctx = platform.people.contextFor(ws.id, "hr-manager")!;
    expect(ctx).toMatch(/When Tom Reed can work: Sunday: not available; prefers early/);
    expect(ctx).not.toMatch(/Ann Reed|07700900999/);
    expect(platform.rota.contextFor(ws.id, "rota-coordinator", "2026-11-11")).toMatch(/Tom Reed limits: Sunday off/);
  });
});
