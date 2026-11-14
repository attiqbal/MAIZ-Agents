import { describe, expect, it } from "vitest";
import { addDays, describe as words, findAlerts, growthOf, headline, searchWeek, trafficWeek, watch } from "../src/modules/integrations/insights.js";
import type { SearchDay, TrafficDay } from "../src/modules/integrations/types.js";

const END = "2026-11-12";
/** A day of visits `back` days before END. */
const day = (back: number, sessions: number, extra: Partial<TrafficDay> = {}): TrafficDay => ({
  date: addDays(END, -back), currency: "GBP", sessions, users: Math.round(sessions * 0.8), newUsers: Math.round(sessions * 0.5), engagedSessions: Math.round(sessions * 0.6),
  conversions: Math.round(sessions / 20), revenue: 0, channels: [{ name: "Organic Search", sessions: Math.round(sessions * 0.6), conversions: 1 }, { name: "Direct", sessions: Math.round(sessions * 0.4), conversions: 0 }], ...extra,
});
/** `n` days ending at END, oldest first, each from `value(i)` where i counts back from END. */
const run = (n: number, value: (back: number) => number): TrafficDay[] => Array.from({ length: n }, (_, i) => n - 1 - i).map((back) => day(back, value(back)));
const sday = (back: number, clicks: number, impressions = clicks * 20): SearchDay => ({ date: addDays(END, -back), clicks, impressions, position: 8.4 });

describe("weekly picture", () => {
  it("compares the latest seven days with the seven before", () => {
    const t = trafficWeek(run(14, (b) => (b < 7 ? 120 : 100)))!;
    expect(t.from).toBe("2026-11-06");
    expect(t.to).toBe(END);
    expect(t.sessions).toMatchObject({ now: 840, prev: 700 });
    expect(t.sessions.pct).toBeCloseTo(0.2);
    expect(t.channels[0]).toMatchObject({ name: "Organic Search" });
  });

  it("says so when there is not a week and a week to compare", () => {
    expect(trafficWeek(run(9, () => 100))).toBeUndefined();
    expect(words(growthOf(run(9, () => 100), []))[0]).toMatch(/Not enough days/);
  });

  it("scales a week with a missing day so it stays comparable", () => {
    const rows = run(14, () => 100).filter((d) => d.date !== addDays(END, -2));
    const t = trafficWeek(rows)!;
    expect(t.days).toBe(6);
    expect(t.sessions.now).toBe(700);
  });

  it("has no percentage when there was nothing the week before", () => {
    const rows = run(14, (b) => (b < 7 ? 50 : 0));
    expect(trafficWeek(rows)!.sessions.pct).toBeUndefined();
    expect(words(growthOf(rows, []))[0]).toMatch(/nothing to compare yet/);
  });

  it("weights Google position by how often the site appeared, and carries the top searches", () => {
    const rows = Array.from({ length: 14 }, (_, i) => sday(13 - i, 10 + i));
    rows[13]!.topQueries = [{ query: "mock test room", clicks: 40, impressions: 500, position: 3.2 }];
    const s = searchWeek(rows)!;
    expect(s.position.now).toBe(8.4);
    expect(s.topQueries[0]!.query).toBe("mock test room");
    expect(words({ search: s, alerts: [] }).join(" ")).toContain('"mock test room" 40 clicks, position 3.2');
  });

  it("shows revenue only when there is some", () => {
    expect(words(growthOf(run(14, () => 100), [])).join(" ")).not.toMatch(/revenue/);
    const paid = run(14, () => 100).map((d) => ({ ...d, revenue: 5000 }));
    expect(words(growthOf(paid, [])).join(" ")).toContain("£350 revenue");
  });
});

describe("alerts", () => {
  const steady = (b: number) => (b % 2 ? 100 : 108);

  it("raises nothing for an ordinary week", () => {
    expect(findAlerts(run(40, steady), [])).toEqual([]);
  });

  it("raises a fall that is big and well outside the usual ups and downs", () => {
    const a = findAlerts(run(40, (b) => (b < 3 ? 50 : steady(b))), []);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ severity: "bad", key: `visits-down:${END}` });
    expect(a[0]!.title).toMatch(/fell 5\d%/);
  });

  it("is quiet about a dip that is inside the normal noise", () => {
    const noisy = (b: number) => [60, 140, 80, 120, 70, 130, 90][b % 7]!;
    expect(findAlerts(run(40, (b) => (b < 3 ? 70 : noisy(b))), [])).toEqual([]);
  });

  it("raises a big rise as good news", () => {
    const a = findAlerts(run(40, (b) => (b < 3 ? 240 : steady(b))), []);
    expect(a[0]).toMatchObject({ severity: "good", key: `visits-up:${END}` });
  });

  it("does not judge a tiny site, where a few visits swing the average", () => {
    expect(findAlerts(run(40, (b) => (b < 3 ? 0 : b % 2 ? 4 : 6)), [])).toEqual([]);
  });

  it("does not judge a site with under two weeks of history", () => {
    expect(findAlerts(run(10, (b) => (b < 3 ? 10 : 100)), [])).toEqual([]);
  });

  it("flags broken tracking when two days in a row record nothing", () => {
    const a = findAlerts(run(40, (b) => (b < 2 ? 0 : steady(b))), []);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ key: `visits-zero:${END}`, severity: "bad" });
    expect(a[0]!.detail).toMatch(/tag may have stopped/);
  });

  it("watches Google clicks and appearances too", () => {
    const rows = Array.from({ length: 40 }, (_, i) => sday(39 - i, 39 - i < 3 ? 5 : 30 + (i % 2) * 4));
    const a = findAlerts([], rows);
    expect(a.map((x) => x.key)).toContain(`clicks-down:${END}`);
  });

  it("gives each alert a key that changes with the latest date, so one is sent once per day of data", () => {
    const a = findAlerts(run(40, (b) => (b < 3 ? 50 : steady(b))), []);
    const later = findAlerts(run(41, (b) => (b < 4 ? 50 : steady(b))).map((d) => ({ ...d, date: addDays(d.date, 1) })), []);
    expect(a[0]!.key).not.toBe(later[0]!.key);
  });

  it("works on any series through watch()", () => {
    const series = Array.from({ length: 40 }, (_, i) => ({ date: addDays(END, -(39 - i)), value: 39 - i < 3 ? 10 : 100 }));
    expect(watch(series, { name: "x", label: "Things", unit: "things", minLevel: 5 })[0]!.title).toBe("Things fell 90%");
  });
});

describe("words", () => {
  it("writes a short headline for the bell, counting what needs a look", () => {
    const g = growthOf(run(40, (b) => (b < 3 ? 50 : b % 2 ? 100 : 108)), []);
    expect(headline(g)).toMatch(/visits/);
    expect(headline(g)).toMatch(/1 thing needs a look/);
    expect(headline({ alerts: [] })).toMatch(/Not enough history/);
  });
});
