import { describe, expect, it } from "vitest";
import { createApp, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";

function setup() {
  const clock = { d: new Date("2026-11-10T09:00:00Z") };
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), appUrl: "https://app.test", now: () => clock.d });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const signUp = async (email: string, name: string) => {
    const r = await call("POST", "/api/signup", { email, businessName: name, sells: "Coffee", size: "2–10", country: "GB" });
    return { authorization: `Bearer ${(r.body as any).token}` };
  };
  return { platform, call, signUp, clock };
}

describe("dashboard from real records", () => {
  it("needs a sign-in and starts empty for a new client", async () => {
    const s = setup();
    expect((await s.call("GET", "/api/dashboard")).status).toBe(401);
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const d = (await s.call("GET", "/api/dashboard", undefined, ann)).body as any;
    expect(d.team.length).toBeGreaterThanOrEqual(4);
    expect(d.team[0]).toMatchObject({ usedToday: 0, doneWeek: 0, status: "idle", doing: null });
    expect(d.team[0].week).toHaveLength(7);
    expect(d.tasks).toEqual([]);
    expect(d.totals).toMatchObject({ queued: 0, doneWeek: 0, waitingOnYou: 0 });
  });

  it("shows queued work as planned, finished work as done, and a client's open questions as waiting", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const team = ((await s.call("GET", "/api/org", undefined, ann)).body as any).team;
    const fin = team.find((e: any) => e.templateKey === "finance-manager");
    await s.call("POST", "/api/ask", { text: "Urgent: what is our cash?", employeeId: fin.id, urgent: true }, ann);
    await s.call("POST", "/api/ask", { text: "Prepare the October report for the whole company, please", employeeId: fin.id }, ann);
    await s.call("POST", "/api/reviews", { title: "Brand kit", employee: "Brand and content creator", days: 5, design: "One kit.", brief: [{ label: "Who you sell to" }], directions: [{ key: "a", name: "A", summary: "x" }], plan: [{ title: "t", energy: 100 }] }, ann);
    const d = (await s.call("GET", "/api/dashboard", undefined, ann)).body as any;
    const cols = (c: string) => d.tasks.filter((t: any) => t.column === c);
    expect(cols("planned")).toHaveLength(1);
    expect(cols("planned")[0]).toMatchObject({ employeeName: "Finance manager" });
    expect(cols("done")).toHaveLength(1);
    expect(cols("waiting")).toMatchObject([{ title: "Brand kit" }]);
    expect(d.team.find((e: any) => e.id === fin.id)).toMatchObject({ status: "working", doneWeek: 1 });
    expect(d.totals).toMatchObject({ queued: 1, doneWeek: 1, waitingOnYou: 1 });
  });

  it("never mixes in another client's work", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const bob = await s.signUp("bob@northside.co", "Northside Bikes");
    const team = ((await s.call("GET", "/api/org", undefined, ann)).body as any).team;
    await s.call("POST", "/api/ask", { text: "Urgent: cash?", employeeId: team[0].id, urgent: true }, ann);
    const d = (await s.call("GET", "/api/dashboard", undefined, bob)).body as any;
    expect(d.tasks).toEqual([]);
    expect(d.totals.doneWeek).toBe(0);
  });

  it("counts a week's energy per day, oldest first", async () => {
    const s = setup();
    const ann = await s.signUp("ann@kestrel.co", "Kestrel Coffee");
    const ws = s.platform.identity.allWorkspaces()[0]!.id;
    const team = ((await s.call("GET", "/api/org", undefined, ann)).body as any).team;
    s.platform.energy.record(ws, team[0].id, "anthropic", 1000, 1000, false);
    s.clock.d = new Date("2026-11-11T09:00:00Z");
    s.platform.energy.record(ws, team[0].id, "anthropic", 1000, 1000, false);
    const row = ((await s.call("GET", "/api/dashboard", undefined, ann)).body as any).team.find((e: any) => e.id === team[0].id);
    expect(row.week.slice(-2)).toEqual([6, 6]);
    expect(row.usedToday).toBe(6);
  });
});
