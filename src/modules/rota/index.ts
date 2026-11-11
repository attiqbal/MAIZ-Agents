import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";

/**
 * A simple rota: who works when. It exists so the Rota coordinator (and the owner) answer from real shifts instead
 * of guessing. Rules are enforced here, in code: no overlapping shifts, enough rest between shifts, and a weekly hours
 * cap. Hours and cost are sums of the shifts, never a model's arithmetic. Times are the business's local clock, as
 * written on the rota (a shift that ends at or before its start runs past midnight).
 */
export class RotaError extends Error {}

export interface Staff {
  id: string;
  workspaceId: string;
  name: string;
  role?: string;
  /** Pay per hour in minor units (pence), for cost totals. Optional. */
  hourlyRateMinor?: number;
  /** Personal cap per week; otherwise the default applies. */
  maxHoursPerWeek?: number;
  active: boolean;
  /** What the person told the HR desk: when they can work and approved time off. Shifts outside it are refused. */
  limits?: StaffLimits;
}

/** Days are Monday = 0 … Sunday = 6. A day not listed means any time. */
export interface StaffLimits {
  availability: { day: number; off?: boolean; from?: string; to?: string }[];
  maxShiftHours?: number;
  /** The most hours a week they want; lower than the legal cap, it becomes their cap. */
  maxHoursPerWeek?: number;
  away: { from: string; to: string }[];
}
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export interface Shift {
  id: string;
  workspaceId: string;
  /** Local date the shift starts, YYYY-MM-DD. */
  date: string;
  start: string;
  end: string;
  /** The person working it, or undefined for an open shift. */
  staffId?: string;
  role?: string;
  note?: string;
}

export const MIN_REST_HOURS = 11;
export const DEFAULT_MAX_WEEKLY_HOURS = 48;
export const MAX_SHIFT_HOURS = 16;
export const MAX_STAFF = 200;
export const MAX_SHIFTS = 5000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIN_PER_DAY = 1440;

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

function dayNumber(date: string): number {
  if (!DATE_RE.test(date)) throw new RotaError("dates look like 2026-11-16");
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== date) throw new RotaError("that date does not exist");
  return Math.floor(t / 86_400_000);
}
const toMin = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const dateOf = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);
/** The Monday of the week a date falls in. */
export function weekStart(date: string): string {
  const d = dayNumber(date);
  const dow = (d + 3) % 7; // 1970-01-01 was a Thursday; 0 = Monday
  return dateOf(d - dow);
}

/** Absolute start and end of a shift in minutes since 1970-01-01 local. */
function span(s: Pick<Shift, "date" | "start" | "end">): { from: number; to: number } {
  const from = dayNumber(s.date) * MIN_PER_DAY + toMin(s.start);
  let to = dayNumber(s.date) * MIN_PER_DAY + toMin(s.end);
  if (to <= from) to += MIN_PER_DAY;
  return { from, to };
}
/** Their own weekly cap: the lower of what they asked for and the legal default (or a cap set on the rota). */
const capOf = (p: Staff): number => Math.min(p.maxHoursPerWeek ?? DEFAULT_MAX_WEEKLY_HOURS, p.limits?.maxHoursPerWeek || Infinity);
const hoursOf = (s: Shift): number => { const x = span(s); return (x.to - x.from) / 60; };

export class RotaService {
  private staff = new Map<string, Staff>();
  private shifts = new Map<string, Shift>();
  private sink?: Sink;

  constructor(private identity: IdentityService, private audit: AuditLog) {}

  useSink(sink: Sink): void { this.sink = sink; }
  restoreStaff(s: Staff): void { this.staff.set(s.id, s); }
  restoreShift(s: Shift): void { this.shifts.set(s.id, s); }

  // ---------- staff ----------

  addStaff(userId: string, workspaceId: string, input: unknown): Staff {
    this.identity.require(userId, workspaceId, "task.create");
    const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const name = clean(b.name, 80);
    if (!name) throw new RotaError("give the person a name");
    if ([...this.staff.values()].filter((s) => s.workspaceId === workspaceId).length >= MAX_STAFF) throw new RotaError(`a rota holds up to ${MAX_STAFF} people`);
    if (this.mine(workspaceId, this.staff).some((s) => s.active && s.name.toLowerCase() === name.toLowerCase())) throw new RotaError("someone with that name is already on the rota");
    const staff: Staff = { id: newId("staff"), workspaceId, name, active: true };
    const role = clean(b.role, 60);
    if (role) staff.role = role;
    if (b.hourlyRateMinor !== undefined) staff.hourlyRateMinor = wholeNumber(b.hourlyRateMinor, "hourly pay", 0, 100_000);
    if (b.maxHoursPerWeek !== undefined) staff.maxHoursPerWeek = wholeNumber(b.maxHoursPerWeek, "weekly hours", 1, 80);
    this.saveStaff(staff);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "rota.staff_added", target: `staff:${staff.id}` });
    return staff;
  }

  /** Marks someone as left. Their past shifts stay; future ones become open shifts so nobody turns up to nothing. */
  deactivate(userId: string, workspaceId: string, staffId: string, today: string): Staff {
    this.identity.require(userId, workspaceId, "task.create");
    const s = this.staffOf(workspaceId, staffId);
    this.saveStaff({ ...s, active: false });
    for (const sh of this.mine(workspaceId, this.shifts)) if (sh.staffId === staffId && sh.date >= today) this.saveShift({ ...sh, staffId: undefined });
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "rota.staff_left", target: `staff:${staffId}` });
    return { ...s, active: false };
  }

  /**
   * Called by the HR desk (which has already checked permission) when someone's availability, hours wanted
   * or approved time off changes. Not audited here: the HR desk audits the change that caused it.
   */
  setLimits(workspaceId: string, staffId: string, limits: StaffLimits): void {
    const s = this.staffOf(workspaceId, staffId);
    if (JSON.stringify(s.limits ?? null) === JSON.stringify(limits)) return;
    this.saveStaff({ ...s, limits });
  }

  // ---------- shifts ----------

  addShift(userId: string, workspaceId: string, input: unknown): Shift {
    this.identity.require(userId, workspaceId, "task.create");
    const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const date = String(b.date ?? "");
    const start = String(b.start ?? "");
    const end = String(b.end ?? "");
    dayNumber(date);
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw new RotaError("times look like 09:00");
    if (start === end) throw new RotaError("a shift needs a start and a different end");
    if (hoursOf({ date, start, end } as Shift) > MAX_SHIFT_HOURS) throw new RotaError(`a shift cannot be longer than ${MAX_SHIFT_HOURS} hours`);
    if (this.mine(workspaceId, this.shifts).length >= MAX_SHIFTS) throw new RotaError("the rota is full; remove old shifts first");
    const shift: Shift = { id: newId("shift"), workspaceId, date, start, end };
    const role = clean(b.role, 60);
    const note = clean(b.note, 200);
    if (role) shift.role = role;
    if (note) shift.note = note;
    const staffId = typeof b.staffId === "string" && b.staffId ? b.staffId : undefined;
    if (staffId) this.checkAssign(workspaceId, shift, staffId);
    this.saveShift(staffId ? { ...shift, staffId } : shift);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "rota.shift_added", target: `shift:${shift.id}`, data: { date, start, end, ...(staffId ? { staffId } : {}) } });
    return this.shifts.get(shift.id)!;
  }

  /** Gives a shift to someone (or back to nobody). Refused when it breaks a rule. */
  assign(userId: string, workspaceId: string, shiftId: string, staffId: string | null): Shift {
    this.identity.require(userId, workspaceId, "task.create");
    const shift = this.shiftOf(workspaceId, shiftId);
    if (staffId) this.checkAssign(workspaceId, shift, staffId);
    this.saveShift({ ...shift, staffId: staffId ?? undefined });
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "rota.shift_assigned", target: `shift:${shiftId}`, data: { staffId } });
    return this.shifts.get(shiftId)!;
  }

  removeShift(userId: string, workspaceId: string, shiftId: string): void {
    this.identity.require(userId, workspaceId, "task.create");
    const s = this.shiftOf(workspaceId, shiftId);
    this.shifts.delete(shiftId);
    this.sink?.record(workspaceId, "rota_shift", shiftId, { removed: true });
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "rota.shift_removed", target: `shift:${s.id}` });
  }

  // ---------- reading ----------

  /** One week, Monday to Sunday, with each person's hours and the cost of the week. */
  week(userId: string, workspaceId: string, anyDateInWeek: string) {
    this.identity.require(userId, workspaceId, "task.read");
    return this.weekOf(workspaceId, anyDateInWeek);
  }

  /** The week for code that already checked permission (the HR desk shows a person's own shifts). */
  weekFor(workspaceId: string, anyDateInWeek: string) {
    return this.weekOf(workspaceId, anyDateInWeek);
  }

  private weekOf(workspaceId: string, anyDateInWeek: string) {
    const from = weekStart(anyDateInWeek);
    const to = dateOf(dayNumber(from) + 6);
    const shifts = this.mine(workspaceId, this.shifts).filter((s) => s.date >= from && s.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
    const people = this.mine(workspaceId, this.staff).filter((s) => s.active);
    const byPerson = people.map((p) => {
      const hours = shifts.filter((s) => s.staffId === p.id).reduce((n, s) => n + hoursOf(s), 0);
      return { staffId: p.id, name: p.name, hours: round2(hours), cap: capOf(p), costMinor: p.hourlyRateMinor !== undefined ? Math.round(hours * p.hourlyRateMinor) : null };
    });
    const known = byPerson.every((p) => p.costMinor !== null || p.hours === 0);
    return {
      weekStart: from, weekEnd: to, staff: people, shifts: shifts.map((s) => ({ ...s, hours: round2(hoursOf(s)) })),
      openShifts: shifts.filter((s) => !s.staffId).length, hoursByPerson: byPerson,
      totalHours: round2(byPerson.reduce((n, p) => n + p.hours, 0)),
      /** Null when someone with hours has no pay rate on file, so the total would be a guess. */
      totalCostMinor: known ? byPerson.reduce((n, p) => n + (p.costMinor ?? 0), 0) : null,
    };
  }

  /** What the Rota coordinator and HR manager are told: this week and next, from the real shifts. */
  contextFor(workspaceId: string, templateKey: string, today: string): string | undefined {
    if (templateKey !== "rota-coordinator" && templateKey !== "hr-manager") return undefined;
    const people = this.mine(workspaceId, this.staff).filter((s) => s.active);
    if (!people.length) return "Rota records (current): nobody is on the rota yet. If asked about shifts or hours, say there is no rota data and ask the owner to add staff and shifts.";
    const lines: string[] = [`Rota records (current, entered by the owner; times are local). Rules enforced in code: no overlaps, ${MIN_REST_HOURS}h rest between shifts, ${DEFAULT_MAX_WEEKLY_HOURS}h weekly cap unless set per person.`];
    for (const start of [weekStart(today), dateOf(dayNumber(weekStart(today)) + 7)]) {
      const w = this.weekOf(workspaceId, start);
      lines.push(`Week of ${w.weekStart}: ${w.shifts.length} shifts, ${w.openShifts} open, ${w.totalHours}h total${w.totalCostMinor !== null ? `, labour cost ${(w.totalCostMinor / 100).toFixed(2)}` : ""}.`);
      for (const s of w.shifts.slice(0, 60)) lines.push(`- ${s.date} ${s.start}-${s.end} ${people.find((p) => p.id === s.staffId)?.name ?? "OPEN"}${s.role ? ` (${s.role})` : ""}`);
      for (const p of w.hoursByPerson) if (p.hours > 0) lines.push(`  ${p.name}: ${p.hours}h of ${p.cap}h cap`);
    }
    lines.push(`Staff: ${people.map((p) => `${p.name}${p.role ? ` (${p.role})` : ""}`).join(", ")}.`);
    for (const p of people) {
      const l = p.limits;
      if (!l) continue;
      const bits = l.availability.map((a) => `${DAY_NAMES[a.day]} ${a.off ? "off" : `${a.from}-${a.to} only`}`);
      if (l.maxShiftHours) bits.push(`shifts up to ${l.maxShiftHours}h`);
      if (l.maxHoursPerWeek) bits.push(`up to ${l.maxHoursPerWeek}h a week`);
      for (const a of l.away.slice(0, 5)) bits.push(`away ${a.from} to ${a.to}`);
      if (bits.length) lines.push(`  ${p.name} limits: ${bits.join("; ")}.`);
    }
    lines.push("Answer only from these records. Never invent shifts, hours or pay.");
    return lines.join("\n");
  }

  // ---------- rules ----------

  private checkAssign(workspaceId: string, shift: Shift, staffId: string): void {
    const person = this.staffOf(workspaceId, staffId);
    if (!person.active) throw new RotaError(`${person.name} has left the rota`);
    const me = span(shift);
    const theirs = this.mine(workspaceId, this.shifts).filter((s) => s.staffId === staffId && s.id !== shift.id);
    for (const other of theirs) {
      const o = span(other);
      if (me.from < o.to && o.from < me.to) throw new RotaError(`${person.name} already works ${other.date} ${other.start}-${other.end}`);
      const gap = me.from >= o.to ? (me.from - o.to) / 60 : (o.from - me.to) / 60;
      if (gap < MIN_REST_HOURS) throw new RotaError(`${person.name} would get only ${round2(gap)}h rest around ${other.date} ${other.start}-${other.end} (at least ${MIN_REST_HOURS}h needed)`);
    }
    this.checkLimits(person, shift);
    const wk = weekStart(shift.date);
    const inWeek = theirs.filter((s) => weekStart(s.date) === wk).reduce((n, s) => n + hoursOf(s), 0) + hoursOf(shift);
    const cap = capOf(person);
    if (inWeek > cap) throw new RotaError(`that would put ${person.name} at ${round2(inWeek)}h in the week of ${wk}, over the ${cap}h limit`);
  }

  /** What the person said on the HR desk: days off, only certain hours, longest shift, approved time off. */
  private checkLimits(person: Staff, shift: Shift): void {
    const l = person.limits;
    if (!l) return;
    const name = person.name;
    const away = l.away.find((a) => shift.date >= a.from && shift.date <= a.to);
    if (away) throw new RotaError(`${name} has approved time off from ${away.from} to ${away.to}`);
    const dow = (dayNumber(shift.date) + 3) % 7;
    const rule = l.availability.find((a) => a.day === dow);
    if (rule?.off) throw new RotaError(`${name} is not available on ${DAY_NAMES[dow]}s (HR desk)`);
    if (rule?.from && rule.to) {
      const win = span({ date: shift.date, start: rule.from, end: rule.to });
      const me = span(shift);
      if (me.from < win.from || me.to > win.to) throw new RotaError(`${name} can only work ${rule.from} to ${rule.to} on ${DAY_NAMES[dow]}s (HR desk)`);
    }
    if (l.maxShiftHours && hoursOf(shift) > l.maxShiftHours) throw new RotaError(`${name} asked for shifts of at most ${l.maxShiftHours} hours`);
  }

  private staffOf(workspaceId: string, id: string): Staff {
    const s = this.staff.get(id);
    if (!s || s.workspaceId !== workspaceId) throw new RotaError("that person is not on your rota");
    return s;
  }
  private shiftOf(workspaceId: string, id: string): Shift {
    const s = this.shifts.get(id);
    if (!s || s.workspaceId !== workspaceId) throw new RotaError("shift not found");
    return s;
  }
  private mine<T extends { workspaceId: string }>(workspaceId: string, m: Map<string, T>): T[] {
    return [...m.values()].filter((x) => x.workspaceId === workspaceId);
  }
  private saveStaff(s: Staff): void { this.staff.set(s.id, s); this.sink?.record(s.workspaceId, "rota_staff", s.id, s); }
  private saveShift(s: Shift): void { this.shifts.set(s.id, s); this.sink?.record(s.workspaceId, "rota_shift", s.id, s); }
}

function wholeNumber(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new RotaError(`${label} must be a whole number from ${min} to ${max}`);
  return v;
}
const round2 = (n: number): number => Math.round(n * 100) / 100;
