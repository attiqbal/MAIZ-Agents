import { describe, expect, it } from "vitest";
import { DecisionDigest, REMINDER_GAP_MS, inQuietHours, openDecisions } from "../src/server/decisions.js";
import { brandFrom, signOffReminderEmail } from "../src/server/email-templates.js";

function digest(open: { n: number }, quiet: { on: boolean } = { on: false }) {
  const clock = { t: 1_000_000 };
  const sent: number[] = [];
  const reminders: number[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  const d = new DecisionDigest({
    now: () => clock.t,
    count: () => open.n,
    send: async (n) => { sent.push(n); },
    remind: async (n) => { reminders.push(n); },
    quiet: () => quiet.on,
    gapMs: 30 * 60_000,
    later: (fn, ms) => { timers.push({ at: clock.t + ms, fn }); },
  });
  const advance = (ms: number) => {
    clock.t += ms;
    for (const t of timers.splice(0).filter((x) => x.at <= clock.t || (timers.push(x), false))) t.fn();
  };
  return { d, sent, reminders, advance, timers, clock };
}

describe("decision email", () => {
  it("sends one email for a burst, then one more when the gap ends if something is still open", async () => {
    const open = { n: 1 };
    const { d, sent, advance } = digest(open);
    d.poke(); // first one goes at once
    open.n = 600;
    for (let i = 0; i < 599; i++) d.poke();
    await Promise.resolve();
    expect(sent).toEqual([1]);
    advance(30 * 60_000);
    await Promise.resolve();
    expect(sent).toEqual([1, 600]);
  });

  it("sends nothing when everything was decided before the gap ended", async () => {
    const open = { n: 2 };
    const { d, sent, advance } = digest(open);
    d.poke();
    d.poke();
    open.n = 0;
    advance(30 * 60_000);
    await Promise.resolve();
    expect(sent).toEqual([2]);
  });

  it("lists only open requests, oldest first", () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    const items = openDecisions({
      reviews: [
        { id: "r1", status: "in_review", clientName: "A", ageHours: 2, proposal: { title: "Brand kit" } },
        { id: "r2", status: "approved", clientName: "B", ageHours: 90, proposal: { title: "Done" } },
        { id: "r3", status: "gathering_info", clientName: "C", ageHours: 40, proposal: { title: "Waiting on client" } },
      ],
      specialists: [{ id: "s1", status: "in_review", clientName: "D", submittedAt: "2026-11-10T12:00:00Z", role: { title: "Coordinator" } }],
    }, now);
    expect(items.map((i) => i.id)).toEqual(["s1", "r1"]);
    expect(items[0]).toMatchObject({ kind: "specialist", ageHours: 24, link: "/owner-specialists.html#s1" });
  });
});

describe("hourly sign-off reminder", () => {
  it("reminds once an hour while something is still waiting, and stops when it is all decided", async () => {
    const open = { n: 3 };
    const { d, sent, reminders, clock } = digest(open);
    d.poke();
    await Promise.resolve();
    // The minute tick: nothing inside the hour.
    clock.t += 59 * 60_000; await d.tick();
    expect(reminders).toEqual([]);
    clock.t += 60_000; await d.tick();
    clock.t += 60_000; await d.tick();
    expect(reminders).toEqual([3]);
    clock.t += REMINDER_GAP_MS; open.n = 1; await d.tick();
    expect(reminders).toEqual([3, 1]);
    clock.t += REMINDER_GAP_MS; open.n = 0; await d.tick();
    expect(reminders).toEqual([3, 1]);
    expect(sent).toEqual([3]);
  });

  it("starts the hour from the first tick that sees something waiting, so a restart does not send at once", async () => {
    const open = { n: 2 };
    const { d, reminders, clock } = digest(open);
    await d.tick();
    expect(reminders).toEqual([]);
    clock.t += REMINDER_GAP_MS; await d.tick();
    expect(reminders).toEqual([2]);
  });

  it("holds reminders during the owner's night and sends one when the day starts", async () => {
    const open = { n: 2 };
    const quiet = { on: true };
    const { d, reminders, clock } = digest(open, quiet);
    await d.tick();
    clock.t += 3 * REMINDER_GAP_MS; await d.tick();
    expect(reminders).toEqual([]);
    quiet.on = false; await d.tick();
    expect(reminders).toEqual([2]);
  });

  it("counts 22:00 to 07:00 in the owner's own time zone as night", () => {
    expect(inQuietHours(new Date("2026-11-16T23:30:00Z"), "Europe/London")).toBe(true);
    expect(inQuietHours(new Date("2026-11-16T06:59:00Z"), "Europe/London")).toBe(true);
    expect(inQuietHours(new Date("2026-11-16T07:00:00Z"), "Europe/London")).toBe(false);
    expect(inQuietHours(new Date("2026-11-16T21:59:00Z"), "Europe/London")).toBe(false);
    // 23:30 UTC is 18:30 in New York.
    expect(inQuietHours(new Date("2026-11-16T23:30:00Z"), "America/New_York")).toBe(false);
    // An unknown zone falls back to UTC instead of failing.
    expect(inQuietHours(new Date("2026-11-16T23:30:00Z"), "Not/AZone")).toBe(true);
  });

  it("writes an email that lists the oldest sign-offs with the client and how long each has waited", () => {
    const mail = signOffReminderEmail([
      { kind: "review", id: "r1", title: "Brand <kit>", clientName: "Kestrel Coffee", ageHours: 26, link: "/review.html#r1" },
      { kind: "specialist", id: "s1", title: "Coordinator", clientName: "Fern & Co", ageHours: 0, link: "/owner-specialists.html#s1" },
    ], 2, "https://maiz.test", brandFrom({ appUrl: "https://maiz.test" }));
    expect(mail.subject).toBe("Still waiting for your sign-off: 2 decisions");
    expect(mail.text).toContain("Brand <kit> (Kestrel Coffee), waiting 1 day");
    expect(mail.text).toContain("Coordinator (Fern & Co), waiting under an hour");
    expect(mail.html).toContain("Brand &lt;kit&gt;");
    expect(mail.html).not.toContain("Brand <kit>");
    expect(mail.html).toContain("https://maiz.test/owner-decisions.html");
  });
});
