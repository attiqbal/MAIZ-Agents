import { createHash, randomBytes } from "node:crypto";
import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";
import { addDays, isIsoDate, toIsoDate } from "./dates.js";
import { ALL_REQUIREMENT_KEYS, SECTORS, requiredDocuments, type Sector } from "./requirements.js";
import {
  ALL_CHECKLIST_KEYS, CONTRACT_LABEL, RTW_LABEL, hrSummary, offOn, rtwRetainUntil, staffDetail, staffStatus,
  type ContractType, type DeskSettings, type DocStatus, type HrSummary, type LeaveKind,
  type PensionStatus, type ReviewKind, type RtwRoute, type StaffDetail, type StaffMember,
} from "./rules.js";
import { FORM_LINK_DAYS, PeopleError, SECTOR_QUESTIONS, availabilityLines, mergeProfile, readProfile, type DayAvailability, type SectorQuestion, type StaffProfile } from "./profile.js";

export * from "./rules.js";
export * from "./requirements.js";
export * from "./dates.js";
export * from "./profile.js";

/**
 * The HR manager desk: the client's records for its real (human) staff.
 *
 * Staff records are personal data, so only the client's owner and admins (`people.manage`) can
 * read or change them, every read of a full record and every change goes to the client's audit
 * log, and the platform owner never sees them. The rules that decide which documents a person
 * needs live in ./rules.ts and ./requirements.ts and are shared with the website.
 */

export type PeopleSettings = DeskSettings;
export const DEFAULT_SETTINGS: PeopleSettings = { sector: "other", leaveYearStartMonth: 1 };

export type RotaWeek = NonNullable<StaffDetail["rota"]>;

/** How the desk reaches the rota, so a person is entered once and shows in both. */
export interface PeopleOptions {
  now?: () => Date;
  /** Puts a new person on the rota; returns the rota id, or why that was not possible. */
  addToRota?: (userId: string, m: StaffMember) => { id: string } | { problem: string };
  /** Takes a person who has left off the rota (future shifts become open). */
  removeFromRota?: (userId: string, m: StaffMember, today: string) => void;
  rotaWeek?: (workspaceId: string, rotaStaffId: string, today: string) => RotaWeek | undefined;
  /** Gives the rota what it must respect for this person: availability, hours wanted and approved time off. */
  syncRota?: (m: StaffMember, prefs: RotaPrefs) => void;
  /** The client's business name, shown on a staff member's form. */
  businessName?: (workspaceId: string) => string | undefined;
}

/** What the rota enforces for one person, worked out from their profile and approved leave. */
export interface RotaPrefs {
  availability: DayAvailability[];
  maxShiftHours?: number;
  maxHoursPerWeek?: number;
  /** Approved time off from today on. */
  away: { from: string; to: string }[];
}

/** What a member of staff sees when they open their form link: their own answers, nothing about anyone else. */
export interface StaffFormView {
  businessName: string;
  firstName: string;
  jobTitle: string;
  questions: SectorQuestion[];
  phone?: string;
  email?: string;
  profile: StaffProfile;
  /** Time off they asked for that is not decided yet. */
  pending: { from: string; to: string; days: number }[];
  expiresOn: string;
}

/** Undecided time-off requests one person can have open from their form. */
const MAX_OPEN_REQUESTS = 10;
const hashToken = (t: string): string => createHash("sha256").update(t).digest("hex");

export interface PeopleView {
  settings: PeopleSettings;
  /** `actions` holds at most MAX_ACTIONS_LISTED, most urgent first; the rest show on each person's record. */
  summary: HrSummary & { actionsTotal: number };
  offToday: ReturnType<typeof offOn>;
}

/** Most staff a client can keep on the desk. */
export const MAX_STAFF = 1000;
/** Most actions the desk overview sends; a big staff list can have thousands. */
export const MAX_ACTIONS_LISTED = 50;
const MAX_LEAVE = 400;
const MAX_REVIEWS = 100;
const TEXT = { name: 120, job: 120, email: 200, phone: 40, manager: 120, payrollId: 40, note: 1000, notes: 4000 };

const CONTRACTS = Object.keys(CONTRACT_LABEL) as ContractType[];
const ROUTES = Object.keys(RTW_LABEL) as RtwRoute[];
const PENSIONS: PensionStatus[] = ["to_assess", "enrolled", "opted_out", "not_eligible"];
const DOC_STATUSES: DocStatus[] = ["missing", "requested", "received", "checked"];
const LEAVE_KINDS: LeaveKind[] = ["holiday", "sick", "other"];
const REVIEW_KINDS: ReviewKind[] = ["probation", "annual", "one_to_one"];
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

type Input = Record<string, unknown>;

function text(v: unknown, max: number, what: string, required = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new PeopleError(`${what} is needed`);
    return undefined;
  }
  if (typeof v !== "string") throw new PeopleError(`${what} must be text`);
  // Control characters are dropped so a name can never break a CSV export or a log line.
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!s && required) throw new PeopleError(`${what} is needed`);
  if (s.length > max) throw new PeopleError(`${what} is too long (at most ${max} characters)`);
  return s || undefined;
}
function date(v: unknown, what: string, required = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new PeopleError(`${what} is needed`);
    return undefined;
  }
  if (!isIsoDate(v)) throw new PeopleError(`${what} must be a date like 2026-11-30`);
  return v;
}
function num(v: unknown, min: number, max: number, what: string, required = false): number | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new PeopleError(`${what} is needed`);
    return undefined;
  }
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) throw new PeopleError(`${what} must be between ${min} and ${max}`);
  return n;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new PeopleError(`${what} is not one of the choices`);
  return v as T;
}

/** One line on when someone can work, for AI employees. No contact details, notes or skills' expiry. */
function workLine(p: StaffProfile): string {
  const parts = availabilityLines(p);
  if (p.hoursMin !== undefined || p.hoursMax !== undefined) parts.push(`wants ${p.hoursMin ?? 0} to ${p.hoursMax ?? "any"} hours a week`);
  if (p.prefers?.length) parts.push(`prefers ${p.prefers.join(", ")}`);
  if (p.avoids?.length) parts.push(`would rather not do ${p.avoids.join(", ")}`);
  if (p.maxShiftHours) parts.push(`shifts up to ${p.maxShiftHours}h`);
  return parts.join("; ") || "any time";
}

/** The record as the website gets it: when the form link was made and expires, never its hash. */
function withoutLinkHash(m: StaffMember): StaffMember {
  if (!m.formLink) return m;
  const { hash: _hash, ...link } = m.formLink;
  return { ...m, formLink: link };
}

/** The fields a client may set on a person; everything else (documents, leave, ids) has its own call. */
function profileFields(b: Input, creating: boolean): Partial<StaffMember> {
  const out: Partial<StaffMember> = {};
  const set = <K extends keyof StaffMember>(k: K, v: StaffMember[K] | undefined) => { if (v !== undefined || (!creating && k in b)) out[k] = v as StaffMember[K]; };
  set("name", text(b.name, TEXT.name, "name", creating));
  set("jobTitle", text(b.jobTitle, TEXT.job, "job title", creating));
  set("startDate", date(b.startDate, "start date", creating));
  set("contract", oneOf(b.contract, CONTRACTS, "contract type") ?? (creating ? "full_time" : undefined));
  set("hoursPerWeek", num(b.hoursPerWeek, 0, 80, "hours a week", creating));
  set("daysPerWeek", num(b.daysPerWeek, 0, 7, "days a week"));
  const email = text(b.email, TEXT.email, "email");
  if (email && !EMAIL.test(email)) throw new PeopleError("that email address does not look right");
  set("email", email);
  set("phone", text(b.phone, TEXT.phone, "phone"));
  set("dateOfBirth", date(b.dateOfBirth, "date of birth"));
  set("manager", text(b.manager, TEXT.manager, "manager"));
  const pay = num(b.payPence, 0, 100_000_000, "pay");
  set("payPence", pay === undefined ? undefined : Math.round(pay));
  set("payBasis", oneOf(b.payBasis, ["hour", "year"] as const, "pay basis"));
  set("payrollId", text(b.payrollId, TEXT.payrollId, "payroll ID"));
  set("pension", oneOf(b.pension, PENSIONS, "pension status") ?? (creating ? "to_assess" : undefined));
  set("probationEndsOn", date(b.probationEndsOn, "probation end date"));
  set("rtwRoute", oneOf(b.rtwRoute, ROUTES, "right-to-work route") ?? (creating ? "unknown" : undefined));
  set("rtwExpiresOn", date(b.rtwExpiresOn, "permission end date"));
  set("notes", text(b.notes, TEXT.notes, "notes"));
  if (!creating && "name" in b && !out.name) throw new PeopleError("name is needed");
  if (!creating && "jobTitle" in b && !out.jobTitle) throw new PeopleError("job title is needed");
  if (!creating && "startDate" in b && !out.startDate) throw new PeopleError("start date is needed");
  return out;
}

export class PeopleService {
  private staff = new Map<string, StaffMember>();
  /** Staff ids per client, so one client's desk never scans everyone else's staff. */
  private byWorkspace = new Map<string, Set<string>>();
  private settingsBy = new Map<string, PeopleSettings>();
  /** Form link hash -> staff id. */
  private byLink = new Map<string, string>();
  private sink?: Sink;

  constructor(private identity: IdentityService, private audit: AuditLog, private opts: PeopleOptions = {}) {}

  useSink(sink: Sink): void { this.sink = sink; }
  restore(m: StaffMember): void { this.put(m); }
  restoreSettings(workspaceId: string, s: PeopleSettings): void { this.settingsBy.set(workspaceId, { ...DEFAULT_SETTINGS, ...s }); }

  private today(): string { return toIsoDate(this.opts.now?.() ?? new Date()); }
  private stamp(): string { return (this.opts.now?.() ?? new Date()).toISOString(); }
  private put(m: StaffMember): void {
    this.staff.set(m.id, m);
    const ids = this.byWorkspace.get(m.workspaceId) ?? new Set<string>();
    ids.add(m.id);
    this.byWorkspace.set(m.workspaceId, ids);
    for (const [h, id] of this.byLink) if (id === m.id && h !== m.formLink?.hash) this.byLink.delete(h);
    if (m.formLink?.hash) this.byLink.set(m.formLink.hash, m.id);
  }
  private inWorkspace(ws: string): StaffMember[] {
    return [...(this.byWorkspace.get(ws) ?? [])].map((id) => this.staff.get(id)).filter((m): m is StaffMember => !!m);
  }
  private log(userId: string, ws: string, action: string, target?: string, data?: Record<string, unknown>): void {
    this.audit.record({ workspaceId: ws, actor: `user:${userId}`, action, ...(target ? { target } : {}), ...(data ? { data } : {}) });
  }
  private find(ws: string, id: string): StaffMember {
    const m = this.staff.get(id);
    // Same answer for "not yours" and "does not exist", so ids cannot be probed across clients.
    if (!m || m.workspaceId !== ws) throw new PeopleError("that person is not on your staff list");
    return m;
  }
  private save(next: StaffMember): StaffMember {
    this.put(next);
    this.sink?.staff(next);
    if (next.rotaStaffId) this.opts.syncRota?.(next, this.rotaPrefs(next));
    return next;
  }
  private rotaPrefs(m: StaffMember): RotaPrefs {
    const today = this.today();
    const p = m.profile;
    return {
      availability: p?.availability ?? [],
      ...(p?.maxShiftHours ? { maxShiftHours: p.maxShiftHours } : {}),
      ...(p?.hoursMax ? { maxHoursPerWeek: p.hoursMax } : {}),
      away: m.leave.filter((l) => l.status === "approved" && l.to >= today).map((l) => ({ from: l.from, to: l.to })).slice(0, 100),
    };
  }

  settings(userId: string, ws: string): PeopleSettings {
    this.identity.require(userId, ws, "people.manage");
    return this.settingsBy.get(ws) ?? DEFAULT_SETTINGS;
  }

  updateSettings(userId: string, ws: string, b: Input): PeopleSettings {
    this.identity.require(userId, ws, "people.manage");
    const cur = this.settingsBy.get(ws) ?? DEFAULT_SETTINGS;
    const sector = oneOf(b.sector, SECTORS.map((s) => s.key), "sector") ?? cur.sector;
    const month = num(b.leaveYearStartMonth, 1, 12, "leave year start month");
    const next: PeopleSettings = { sector, leaveYearStartMonth: month === undefined ? cur.leaveYearStartMonth : Math.round(month) };
    this.settingsBy.set(ws, next);
    this.sink?.peopleSettings(ws, next);
    this.log(userId, ws, "people.settings_changed", undefined, { sector: next.sector, leaveYearStartMonth: next.leaveYearStartMonth });
    return next;
  }

  /** The desk: headline numbers, actions and one row per person (no personal details beyond name and job). */
  overview(userId: string, ws: string): PeopleView {
    const settings = this.settings(userId, ws);
    const staff = this.inWorkspace(ws);
    const today = this.today();
    const summary = hrSummary(staff, settings.sector, today);
    return { settings, summary: { ...summary, actions: summary.actions.slice(0, MAX_ACTIONS_LISTED), actionsTotal: summary.actions.length }, offToday: offOn(staff, today) };
  }

  /** One person's full record. Opening it is audited, since it holds personal data. */
  detail(userId: string, ws: string, id: string, audit = true): StaffDetail {
    const { sector, leaveYearStartMonth } = this.settings(userId, ws);
    const m = this.find(ws, id);
    const today = this.today();
    if (audit) this.log(userId, ws, "people.record_viewed", id);
    const rota = m.rotaStaffId ? this.opts.rotaWeek?.(ws, m.rotaStaffId, today) : undefined;
    return { ...staffDetail(withoutLinkHash(m), { sector, leaveYearStartMonth }, today), ...(rota ? { rota } : {}) };
  }

  /** Adds a person. `rotaNote` says why they could not also go on the rota, when that happens. */
  add(userId: string, ws: string, b: Input): StaffDetail & { rotaNote?: string } {
    this.identity.require(userId, ws, "people.manage");
    if (this.inWorkspace(ws).length >= MAX_STAFF) throw new PeopleError(`the staff list holds at most ${MAX_STAFF} people`);
    const f = profileFields(b, true);
    const at = this.stamp();
    const m: StaffMember = {
      id: newId("staff"),
      workspaceId: ws,
      name: f.name!, jobTitle: f.jobTitle!, startDate: f.startDate!, contract: f.contract!, hoursPerWeek: f.hoursPerWeek!,
      daysPerWeek: f.daysPerWeek ?? Math.min(5, Math.max(1, Math.round(f.hoursPerWeek! / 7.5))),
      pension: f.pension!, rtwRoute: f.rtwRoute!,
      ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)),
      documents: {}, checklist: {}, leave: [], reviews: [], createdAt: at, updatedAt: at,
    } as StaffMember;
    const onRota = this.opts.addToRota?.(userId, m);
    this.save(onRota && "id" in onRota ? { ...m, rotaStaffId: onRota.id } : m);
    this.log(userId, ws, "people.added", m.id);
    const rotaNote = onRota && "problem" in onRota ? `Saved, but not added to the rota: ${onRota.problem}` : undefined;
    return { ...this.detail(userId, ws, m.id, false), ...(rotaNote ? { rotaNote } : {}) };
  }

  update(userId: string, ws: string, id: string, b: Input): StaffDetail {
    this.identity.require(userId, ws, "people.manage");
    const cur = this.find(ws, id);
    const f = profileFields(b, false);
    const next = { ...cur, ...f, updatedAt: this.stamp() } as StaffMember;
    for (const k of Object.keys(next) as (keyof StaffMember)[]) if (next[k] === undefined) delete next[k];
    if (next.endDate && next.endDate < next.startDate) throw new PeopleError("the leaving date is before the start date");
    this.save(next);
    this.log(userId, ws, "people.updated", id, { fields: Object.keys(f) });
    return this.detail(userId, ws, id, false);
  }

  /** Records a document's status. Marking it checked stamps who checked it and when. */
  setDocument(userId: string, ws: string, id: string, key: string, b: Input): StaffDetail {
    this.identity.require(userId, ws, "people.manage");
    const cur = this.find(ws, id);
    if (!ALL_REQUIREMENT_KEYS.has(key)) throw new PeopleError("that is not a document we track");
    const status = oneOf(b.status, DOC_STATUSES, "document status");
    if (!status) throw new PeopleError("say what state the document is in");
    const expiresOn = date(b.expiresOn, "expiry date");
    const checkedOn = status === "checked" ? (date(b.checkedOn, "date checked") ?? this.today()) : undefined;
    if (checkedOn && checkedOn > this.today()) throw new PeopleError("the date checked cannot be in the future");
    const note = text(b.note, TEXT.note, "note");
    const doc = { status, updatedAt: this.stamp(), ...(expiresOn ? { expiresOn } : {}), ...(checkedOn ? { checkedOn, checkedBy: userId } : {}), ...(note ? { note } : {}) };
    // A right-to-work expiry entered on the document is the permission's end date too.
    const rtw = key === "right_to_work" && expiresOn ? { rtwExpiresOn: expiresOn } : {};
    this.save({ ...cur, ...rtw, documents: { ...cur.documents, [key]: doc }, updatedAt: doc.updatedAt });
    this.log(userId, ws, "people.document_updated", id, { document: key, status });
    return this.detail(userId, ws, id, false);
  }

  setChecklist(userId: string, ws: string, id: string, key: string, done: unknown): StaffDetail {
    this.identity.require(userId, ws, "people.manage");
    const cur = this.find(ws, id);
    if (!ALL_CHECKLIST_KEYS.has(key)) throw new PeopleError("that is not a checklist step");
    if (typeof done !== "boolean") throw new PeopleError("say whether the step is done");
    const checklist = { ...cur.checklist };
    if (done) checklist[key] = this.today(); else delete checklist[key];
    this.save({ ...cur, checklist, updatedAt: this.stamp() });
    this.log(userId, ws, "people.checklist_updated", id, { step: key, done });
    return this.detail(userId, ws, id, false);
  }

  /** Books leave. The owner or an admin is entering it, so it is approved unless sent as a request. */
  addLeave(userId: string, ws: string, id: string, b: Input): StaffDetail {
    this.identity.require(userId, ws, "people.manage");
    const cur = this.find(ws, id);
    if (cur.leave.length >= MAX_LEAVE) throw new PeopleError("too many leave records for one person; remove old ones first");
    const kind = oneOf(b.kind, LEAVE_KINDS, "leave type") ?? "holiday";
    const from = date(b.from, "first day off", true)!;
    const to = date(b.to, "last day off") ?? from;
    if (to < from) throw new PeopleError("the last day off is before the first");
    if (to > addDays(from, 366)) throw new PeopleError("leave longer than a year cannot be booked in one go");
    const days = num(b.days, 0.5, 260, "days", true)!;
    if (Math.round(days * 2) !== days * 2) throw new PeopleError("days must be whole or half days");
    const note = text(b.note, TEXT.note, "note");
    const status = b.status === "requested" ? "requested" : "approved";
    const rec = { id: newId("leave"), kind, from, to, days, status, ...(note ? { note } : {}) } as const;
    this.save({ ...cur, leave: [...cur.leave, rec], updatedAt: this.stamp() });
    this.log(userId, ws, "people.leave_added", id, { kind, days, status });
    return this.detail(userId, ws, id, false);
  }

  decideLeave(userId: string, ws: string, id: string, leaveId: string, approve: unknown): StaffDetail {
    this.identity.require(userId, ws, "approval.decide");
    this.identity.require(userId, ws, "people.manage");
    const cur = this.find(ws, id);
    const l = cur.leave.find((x) => x.id === leaveId);
    if (!l) throw new PeopleError("that leave request is not on this record");
    if (l.status !== "requested") throw new PeopleError("that leave is already decided");
    if (typeof approve !== "boolean") throw new PeopleError("say approve or decline");
    const status = approve ? "approved" : "declined";
    this.save({ ...cur, leave: cur.leave.map((x) => (x.id === leaveId ? { ...x, status } : x)), updatedAt: this.stamp() });
    this.log(userId, ws, "people.leave_decided", id, { leave: leaveId, status });
    return this.detail(userId, ws, id, false);
  }

  addReview(userId: string, ws: string, id: string, b: Input): StaffDetail {
    this.identity.require(userId, ws, "people.manage");
    const cur = this.find(ws, id);
    if (cur.reviews.length >= MAX_REVIEWS) throw new PeopleError("too many reviews on one record");
    const kind = oneOf(b.kind, REVIEW_KINDS, "review type") ?? "one_to_one";
    const dueOn = date(b.dueOn, "review date", true)!;
    const doneOn = date(b.doneOn, "date held");
    const note = text(b.note, TEXT.note, "note");
    const rec = { id: newId("hr_review"), kind, dueOn, ...(doneOn ? { doneOn } : {}), ...(note ? { note } : {}) };
    this.save({ ...cur, reviews: [...cur.reviews, rec], updatedAt: this.stamp() });
    this.log(userId, ws, "people.review_added", id, { kind });
    return this.detail(userId, ws, id, false);
  }

  completeReview(userId: string, ws: string, id: string, reviewId: string, b: Input): StaffDetail {
    this.identity.require(userId, ws, "people.manage");
    const cur = this.find(ws, id);
    const note = text(b.note, TEXT.note, "note");
    const doneOn = date(b.doneOn, "date held") ?? this.today();
    let reviews = cur.reviews;
    // The probation review the desk suggests from the probation end date has no record yet.
    if (reviewId === "probation" && !reviews.some((r) => r.id === "probation")) {
      if (!cur.probationEndsOn) throw new PeopleError("no probation end date is set");
      reviews = [...reviews, { id: newId("hr_review"), kind: "probation", dueOn: cur.probationEndsOn, doneOn, ...(note ? { note } : {}) }];
    } else {
      if (!reviews.some((r) => r.id === reviewId)) throw new PeopleError("that review is not on this record");
      reviews = reviews.map((r) => (r.id === reviewId ? { ...r, doneOn, ...(note ? { note } : {}) } : r));
    }
    this.save({ ...cur, reviews, updatedAt: this.stamp() });
    this.log(userId, ws, "people.review_done", id);
    return this.detail(userId, ws, id, false);
  }

  /** Sets (or clears, with no date) the leaving date. The leaving checklist starts from it. */
  setLeaving(userId: string, ws: string, id: string, endDate: unknown): StaffDetail {
    this.identity.require(userId, ws, "people.manage");
    const cur = this.find(ws, id);
    const end = date(endDate, "leaving date");
    if (end && end < cur.startDate) throw new PeopleError("the leaving date is before the start date");
    const next = { ...cur, updatedAt: this.stamp() };
    if (end) next.endDate = end; else delete next.endDate;
    this.save(next);
    if (end && end <= this.today() && next.rotaStaffId) this.opts.removeFromRota?.(userId, next, this.today());
    this.log(userId, ws, end ? "people.leaving_set" : "people.leaving_cleared", id);
    return this.detail(userId, ws, id, false);
  }

  // ---------- what they told us, and their own form link ----------

  /** The owner fills in or corrects someone's availability, preferences, emergency contact and skills. */
  updateProfile(userId: string, ws: string, id: string, b: Input): StaffDetail {
    this.identity.require(userId, ws, "people.manage");
    const cur = this.find(ws, id);
    const { sector } = this.settingsBy.get(ws) ?? DEFAULT_SETTINGS;
    const changes = readProfile(b, sector);
    this.save(this.withEmergencyDoc({ ...cur, profile: mergeProfile(cur.profile, changes, "owner", this.today()), updatedAt: this.stamp() }, `user:${userId}`));
    this.log(userId, ws, "people.profile_updated", id, { fields: Object.keys(changes) });
    return this.detail(userId, ws, id, false);
  }

  /**
   * Makes a link the person can open to fill in their own details, without an account. It works for
   * FORM_LINK_DAYS days; making a new one stops the old one. Only a hash is stored.
   */
  createFormLink(userId: string, ws: string, id: string): { token: string; expiresOn: string } {
    this.identity.require(userId, ws, "people.manage");
    const cur = this.find(ws, id);
    if (cur.endDate && cur.endDate < this.today()) throw new PeopleError("they have left, so they cannot be sent the form");
    const token = randomBytes(24).toString("base64url");
    const expiresOn = addDays(this.today(), FORM_LINK_DAYS);
    this.save({ ...cur, formLink: { hash: hashToken(token), createdOn: this.today(), expiresOn }, updatedAt: this.stamp() });
    this.log(userId, ws, "people.form_link_created", id, { expiresOn });
    return { token, expiresOn };
  }

  stopFormLink(userId: string, ws: string, id: string): StaffDetail {
    this.identity.require(userId, ws, "people.manage");
    const cur = this.find(ws, id);
    const next = { ...cur, updatedAt: this.stamp() };
    delete next.formLink;
    this.save(next);
    this.log(userId, ws, "people.form_link_stopped", id);
    return this.detail(userId, ws, id, false);
  }

  /** The person behind a live form link. Same answer for unknown and expired links. */
  private byToken(token: unknown): StaffMember {
    const id = typeof token === "string" && /^[\w-]{20,64}$/.test(token) ? this.byLink.get(hashToken(token)) : undefined;
    const m = id ? this.staff.get(id) : undefined;
    if (!m?.formLink || m.formLink.expiresOn < this.today() || (m.endDate && m.endDate < this.today())) throw new PeopleError("this form link has expired or been stopped; ask your manager for a new one");
    return m;
  }

  /** What the person sees on their form. */
  formView(token: unknown): StaffFormView {
    const m = this.byToken(token);
    const { sector } = this.settingsBy.get(m.workspaceId) ?? DEFAULT_SETTINGS;
    return {
      businessName: this.opts.businessName?.(m.workspaceId) ?? "your employer",
      firstName: (m.profile?.preferredName ?? m.name).split(" ")[0]!,
      jobTitle: m.jobTitle,
      questions: SECTOR_QUESTIONS[sector],
      ...(m.phone ? { phone: m.phone } : {}),
      ...(m.email ? { email: m.email } : {}),
      profile: m.profile ?? {},
      pending: m.leave.filter((l) => l.status === "requested" && l.to >= this.today()).map((l) => ({ from: l.from, to: l.to, days: l.days })),
      expiresOn: m.formLink!.expiresOn,
    };
  }

  /** The person sends their answers, and optionally asks for time off (which waits for the owner to decide). */
  submitForm(token: unknown, b: Input): StaffFormView {
    const cur = this.byToken(token);
    const ws = cur.workspaceId;
    const { sector } = this.settingsBy.get(ws) ?? DEFAULT_SETTINGS;
    const changes = readProfile((b.profile && typeof b.profile === "object" ? b.profile : {}) as Input, sector);
    const next: StaffMember = { ...cur, profile: mergeProfile(cur.profile, changes, "staff", this.today()), formLink: { ...cur.formLink!, usedOn: this.today() }, updatedAt: this.stamp() };
    if ("phone" in b) { const phone = text(b.phone, TEXT.phone, "phone"); if (phone) next.phone = phone; else delete next.phone; }
    if ("email" in b) {
      const email = text(b.email, TEXT.email, "email");
      if (email && !EMAIL.test(email)) throw new PeopleError("that email address does not look right");
      if (email) next.email = email; else delete next.email;
    }
    let asked: { days: number } | undefined;
    if (b.timeOff && typeof b.timeOff === "object") {
      const t = b.timeOff as Input;
      const from = date(t.from, "first day off", true)!;
      const to = date(t.to, "last day off") ?? from;
      if (from < this.today()) throw new PeopleError("time off has to start today or later");
      if (to < from) throw new PeopleError("the last day off is before the first");
      if (to > addDays(from, 366)) throw new PeopleError("ask for at most a year in one go");
      const days = num(t.days, 0.5, 260, "working days off", true)!;
      if (Math.round(days * 2) !== days * 2) throw new PeopleError("days must be whole or half days");
      if (cur.leave.filter((l) => l.status === "requested").length >= MAX_OPEN_REQUESTS) throw new PeopleError("you already have several requests waiting; ask your manager to decide those first");
      if (cur.leave.length >= MAX_LEAVE) throw new PeopleError("too many leave records; ask your manager");
      const note = text(t.note, TEXT.note, "note");
      next.leave = [...cur.leave, { id: newId("leave"), kind: "holiday", from, to, days, status: "requested", ...(note ? { note } : {}) }];
      asked = { days };
    }
    this.save(this.withEmergencyDoc(next, "staff form"));
    this.audit.record({ workspaceId: ws, actor: `staff:${cur.id}`, action: "people.form_submitted", target: cur.id, data: { fields: Object.keys(changes), ...(asked ? { timeOffDays: asked.days } : {}) } });
    return this.formView(token);
  }

  /** An emergency contact given on the form counts as the "emergency contact" record, unless already checked. */
  private withEmergencyDoc(m: StaffMember, by: string): StaffMember {
    const p = m.profile;
    if (!p?.emergencyName || !p.emergencyPhone || m.documents.emergency_contact?.status === "checked") return m;
    const today = this.today();
    return { ...m, documents: { ...m.documents, emergency_contact: { status: "checked", checkedOn: today, checkedBy: by, updatedAt: today, note: "From the staff details form" } } };
  }

  /** Deletes a record for good (a data request, or the retention period has passed). Owner only. */
  remove(userId: string, ws: string, id: string): void {
    this.identity.require(userId, ws, "workspace.manage");
    const cur = this.find(ws, id);
    const keepUntil = rtwRetainUntil(cur);
    if (!cur.endDate || cur.endDate >= this.today()) throw new PeopleError("set a leaving date in the past first; records of current staff are kept");
    this.staff.delete(id);
    this.byWorkspace.get(ws)?.delete(id);
    if (cur.formLink?.hash) this.byLink.delete(cur.formLink.hash);
    this.sink?.staff(cur, true);
    this.log(userId, ws, "people.deleted", id, keepUntil && keepUntil > this.today() ? { retentionWarning: `right-to-work evidence should be kept until ${keepUntil}` } : undefined);
  }

  /**
   * What the HR manager (an AI employee) is told about the staff records: the action list and who is
   * off, never pay, dates of birth, contact details or notes.
   */
  contextFor(ws: string, templateKey: string): string | undefined {
    if (templateKey !== "hr-manager" && templateKey !== "compliance-manager") return undefined;
    const staff = this.inWorkspace(ws);
    if (!staff.length) return "Staff records (HR desk): no staff added yet. If asked about staff documents, say the owner can add people on the HR desk.";
    const { sector } = this.settingsBy.get(ws) ?? DEFAULT_SETTINGS;
    const today = this.today();
    const sum = hrSummary(staff, sector, today);
    const lines = [
      `Staff records (HR desk, current, entered by the owner): ${sum.headcount} staff, records ${sum.recordsComplete}% complete, ${sum.expiringSoon} documents expiring within 60 days, ${sum.expired} expired.`,
      ...sum.actions.slice(0, 40).map((a) => `- [${a.severity}] ${a.staffName}: ${a.title}${a.dueOn ? ` (${a.dueOn})` : ""}`),
      ...offOn(staff, today).map((o) => `Off today: ${o.name} (${o.kind}) until ${o.to}`),
      ...staff.filter((m) => m.profile?.updatedOn && staffStatus(m, today) !== "left").slice(0, 100).map((m) => `When ${m.name} can work: ${workLine(m.profile!)}`),
      "Answer only from these records. Never invent documents, dates or people.",
    ];
    return lines.join("\n");
  }

  /** Required documents for a person, for the website's "what to ask for" text. */
  requirementsFor(userId: string, ws: string, id: string) {
    const { sector } = this.settings(userId, ws);
    return requiredDocuments(this.find(ws, id), sector, this.today());
  }
}
