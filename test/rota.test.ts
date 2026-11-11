import { describe, expect, it } from "vitest";
import { createApp, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { weekStart } from "../src/modules/rota/index.js";

function setup() {
  const clock = { d: new Date("2026-11-10T09:00:00Z") };
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", now: () => clock.d });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, query = "") =>
    handle({ method, path, query: new URLSearchParams(query), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const signUp = async (email: string, name: string) => {
    const r = await call("POST", "/api/signup", { email, businessName: name, sells: "Coffee", size: "2–10", country: "GB" });
    return { authorization: `Bearer ${(r.body as any).token}` };
  };
  return { platform, call, signUp };
}

describe("rota", () => {
  it("finds the Monday of a week", () => {
    expect(weekStart("2026-11-10")).toBe("2026-11-09"); // a Tuesday
    expect(weekStart("2026-11-15")).toBe("2026-11-09"); // Sunday
    expect(weekStart("2026-11-16")).toBe("2026-11-16");
  });

  it("builds a week with hours and cost from the shifts, not from a model", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const mo = (await s.call("POST", "/api/rota/staff", { name: "Mo", role: "Barista", hourlyRateMinor: 1200 }, ann)).body as any;
    const bea = (await s.call("POST", "/api/rota/staff", { name: "Bea" }, ann)).body as any;
    expect(mo.added.name).toBe("Mo");
    await s.call("POST", "/api/rota/shifts", { date: "2026-11-10", start: "08:00", end: "16:00", staffId: mo.added.id }, ann);
    await s.call("POST", "/api/rota/shifts", { date: "2026-11-11", start: "08:00", end: "12:30", staffId: mo.added.id }, ann);
    const open = (await s.call("POST", "/api/rota/shifts", { date: "2026-11-12", start: "10:00", end: "14:00" }, ann)).body as any;
    expect(open.openShifts).toBe(1);
    const week = (await s.call("GET", "/api/rota/week", undefined, ann, "date=2026-11-12")).body as any;
    expect(week.weekStart).toBe("2026-11-09");
    expect(week.hoursByPerson.find((p: any) => p.name === "Mo")).toMatchObject({ hours: 12.5, costMinor: 15000 });
    expect(week.totalHours).toBe(12.5);
    // Bea has no hours and no rate, so the total is still known; give her hours without a rate and it is not.
    const shiftId = open.shift.id;
    const assigned = (await s.call("POST", `/api/rota/shifts/${shiftId}/assign`, { staffId: bea.added.id }, ann)).body as any;
    expect(assigned.openShifts).toBe(0);
    expect(assigned.totalCostMinor).toBeNull();
  });

  it("refuses overlaps, short rest, over-long weeks, bad times and other clients' people", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const bob = await s.signUp("bob@northside.co", "Northside Bikes");
    const mo = ((await s.call("POST", "/api/rota/staff", { name: "Mo", maxHoursPerWeek: 20 }, ann)).body as any).added.id;
    const add = (b: any) => s.call("POST", "/api/rota/shifts", { staffId: mo, ...b }, ann);
    expect((await add({ date: "2026-11-10", start: "08:00", end: "16:00" })).status).toBe(201);
    expect((await add({ date: "2026-11-10", start: "15:00", end: "18:00" })).status).toBe(400); // overlap
    const rest = await add({ date: "2026-11-10", start: "20:00", end: "23:00" });
    expect(rest.status).toBe(400);
    expect((rest.body as any).error).toContain("rest");
    expect((await add({ date: "2026-11-11", start: "09:00", end: "17:00" })).status).toBe(201);
    const over = await add({ date: "2026-11-12", start: "09:00", end: "13:00" }); // 8+8+4 = 20: exactly at the cap
    expect(over.status).toBe(201);
    expect(((await add({ date: "2026-11-13", start: "09:00", end: "10:00" })).body as any).error).toContain("limit");
    expect((await add({ date: "2026-11-30", start: "9:00", end: "10:00" })).status).toBe(400);
    expect((await add({ date: "2026-02-30", start: "09:00", end: "10:00" })).status).toBe(400);
    expect((await add({ date: "2026-11-30", start: "06:00", end: "23:30" })).status).toBe(400); // over 16h
    expect((await s.call("POST", "/api/rota/shifts", { date: "2026-12-01", start: "09:00", end: "10:00", staffId: mo }, bob)).status).toBe(400);
    expect(((await s.call("GET", "/api/rota/week", undefined, bob, "date=2026-11-10")).body as any).shifts).toHaveLength(0);
  });

  it("handles night shifts across midnight and frees a leaver's future shifts", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const mo = ((await s.call("POST", "/api/rota/staff", { name: "Mo" }, ann)).body as any).added.id;
    const night = (await s.call("POST", "/api/rota/shifts", { date: "2026-11-10", start: "22:00", end: "06:00", staffId: mo }, ann)).body as any;
    expect(night.shift).toBeTruthy();
    expect(night.hoursByPerson[0].hours).toBe(8);
    const next = await s.call("POST", "/api/rota/shifts", { date: "2026-11-11", start: "08:00", end: "12:00", staffId: mo }, ann);
    expect(next.status).toBe(400); // only 2h rest after the night shift
    const left = (await s.call("POST", `/api/rota/staff/${mo}/leave`, undefined, ann)).body as any;
    expect(left.openShifts).toBe(1);
    expect(left.staff).toHaveLength(0);
  });

  it("tells the rota coordinator and HR manager what is really on the rota", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const ctx = (key: string) => s.platform.rota.contextFor(s.platform.identity.allWorkspaces()[0]!.id, key, "2026-11-10");
    expect(ctx("hr-manager")).toContain("nobody is on the rota");
    expect(ctx("finance-manager")).toBeUndefined();
    const mo = ((await s.call("POST", "/api/rota/staff", { name: "Mo", hourlyRateMinor: 1000 }, ann)).body as any).added.id;
    await s.call("POST", "/api/rota/shifts", { date: "2026-11-10", start: "08:00", end: "16:00", staffId: mo }, ann);
    const text = ctx("rota-coordinator")!;
    expect(text).toContain("2026-11-10 08:00-16:00 Mo");
    expect(text).toContain("Mo: 8h of 48h cap");
    expect(text).toContain("labour cost 80.00");
  });
});
