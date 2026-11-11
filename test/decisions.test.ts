import { describe, expect, it } from "vitest";
import { DecisionDigest, openDecisions } from "../src/server/decisions.js";

function digest(open: { n: number }) {
  const clock = { t: 1_000_000 };
  const sent: number[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  const d = new DecisionDigest({
    now: () => clock.t,
    count: () => open.n,
    send: async (n) => { sent.push(n); },
    gapMs: 30 * 60_000,
    later: (fn, ms) => { timers.push({ at: clock.t + ms, fn }); },
  });
  const advance = (ms: number) => {
    clock.t += ms;
    for (const t of timers.splice(0).filter((x) => x.at <= clock.t || (timers.push(x), false))) t.fn();
  };
  return { d, sent, advance, timers };
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
