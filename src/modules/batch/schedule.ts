/**
 * Per-client batch schedule: when the client's queued work is sent to the pod. Times are the client's own
 * local clock, so "after closing" means after their closing, wherever they are. Times are stored in UTC
 * everywhere else; this is the only place that knows about time zones.
 */
export interface ClientSchedule {
  /** Work is queued for the batch. Off means everything is answered at once, as before. */
  enabled: boolean;
  /** IANA time zone, for example Europe/London. */
  timezone: string;
  /** Local closing time, HH:MM. The main run happens just after it. */
  closingTime: string;
  /** Extra local run times, for example ["12:00"] for a midday run. */
  extraRuns: string[];
  skipWeekends: boolean;
  /** A catch-all run at local midnight, so nothing waits for the next closing time. */
  midnightSweep: boolean;
}

export const DEFAULT_SCHEDULE: ClientSchedule = { enabled: true, timezone: "UTC", closingTime: "18:00", extraRuns: [], skipWeekends: false, midnightSweep: true };

export class BatchError extends Error {}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validateTimezone(tz: unknown): string {
  if (typeof tz !== "string" || tz.length > 64) throw new BatchError("pick a time zone");
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    throw new BatchError(`"${tz}" is not a time zone we know (use a name like Europe/London)`);
  }
  return tz;
}

/** Checks a full or partial schedule on top of the current one. */
export function mergeSchedule(base: ClientSchedule, patch: unknown): ClientSchedule {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new BatchError("send the schedule as an object");
  const p = patch as Record<string, unknown>;
  const next = { ...base, extraRuns: [...base.extraRuns] };
  if (p.enabled !== undefined) { if (typeof p.enabled !== "boolean") throw new BatchError("enabled must be true or false"); next.enabled = p.enabled; }
  if (p.skipWeekends !== undefined) { if (typeof p.skipWeekends !== "boolean") throw new BatchError("skipWeekends must be true or false"); next.skipWeekends = p.skipWeekends; }
  if (p.midnightSweep !== undefined) { if (typeof p.midnightSweep !== "boolean") throw new BatchError("midnightSweep must be true or false"); next.midnightSweep = p.midnightSweep; }
  if (p.timezone !== undefined) next.timezone = validateTimezone(p.timezone);
  if (p.closingTime !== undefined) {
    if (typeof p.closingTime !== "string" || !HHMM.test(p.closingTime)) throw new BatchError("closing time must look like 18:00");
    next.closingTime = p.closingTime;
  }
  if (p.extraRuns !== undefined) {
    if (!Array.isArray(p.extraRuns) || p.extraRuns.length > 3 || p.extraRuns.some((t) => typeof t !== "string" || !HHMM.test(t))) throw new BatchError("extra run times must be up to three times like 12:00");
    next.extraRuns = [...new Set(p.extraRuns as string[])].sort();
  }
  return next;
}

interface Local { y: number; m: number; d: number; hh: number; mm: number }

export function localParts(instant: Date, tz: string): Local {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(instant);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: n("year"), m: n("month"), d: n("day"), hh: n("hour"), mm: n("minute") };
}

/** The UTC instant at which the wall clock in `tz` reads the given local time. */
export function localToInstant(tz: string, y: number, m: number, d: number, hh: number, mm: number): Date {
  const asUtc = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle the offset, including on the days the clocks change.
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const l = localParts(new Date(guess), tz);
    guess += asUtc - Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm);
  }
  return new Date(guess);
}

/** The next time a batch is due for this client, strictly after `from`. */
export function nextRunAt(s: ClientSchedule, from: Date): Date {
  const times = [s.closingTime, ...s.extraRuns, ...(s.midnightSweep === false ? [] : ["00:00"])].map((t) => t.split(":").map(Number) as [number, number]);
  const today = localParts(from, s.timezone);
  let best: Date | undefined;
  for (let add = 0; add <= 8 && !best; add++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + add));
    if (s.skipWeekends && [0, 6].includes(day.getUTCDay())) continue;
    const candidates = times.map(([hh, mm]) => localToInstant(s.timezone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm)).filter((t) => t.getTime() > from.getTime());
    if (candidates.length) best = new Date(Math.min(...candidates.map((c) => c.getTime())));
  }
  return best ?? new Date(from.getTime() + 24 * 3_600_000);
}

/** "6:00 pm" style, in the client's own time zone. */
export function formatLocal(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(instant).replace(/\s?([ap])m/i, " $1m");
}
