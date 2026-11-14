import type { SearchDay, TrafficDay } from "./types.js";

/**
 * Turns a client's website visits and Google search figures into a weekly picture and plain-English alerts.
 * Pure arithmetic on the numbers the analytics apps reported: no model is asked, so every figure is the app's own
 * and a report costs no energy. The Marketing manager reads the same text to explain and advise.
 */

export interface Delta { now: number; prev: number; /** Change since the week before; undefined when there was nothing before. */ pct?: number }
export interface Alert {
  /** Stable per metric, direction and latest date, so the same alert is only sent once. */
  key: string;
  severity: "bad" | "good";
  title: string;
  detail: string;
}
export interface ChannelRow { name: string; sessions: number; pct?: number; conversions: number }
export interface TrafficWeek {
  from: string; to: string; days: number; currency: string;
  sessions: Delta; users: Delta; conversions: Delta; revenue: Delta;
  channels: ChannelRow[];
}
export interface SearchWeek {
  from: string; to: string; days: number;
  clicks: Delta; impressions: Delta; position: { now?: number; prev?: number };
  topQueries: NonNullable<SearchDay["topQueries"]>;
}
export interface Growth { traffic?: TrafficWeek; search?: SearchWeek; alerts: Alert[] }

const DAY_MS = 86_400_000;
/** A week needs this many of its seven days present before it is compared with the week before. */
const MIN_DAYS = 5;
/** History needed before an alert is worth raising. */
const MIN_BASELINE_DAYS = 14;

export const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** ISO 8601 week of a calendar date, as YYYY-Www (weeks start on Monday). */
export function isoWeek(date: string): string {
  const d = new Date(Date.parse(`${date}T00:00:00Z`));
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const n = 1 + Math.round(((d.getTime() - week1.getTime()) / DAY_MS - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(n).padStart(2, "0")}`;
}
const latest = (rows: { date: string }[]): string | undefined => rows.reduce<string | undefined>((m, r) => (!m || r.date > m ? r.date : m), undefined);
const between = <T extends { date: string }>(rows: T[], from: string, to: string): T[] => rows.filter((r) => r.date >= from && r.date <= to);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const pctChange = (now: number, prev: number): number | undefined => (prev > 0 ? (now - prev) / prev : undefined);
const delta = (now: number, prev: number): Delta => ({ now, prev, pct: pctChange(now, prev) });

/** The latest seven days in a series and the seven before, or undefined when either has too few days. */
function weeks<T extends { date: string }>(rows: T[]): { end: string; cur: T[]; prev: T[] } | undefined {
  const end = latest(rows);
  if (!end) return undefined;
  const cur = between(rows, addDays(end, -6), end);
  const prev = between(rows, addDays(end, -13), addDays(end, -7));
  return cur.length >= MIN_DAYS && prev.length >= MIN_DAYS ? { end, cur, prev } : undefined;
}

/** Totals for a week, scaled to seven days when a day or two is missing so the two weeks stay comparable. */
const scaled = (rows: unknown[], total: number): number => (rows.length >= 7 ? total : Math.round((total / rows.length) * 7));

function channelRows(cur: TrafficDay[], prev: TrafficDay[]): ChannelRow[] {
  const tally = (days: TrafficDay[]) => {
    const m = new Map<string, { sessions: number; conversions: number }>();
    for (const d of days) for (const c of d.channels) { const x = m.get(c.name) ?? { sessions: 0, conversions: 0 }; x.sessions += c.sessions; x.conversions += c.conversions; m.set(c.name, x); }
    return m;
  };
  const now = tally(cur), before = tally(prev);
  return [...now].sort((a, b) => b[1].sessions - a[1].sessions).slice(0, 5).map(([name, v]) => ({ name, sessions: scaled(cur, v.sessions), conversions: scaled(cur, v.conversions), pct: pctChange(scaled(cur, v.sessions), scaled(prev, before.get(name)?.sessions ?? 0)) }));
}

export function trafficWeek(traffic: TrafficDay[]): TrafficWeek | undefined {
  const w = weeks(traffic);
  if (!w) return undefined;
  const f = (rows: TrafficDay[], pick: (d: TrafficDay) => number) => scaled(rows, sum(rows.map(pick)));
  const d = (pick: (x: TrafficDay) => number) => delta(f(w.cur, pick), f(w.prev, pick));
  return { from: addDays(w.end, -6), to: w.end, days: w.cur.length, currency: w.cur[w.cur.length - 1]!.currency, sessions: d((x) => x.sessions), users: d((x) => x.users), conversions: d((x) => x.conversions), revenue: d((x) => x.revenue), channels: channelRows(w.cur, w.prev) };
}

export function searchWeek(search: SearchDay[]): SearchWeek | undefined {
  const w = weeks(search);
  if (!w) return undefined;
  const f = (rows: SearchDay[], pick: (d: SearchDay) => number) => scaled(rows, sum(rows.map(pick)));
  const d = (pick: (x: SearchDay) => number) => delta(f(w.cur, pick), f(w.prev, pick));
  const position = (rows: SearchDay[]) => { const imp = sum(rows.map((r) => r.impressions)); return imp > 0 ? Math.round((sum(rows.map((r) => r.position * r.impressions)) / imp) * 10) / 10 : undefined; };
  const top = [...search].sort((a, b) => b.date.localeCompare(a.date)).find((r) => r.topQueries?.length)?.topQueries ?? [];
  return { from: addDays(w.end, -6), to: w.end, days: w.cur.length, clicks: d((x) => x.clicks), impressions: d((x) => x.impressions), position: { now: position(w.cur), prev: position(w.prev) }, topQueries: top.slice(0, 8) };
}

// ------------------------------------------------------------ alerts

export interface WatchOptions {
  /** Short name used in the alert key. */
  name: string;
  /** What the owner calls it, for example "Visits". */
  label: string;
  /** Below this daily average the numbers are too small to judge, so nothing is raised. */
  minLevel: number;
  /** The sort of day being counted, for the alert text ("visits"). */
  unit: string;
  /** Raise "no data at all" when the last two days are zero (visits only). */
  zeroMeansBroken?: boolean;
}
const WINDOW = 3;
const BASELINE = 28;
const MIN_DROP = 0.4;
const MIN_RISE = 0.6;
/** How many standard errors away the recent days must be: ordinary ups and downs are not alerts. */
const MIN_Z = 3;

const whole = (n: number): string => Math.round(n).toLocaleString("en-GB");
const mean = (xs: number[]): number => (xs.length ? sum(xs) / xs.length : 0);
const sd = (xs: number[]): number => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1)); };

/**
 * Compares the last three days with the 28 days before them. An alert needs a large change (a fall of 40% or a
 * rise of 60%) that is also well outside the metric's normal day-to-day noise. Quiet sites, where a handful of
 * visits decides the average, are never alerted: the numbers are too small to mean anything.
 */
export function watch(series: { date: string; value: number }[], o: WatchOptions): Alert[] {
  const end = latest(series);
  if (!end) return [];
  const at = new Map(series.map((r) => [r.date, r.value]));
  const win = [0, 1, 2].map((i) => at.get(addDays(end, -i))).filter((v): v is number => v !== undefined);
  const base = between(series, addDays(end, -(BASELINE + WINDOW - 1)), addDays(end, -WINDOW)).map((r) => r.value);
  if (win.length < WINDOW - 1 || base.length < MIN_BASELINE_DAYS) return [];
  const baseMean = mean(base);
  if (baseMean < o.minLevel) return [];
  const out: Alert[] = [];
  const latestTwo = [at.get(end), at.get(addDays(end, -1))];
  if (o.zeroMeansBroken && latestTwo.every((v) => v === 0)) {
    return [{ key: `${o.name}-zero:${end}`, severity: "bad", title: `No ${o.unit} recorded for two days`, detail: `Usually about ${whole(baseMean)} a day. The analytics tag may have stopped working, or the website may be down. Worth checking today.` }];
  }
  const winMean = mean(win);
  const pct = (winMean - baseMean) / baseMean;
  // Counts vary at least as much as chance alone says (about the square root of the average), so never trust a tiny spread.
  const se = Math.max(sd(base), Math.sqrt(baseMean)) / Math.sqrt(win.length);
  const z = (winMean - baseMean) / se;
  const detail = `About ${whole(winMean)} a day over the last ${win.length} days, against about ${whole(baseMean)} a day in the ${base.length} days before. Latest data: ${end}.`;
  if (pct <= -MIN_DROP && z <= -MIN_Z) out.push({ key: `${o.name}-down:${end}`, severity: "bad", title: `${o.label} fell ${Math.round(-pct * 100)}%`, detail });
  else if (pct >= MIN_RISE && z >= MIN_Z) out.push({ key: `${o.name}-up:${end}`, severity: "good", title: `${o.label} rose ${Math.round(pct * 100)}%`, detail });
  return out;
}

export function findAlerts(traffic: TrafficDay[], search: SearchDay[]): Alert[] {
  const t = (pick: (d: TrafficDay) => number) => traffic.map((d) => ({ date: d.date, value: pick(d) }));
  const s = (pick: (d: SearchDay) => number) => search.map((d) => ({ date: d.date, value: pick(d) }));
  return [
    ...watch(t((d) => d.sessions), { name: "visits", label: "Website visits", unit: "visits", minLevel: 15, zeroMeansBroken: true }),
    ...watch(t((d) => d.conversions), { name: "conversions", label: "Goals completed on the website", unit: "goals", minLevel: 1.5 }),
    ...watch(s((d) => d.clicks), { name: "clicks", label: "Clicks from Google search", unit: "clicks", minLevel: 8 }),
    ...watch(s((d) => d.impressions), { name: "impressions", label: "Times the site appeared in Google search", unit: "appearances", minLevel: 80 }),
  ];
}

export function growthOf(traffic: TrafficDay[], search: SearchDay[]): Growth {
  return { traffic: trafficWeek(traffic), search: searchWeek(search), alerts: findAlerts(traffic, search) };
}

// ------------------------------------------------------------ words

const signed = (p: number | undefined): string => (p === undefined ? "nothing to compare yet" : `${p >= 0 ? "+" : "−"}${Math.round(Math.abs(p) * 100)}% on the week before`);
const money = (minor: number, cur: string): string => { try { return new Intl.NumberFormat("en-GB", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(minor / 100); } catch { return `${Math.round(minor / 100)} ${cur}`; } };

/** The full picture as plain lines, for the owner's page and for the Marketing manager's instructions. */
export function describe(g: Growth): string[] {
  const lines: string[] = [];
  const t = g.traffic;
  if (t) {
    lines.push(`Website, ${t.from} to ${t.to}${t.days < 7 ? ` (${t.days} days of data, scaled to a week)` : ""}: ${whole(t.sessions.now)} visits (${signed(t.sessions.pct)}), ${whole(t.users.now)} visitors (${signed(t.users.pct)}), ${whole(t.conversions.now)} goals completed (${signed(t.conversions.pct)})${t.revenue.now > 0 ? `, ${money(t.revenue.now, t.currency)} revenue (${signed(t.revenue.pct)})` : ""}.`);
    if (t.channels.length) lines.push(`Where visits came from: ${t.channels.map((c) => `${c.name} ${whole(c.sessions)}${c.pct === undefined ? "" : ` (${c.pct >= 0 ? "+" : "−"}${Math.round(Math.abs(c.pct) * 100)}%)`}`).join(", ")}.`);
  }
  const s = g.search;
  if (s) {
    const pos = s.position.now === undefined ? "" : `, average position ${s.position.now}${s.position.prev === undefined ? "" : ` (${s.position.prev} the week before)`}`;
    lines.push(`Google search, ${s.from} to ${s.to}: ${whole(s.clicks.now)} clicks (${signed(s.clicks.pct)}) from ${whole(s.impressions.now)} appearances (${signed(s.impressions.pct)})${pos}.`);
    if (s.topQueries.length) lines.push(`Searches that brought the most clicks: ${s.topQueries.map((q) => `"${q.query}" ${whole(q.clicks)} clicks, position ${q.position}`).join("; ")}.`);
  }
  if (!t && !s) lines.push("Not enough days of data yet to compare one week with the one before. A week of history is needed, and two to compare.");
  for (const a of g.alerts) lines.push(`${a.severity === "bad" ? "Needs a look" : "Good news"}: ${a.title}. ${a.detail}`);
  return lines;
}

/** A short line for the bell. */
export function headline(g: Growth): string {
  const bits: string[] = [];
  if (g.traffic) bits.push(`${whole(g.traffic.sessions.now)} visits (${g.traffic.sessions.pct === undefined ? "new" : `${g.traffic.sessions.pct >= 0 ? "+" : "−"}${Math.round(Math.abs(g.traffic.sessions.pct) * 100)}%`})`);
  if (g.search) bits.push(`${whole(g.search.clicks.now)} Google clicks (${g.search.clicks.pct === undefined ? "new" : `${g.search.clicks.pct >= 0 ? "+" : "−"}${Math.round(Math.abs(g.search.clicks.pct) * 100)}%`})`);
  const bad = g.alerts.filter((a) => a.severity === "bad").length;
  const head = bits.length ? `${bits.join(", ")} this week.` : "Not enough history for a comparison yet.";
  return bad ? `${head} ${bad} thing${bad === 1 ? "" : "s"} need${bad === 1 ? "s" : ""} a look.` : head;
}
