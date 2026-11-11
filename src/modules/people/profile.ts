// What a member of staff tells the business about themselves: contact and emergency contact, the hours they
// want, when they can work, shift preferences, skills held (name and expiry only, never a copy of a certificate),
// how they get to work and a few questions for the business's sector. Filled in by the owner on the HR desk or by
// the person through their own form link. Pure data and validation, shared with the website.
//
// ID documents are deliberately not collected here: the owner checks them in person and the desk records only
// that the check was done.
import { isIsoDate } from "./dates.js";
import type { Sector } from "./requirements.js";

export class PeopleError extends Error {}

/** How long a staff form link works. */
export const FORM_LINK_DAYS = 14;

/** Monday = 0 … Sunday = 6, as on a UK rota. */
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export type ShiftTime = "early" | "day" | "late" | "night" | "weekend";
export const SHIFT_TIME_LABEL: Record<ShiftTime, string> = {
  early: "Early starts (before 8am)", day: "Daytime", late: "Late finishes (after 8pm)", night: "Nights", weekend: "Weekends",
};
export const SHIFT_TIMES = Object.keys(SHIFT_TIME_LABEL) as ShiftTime[];

export type Transport = "car" | "public" | "cycle_walk" | "lift" | "other";
export const TRANSPORT_LABEL: Record<Transport, string> = {
  car: "Drives", public: "Bus or train", cycle_walk: "Cycles or walks", lift: "Gets a lift", other: "Other",
};
export const TRANSPORTS = Object.keys(TRANSPORT_LABEL) as Transport[];

/** One day's availability. A day with no entry means any time; `off` means never on that day. */
export interface DayAvailability {
  day: number;
  off?: boolean;
  /** Only between these local times (HH:MM). A window ending before it starts runs past midnight. */
  from?: string;
  to?: string;
}

export interface Skill {
  name: string;
  expiresOn?: string;
}

export interface SectorQuestion {
  key: string;
  label: string;
  kind: "yesno" | "text";
}

export interface StaffProfile {
  preferredName?: string;
  emergencyName?: string;
  emergencyRelation?: string;
  emergencyPhone?: string;
  hoursMin?: number;
  hoursMax?: number;
  /** Longest single shift they want to work, in hours. */
  maxShiftHours?: number;
  availability?: DayAvailability[];
  prefers?: ShiftTime[];
  avoids?: ShiftTime[];
  /** Times of year they need off or cannot take holiday (school holidays, exams, festivals). */
  holidayNotes?: string;
  skills?: Skill[];
  transport?: Transport;
  /** Anything else that affects when or how they can work. Not for medical details. */
  constraints?: string;
  sectorAnswers?: Record<string, string | boolean>;
  updatedOn?: string;
  updatedBy?: "owner" | "staff";
}

/** A few questions that matter for a rota in each kind of business. */
export const SECTOR_QUESTIONS: Record<Sector, SectorQuestion[]> = {
  hospitality: [
    { key: "allergen_trained", label: "Trained in allergens", kind: "yesno" },
    { key: "can_open_close", label: "Happy to open or close up", kind: "yesno" },
    { key: "languages", label: "Languages spoken", kind: "text" },
  ],
  care: [
    { key: "drives_for_visits", label: "Can drive between visits", kind: "yesno" },
    { key: "manual_handling", label: "Trained in moving and handling", kind: "yesno" },
    { key: "personal_care", label: "Happy to give personal care", kind: "yesno" },
    { key: "languages", label: "Languages spoken", kind: "text" },
  ],
  childcare: [
    { key: "early_late", label: "Can cover early drop-off or late pick-up", kind: "yesno" },
    { key: "age_groups", label: "Age groups they like working with", kind: "text" },
  ],
  construction: [
    { key: "cscs_card", label: "CSCS card colour or type", kind: "text" },
    { key: "own_tools", label: "Has their own tools", kind: "yesno" },
    { key: "work_at_height", label: "Happy to work at height", kind: "yesno" },
  ],
  retail: [
    { key: "can_open_close", label: "Happy to open or close up", kind: "yesno" },
    { key: "handles_cash", label: "Happy to cash up", kind: "yesno" },
  ],
  transport: [
    { key: "licence_categories", label: "Licence categories (for example B, C1, C)", kind: "text" },
    { key: "tacho_card", label: "Has a driver tachograph card", kind: "yesno" },
  ],
  security: [
    { key: "sia_licence_type", label: "SIA licence type", kind: "text" },
    { key: "lone_working", label: "Happy to work alone", kind: "yesno" },
  ],
  beauty: [
    { key: "treatments", label: "Treatments they are qualified to do", kind: "text" },
  ],
  office: [
    { key: "remote_days", label: "Days they would like to work from home", kind: "text" },
  ],
  other: [],
};

const MAX_SKILLS = 30;
const LIMIT = { name: 120, relation: 60, phone: 40, notes: 1000, skill: 80, answer: 200 };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

type Input = Record<string, unknown>;

function str(v: unknown, max: number, what: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new PeopleError(`${what} must be text`);
  // Control characters are dropped so an answer can never break an export or a log line.
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (s.length > max) throw new PeopleError(`${what} is too long (at most ${max} characters)`);
  return s || undefined;
}
function hours(v: unknown, max: number, what: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > max) throw new PeopleError(`${what} must be between 0 and ${max}`);
  return Math.round(n * 2) / 2;
}
function list<T extends string>(v: unknown, allowed: readonly T[], what: string): T[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => !allowed.includes(x as T))) throw new PeopleError(`${what} has a choice we do not know`);
  return [...new Set(v as T[])];
}

function availability(v: unknown): DayAvailability[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 7) throw new PeopleError("availability must be a list of up to seven days");
  const seen = new Set<number>();
  const out: DayAvailability[] = [];
  for (const raw of v) {
    const d = (raw && typeof raw === "object" ? raw : {}) as Input;
    const day = d.day;
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) throw new PeopleError("availability day must be 0 (Monday) to 6 (Sunday)");
    if (seen.has(day)) throw new PeopleError(`${WEEKDAYS[day]} is listed twice`);
    seen.add(day);
    if (d.off === true) { out.push({ day, off: true }); continue; }
    const from = d.from, to = d.to;
    if (from === undefined && to === undefined) continue; // any time: nothing to store
    if (typeof from !== "string" || typeof to !== "string" || !TIME.test(from) || !TIME.test(to)) throw new PeopleError(`times for ${WEEKDAYS[day]} look like 09:00`);
    if (from === to) throw new PeopleError(`${WEEKDAYS[day]} needs a start and a different end`);
    out.push({ day, from, to });
  }
  return out.sort((a, b) => a.day - b.day);
}

function skills(v: unknown): Skill[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new PeopleError("skills must be a list");
  if (v.length > MAX_SKILLS) throw new PeopleError(`list at most ${MAX_SKILLS} skills or certificates`);
  const out: Skill[] = [];
  for (const raw of v) {
    const s = (raw && typeof raw === "object" ? raw : {}) as Input;
    const name = str(s.name, LIMIT.skill, "skill name");
    if (!name) continue;
    const expiresOn = s.expiresOn === undefined || s.expiresOn === null || s.expiresOn === "" ? undefined : s.expiresOn;
    if (expiresOn !== undefined && !isIsoDate(expiresOn)) throw new PeopleError(`the expiry date for ${name} must be a date like 2027-03-31`);
    out.push(expiresOn ? { name, expiresOn } : { name });
  }
  return out;
}

function sectorAnswers(v: unknown, sector: Sector): Record<string, string | boolean> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new PeopleError("answers must be a set of questions and answers");
  const out: Record<string, string | boolean> = {};
  for (const q of SECTOR_QUESTIONS[sector]) {
    const a = (v as Input)[q.key];
    if (a === undefined || a === null || a === "") continue;
    if (q.kind === "yesno") {
      if (typeof a !== "boolean") throw new PeopleError(`answer yes or no to "${q.label}"`);
      out[q.key] = a;
    } else {
      const s = str(a, LIMIT.answer, q.label);
      if (s) out[q.key] = s;
    }
  }
  return out;
}

/**
 * Reads the profile fields out of a request. Only the fields sent are changed; a field sent empty is cleared.
 * Questions for other sectors are ignored rather than stored.
 */
export function readProfile(b: Input, sector: Sector): Partial<StaffProfile> {
  const out: Partial<StaffProfile> = {};
  const set = <K extends keyof StaffProfile>(k: K, v: StaffProfile[K] | undefined) => { if (k in b) out[k] = v; };
  set("preferredName", str(b.preferredName, LIMIT.name, "preferred name"));
  set("emergencyName", str(b.emergencyName, LIMIT.name, "emergency contact name"));
  set("emergencyRelation", str(b.emergencyRelation, LIMIT.relation, "emergency contact relationship"));
  set("emergencyPhone", str(b.emergencyPhone, LIMIT.phone, "emergency contact phone"));
  set("hoursMin", hours(b.hoursMin, 80, "fewest hours a week"));
  set("hoursMax", hours(b.hoursMax, 80, "most hours a week"));
  set("maxShiftHours", hours(b.maxShiftHours, 16, "longest shift"));
  set("availability", availability(b.availability));
  set("prefers", list(b.prefers, SHIFT_TIMES, "preferred shifts"));
  set("avoids", list(b.avoids, SHIFT_TIMES, "shifts to avoid"));
  set("holidayNotes", str(b.holidayNotes, LIMIT.notes, "holiday notes"));
  set("skills", skills(b.skills));
  if ("transport" in b) {
    const t = b.transport;
    if (t !== undefined && t !== null && t !== "" && !TRANSPORTS.includes(t as Transport)) throw new PeopleError("how they get to work is not one of the choices");
    out.transport = (t || undefined) as Transport | undefined;
  }
  set("constraints", str(b.constraints, LIMIT.notes, "other things that affect work"));
  set("sectorAnswers", sectorAnswers(b.sectorAnswers, sector));
  if (out.hoursMin !== undefined && out.hoursMax !== undefined && out.hoursMin > out.hoursMax) throw new PeopleError("the fewest hours are more than the most hours");
  const clash = (out.prefers ?? []).filter((p) => (out.avoids ?? []).includes(p));
  if (clash.length) throw new PeopleError(`${SHIFT_TIME_LABEL[clash[0]!]} is both preferred and avoided`);
  return out;
}

/** Merges new answers into a profile, dropping cleared fields, and stamps who changed it. */
export function mergeProfile(cur: StaffProfile | undefined, next: Partial<StaffProfile>, by: "owner" | "staff", today: string): StaffProfile {
  const merged: Record<string, unknown> = { ...(cur ?? {}), ...next, updatedOn: today, updatedBy: by };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged as StaffProfile;
}

/** Plain-English lines about when someone can work, for the desk and for AI employees. */
export function availabilityLines(p: StaffProfile | undefined): string[] {
  if (!p?.availability?.length) return [];
  return p.availability.map((a) => `${WEEKDAYS[a.day]}: ${a.off ? "not available" : `${a.from} to ${a.to} only`}`);
}

/** Whether the profile has been filled in at all (by anyone). */
export const profileStarted = (p: StaffProfile | undefined): boolean => Boolean(p?.updatedOn);
