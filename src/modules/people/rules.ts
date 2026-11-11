// The HR manager desk's rules: a staff member's record, which documents are in date, how complete
// the record is, what needs doing next, the onboarding and leaving checklists, and holiday.
// Pure functions over plain data, shared by the server (PeopleService) and the website.
import { addDays, addMonths, daysBetween, leaveYear } from "./dates.js";
import { requiredDocuments, type Requirement, type Sector } from "./requirements.js";

export type ContractType = "full_time" | "part_time" | "zero_hours" | "fixed_term" | "casual" | "apprentice";
export const CONTRACT_LABEL: Record<ContractType, string> = {
  full_time: "Full time", part_time: "Part time", zero_hours: "Zero hours", fixed_term: "Fixed term", casual: "Casual", apprentice: "Apprentice",
};
/** Right-to-work route. Time-limited permission (share code, eVisa) needs a follow-up check before it ends. */
export type RtwRoute = "british_irish" | "share_code" | "evisa" | "unknown";
export const RTW_LABEL: Record<RtwRoute, string> = {
  british_irish: "British or Irish passport", share_code: "Share code (online check)", evisa: "eVisa", unknown: "Not recorded yet",
};
export type PensionStatus = "to_assess" | "enrolled" | "opted_out" | "not_eligible";

export type DocStatus = "missing" | "requested" | "received" | "checked";
export interface StaffDocument {
  status: DocStatus;
  /** When the card, certificate or permission ends, if it has its own date. */
  expiresOn?: string;
  /** When someone at the business saw and checked it. */
  checkedOn?: string;
  checkedBy?: string;
  note?: string;
  updatedAt: string;
}

export type LeaveKind = "holiday" | "sick" | "other";
export interface LeaveRecord {
  id: string;
  kind: LeaveKind;
  from: string;
  to: string;
  /** Working days (holiday) or days off sick. Halves allowed. */
  days: number;
  status: "requested" | "approved" | "declined";
  note?: string;
}

export type ReviewKind = "probation" | "annual" | "one_to_one";
export interface ReviewRecord {
  id: string;
  kind: ReviewKind;
  dueOn: string;
  doneOn?: string;
  note?: string;
}

export interface StaffMember {
  id: string;
  workspaceId: string;
  name: string;
  jobTitle: string;
  startDate: string;
  endDate?: string;
  contract: ContractType;
  hoursPerWeek: number;
  daysPerWeek: number;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  manager?: string;
  /** Pay in pence, per hour or per year. */
  payPence?: number;
  payBasis?: "hour" | "year";
  payrollId?: string;
  pension: PensionStatus;
  probationEndsOn?: string;
  rtwRoute: RtwRoute;
  /** When time-limited permission to work ends. */
  rtwExpiresOn?: string;
  documents: Record<string, StaffDocument>;
  /** Checklist item key -> date done. */
  checklist: Record<string, string>;
  leave: LeaveRecord[];
  reviews: ReviewRecord[];
  notes?: string;
  /** The same person on the rota, so shifts and the staff record stay one list. */
  rotaStaffId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Days before an expiry date that it shows as expiring. */
export const EXPIRY_WARNING_DAYS = 60;
/** Days before an expiry date that it becomes a high-priority action. */
export const EXPIRY_URGENT_DAYS = 30;
/** A starter within this many days with documents missing is high priority. */
export const STARTING_SOON_DAYS = 7;

export type StaffStatus = "starting" | "active" | "on_leave" | "leaving" | "left";
export const STATUS_LABEL: Record<StaffStatus, string> = {
  starting: "Starting soon", active: "Active", on_leave: "Off today", leaving: "Leaving", left: "Left",
};

export function staffStatus(m: StaffMember, today: string): StaffStatus {
  if (m.endDate && m.endDate < today) return "left";
  if (m.startDate > today) return "starting";
  if (m.leave.some((l) => l.status === "approved" && l.from <= today && l.to >= today)) return "on_leave";
  if (m.endDate) return "leaving";
  return "active";
}

export type DocState = "ok" | "expiring" | "expired" | "to_check" | "requested" | "missing";
export const DOC_STATE_LABEL: Record<DocState, string> = {
  ok: "In date", expiring: "Expiring soon", expired: "Expired", to_check: "Received, needs checking", requested: "Requested", missing: "Missing",
};

export interface DocView extends Requirement {
  state: DocState;
  expiresOn?: string;
  daysLeft?: number;
  doc?: StaffDocument;
}

/** "25 Oct 2026": dates inside sentences read naturally, the same on the server and in the browser. */
export const humanDate = (iso: string): string => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const isTimeLimited = (m: StaffMember) => m.rtwRoute === "share_code" || m.rtwRoute === "evisa";

/** When a checked document stops being valid: its own date, the permission's end, or its renewal period. */
function expiryOf(req: Requirement, m: StaffMember, doc: StaffDocument): string | undefined {
  if (req.key === "right_to_work") return isTimeLimited(m) ? (m.rtwExpiresOn ?? doc.expiresOn) : undefined;
  if (doc.expiresOn) return doc.expiresOn;
  if (req.renewMonths && doc.checkedOn) return addMonths(doc.checkedOn, req.renewMonths);
  return undefined;
}

export function docView(req: Requirement, m: StaffMember, today: string): DocView {
  const doc = m.documents[req.key];
  if (!doc || doc.status === "missing") return { ...req, state: "missing", doc };
  if (doc.status === "requested") return { ...req, state: "requested", doc };
  if (doc.status === "received") return { ...req, state: "to_check", doc };
  const expiresOn = expiryOf(req, m, doc);
  if (!expiresOn) return { ...req, state: "ok", doc };
  const daysLeft = daysBetween(today, expiresOn);
  const state: DocState = daysLeft < 0 ? "expired" : daysLeft <= EXPIRY_WARNING_DAYS ? "expiring" : "ok";
  return { ...req, state, expiresOn, daysLeft, doc };
}

export function documentViews(m: StaffMember, sector: Sector, today: string): DocView[] {
  return requiredDocuments(m, sector, today).map((r) => docView(r, m, today));
}

/** Share of required documents that are present, checked and in date (expiring still counts). 0 to 100. */
export function completeness(docs: readonly DocView[]): number {
  if (!docs.length) return 100;
  const done = docs.filter((d) => d.state === "ok" || d.state === "expiring").length;
  return Math.round((done / docs.length) * 100);
}

// ---- checklists ----

export interface ChecklistItem { key: string; label: string; list: "onboarding" | "leaving" }

const ONBOARDING: readonly Omit<ChecklistItem, "list">[] = [
  { key: "on_offer", label: "Send the offer and the written statement of terms" },
  { key: "on_rtw", label: "Do the right-to-work check before the first day" },
  { key: "on_payroll", label: "Add to payroll with tax code and bank details" },
  { key: "on_pension", label: "Assess for the workplace pension and send the letter" },
  { key: "on_rota", label: "Put on the rota and agree usual working days" },
  { key: "on_access", label: "Give keys, accounts, uniform and equipment" },
  { key: "on_induction", label: "Health and safety induction on the first day" },
  { key: "on_buddy", label: "Introduce to the team and pick a buddy for the first weeks" },
  { key: "on_probation", label: "Book the probation review" },
];
const SECTOR_ONBOARDING: Partial<Record<Sector, Omit<ChecklistItem, "list">>> = {
  hospitality: { key: "on_food", label: "Book food hygiene and allergen training" },
  care: { key: "on_dbs", label: "Get the enhanced DBS check back before unsupervised work" },
  childcare: { key: "on_dbs", label: "Get the enhanced DBS check back before working with children" },
  construction: { key: "on_site", label: "Site induction and check the CSCS card" },
  retail: { key: "on_age", label: "Challenge 25 training before working the till" },
  transport: { key: "on_licence", label: "Check the driving licence and add to the vehicle insurance" },
  security: { key: "on_sia", label: "Check the SIA licence on the public register" },
  beauty: { key: "on_quals", label: "Check treatment qualifications and add to the insurance" },
  office: { key: "on_dse", label: "Set up the desk and do the screen assessment" },
};
const LEAVING: readonly Omit<ChecklistItem, "list">[] = [
  { key: "off_confirm", label: "Confirm the end date in writing" },
  { key: "off_holiday", label: "Work out holiday owed or taken in advance" },
  { key: "off_pay", label: "Final pay and P45 through payroll" },
  { key: "off_equipment", label: "Get back keys, uniform and equipment" },
  { key: "off_access", label: "Remove access to accounts and systems" },
  { key: "off_exit", label: "Exit conversation and reference policy" },
];

export function onboardingChecklist(sector: Sector): ChecklistItem[] {
  const extra = SECTOR_ONBOARDING[sector];
  return [...ONBOARDING, ...(extra ? [extra] : [])].map((i) => ({ ...i, list: "onboarding" as const }));
}
export function leavingChecklist(): ChecklistItem[] {
  return LEAVING.map((i) => ({ ...i, list: "leaving" as const }));
}
export const ALL_CHECKLIST_KEYS: ReadonlySet<string> = new Set([
  ...ONBOARDING.map((i) => i.key), ...Object.values(SECTOR_ONBOARDING).map((i) => i!.key), ...LEAVING.map((i) => i.key),
]);

// ---- holiday ----

export const STATUTORY_WEEKS = 5.6;
export const STATUTORY_CAP_DAYS = 28;
/** Holiday accrued per hour worked for irregular-hours and part-year workers (UK, leave years from April 2024). */
export const IRREGULAR_ACCRUAL = 0.1207;

export interface LeaveBalance {
  basis: "days" | "accrual";
  yearStart: string;
  yearEnd: string;
  /** Statutory minimum for this leave year, pro rata to the time employed in it. Days basis only. */
  allowance?: number;
  taken: number;
  booked: number;
  requested: number;
  /** allowance - taken - booked. Days basis only. */
  left?: number;
  sickDays: number;
}

const irregular = (m: StaffMember) => m.contract === "zero_hours" || m.contract === "casual";

/** Rounds up to the next half day, as the statutory first-year calculation does. */
const halfUp = (n: number) => Math.ceil(n * 2) / 2;

export function leaveBalance(m: StaffMember, today: string, yearStartMonth = 1): LeaveBalance {
  const { start, end } = leaveYear(today, yearStartMonth);
  const inYear = m.leave.filter((l) => l.from <= end && l.to >= start);
  const sum = (xs: LeaveRecord[]) => xs.reduce((n, l) => n + l.days, 0);
  const holiday = inYear.filter((l) => l.kind === "holiday");
  const taken = sum(holiday.filter((l) => l.status === "approved" && l.from <= today));
  const booked = sum(holiday.filter((l) => l.status === "approved" && l.from > today));
  const requested = sum(holiday.filter((l) => l.status === "requested"));
  const sickDays = sum(inYear.filter((l) => l.kind === "sick" && l.status !== "declined"));
  if (irregular(m)) return { basis: "accrual", yearStart: start, yearEnd: end, taken, booked, requested, sickDays };
  const full = Math.min(STATUTORY_WEEKS * m.daysPerWeek, STATUTORY_CAP_DAYS);
  const from = m.startDate > start ? m.startDate : start;
  const to = m.endDate && m.endDate < end ? m.endDate : end;
  const yearDays = daysBetween(start, end) + 1;
  const employed = Math.max(0, daysBetween(from, to) + 1);
  const allowance = employed >= yearDays ? full : halfUp((full * employed) / yearDays);
  return { basis: "days", yearStart: start, yearEnd: end, allowance, taken, booked, requested, left: allowance - taken - booked, sickDays };
}

// ---- what needs doing ----

export type Severity = "critical" | "high" | "medium" | "low";
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export type ActionKind = "request" | "check" | "renew" | "approve_leave" | "review" | "checklist";
export interface HrAction {
  id: string;
  staffId: string;
  staffName: string;
  severity: Severity;
  kind: ActionKind;
  title: string;
  detail: string;
  /** The document, leave request or review the action is about. */
  ref?: string;
  dueOn?: string;
}

function docAction(m: StaffMember, d: DocView, status: StaffStatus, today: string): HrAction | undefined {
  if (d.state === "ok") return undefined;
  const started = m.startDate <= today;
  const startsIn = daysBetween(today, m.startDate);
  const base = { staffId: m.id, staffName: m.name, ref: d.key, id: `${m.id}:doc:${d.key}` };
  if (d.state === "expired") {
    const severity: Severity = d.key === "right_to_work" ? "critical" : d.level === "legal" ? "high" : "medium";
    return { ...base, severity, kind: "renew", title: `${d.label} expired`, detail: d.key === "right_to_work" ? "Do a follow-up right-to-work check now. They must not keep working without one." : `Expired on ${humanDate(d.expiresOn!)}. ${d.why}`, dueOn: d.expiresOn };
  }
  if (d.state === "expiring") {
    const severity: Severity = (d.daysLeft ?? 0) <= EXPIRY_URGENT_DAYS ? "high" : "medium";
    return { ...base, severity, kind: "renew", title: `${d.label} expires in ${d.daysLeft} day${d.daysLeft === 1 ? "" : "s"}`, detail: d.key === "right_to_work" ? "Book the follow-up right-to-work check before the permission ends." : "Ask for the renewed one now so there is no gap.", dueOn: d.expiresOn };
  }
  if (d.state === "to_check") {
    return { ...base, severity: d.key === "right_to_work" && started ? "critical" : "medium", kind: "check", title: `Check ${d.label.toLowerCase()}`, detail: "It has arrived. Look at it, then mark it checked." };
  }
  // missing or requested
  const blocking = d.due === "before_start" || d.due === "day_one";
  let severity: Severity;
  if (d.level === "legal" && blocking && started) severity = "critical";
  else if (blocking && !started && startsIn <= STARTING_SOON_DAYS) severity = "high";
  else if (d.level === "legal" && started && daysBetween(m.startDate, today) > 30) severity = "high";
  else if (started || startsIn <= STARTING_SOON_DAYS) severity = d.level === "legal" ? "medium" : "low";
  else severity = "low";
  if (status === "leaving" && severity !== "critical") severity = "low";
  const title = d.state === "requested" ? `Waiting for ${d.label.toLowerCase()}` : `${d.label} missing`;
  return { ...base, severity, kind: "request", title, detail: d.why };
}

/** Everything that needs doing for one person, most urgent first. */
export function staffActions(m: StaffMember, sector: Sector, today: string, docs = documentViews(m, sector, today)): HrAction[] {
  const status = staffStatus(m, today);
  const out: HrAction[] = [];
  if (status === "left") {
    const open = leavingChecklist().filter((i) => !m.checklist[i.key]);
    if (open.length) out.push({ id: `${m.id}:leaving`, staffId: m.id, staffName: m.name, severity: "low", kind: "checklist", title: "Finish the leaving checklist", detail: `${open.length} step${open.length === 1 ? "" : "s"} left, starting with: ${open[0]!.label.toLowerCase()}.` });
    return out;
  }
  for (const d of docs) {
    const a = docAction(m, d, status, today);
    if (a) out.push(a);
  }
  for (const l of m.leave) {
    if (l.status === "requested") out.push({ id: `${m.id}:leave:${l.id}`, staffId: m.id, staffName: m.name, severity: "medium", kind: "approve_leave", ref: l.id, title: `${l.kind === "holiday" ? "Holiday" : "Leave"} request: ${l.days} day${l.days === 1 ? "" : "s"}`, detail: `${humanDate(l.from)} to ${humanDate(l.to)}. Approve or decline.`, dueOn: l.from });
  }
  const reviews = [...m.reviews];
  if (m.probationEndsOn && !reviews.some((r) => r.kind === "probation")) reviews.push({ id: "probation", kind: "probation", dueOn: m.probationEndsOn });
  for (const r of reviews) {
    if (r.doneOn) continue;
    const inDays = daysBetween(today, r.dueOn);
    if (inDays > 14) continue;
    const name = r.kind === "probation" ? "Probation review" : r.kind === "annual" ? "Yearly review" : "One-to-one";
    out.push({ id: `${m.id}:review:${r.id}`, staffId: m.id, staffName: m.name, severity: inDays < 0 ? "high" : "medium", kind: "review", ref: r.id, title: inDays < 0 ? `${name} overdue` : `${name} due in ${inDays} day${inDays === 1 ? "" : "s"}`, detail: r.kind === "probation" ? "Confirm they passed, extend, or end the probation in writing." : "Hold it and note the outcome.", dueOn: r.dueOn });
  }
  if (status === "leaving" && m.endDate) {
    const open = leavingChecklist().filter((i) => !m.checklist[i.key]);
    if (open.length) out.push({ id: `${m.id}:leaving`, staffId: m.id, staffName: m.name, severity: daysBetween(today, m.endDate) <= 14 ? "medium" : "low", kind: "checklist", title: `Leaving on ${humanDate(m.endDate)}`, detail: `${open.length} leaving step${open.length === 1 ? "" : "s"} to do.`, dueOn: m.endDate });
  }
  return sortActions(out);
}

export function sortActions(xs: readonly HrAction[]): HrAction[] {
  return [...xs].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") || a.staffName.localeCompare(b.staffName));
}

// ---- the desk as a whole ----

export interface StaffRow {
  id: string;
  name: string;
  jobTitle: string;
  contract: ContractType;
  startDate: string;
  endDate?: string;
  status: StaffStatus;
  complete: number;
  openActions: number;
  worst?: Severity;
  next?: string;
}

export interface HrSummary {
  headcount: number;
  starting: number;
  offToday: number;
  leaving: number;
  /** Across everyone not yet left. */
  recordsComplete: number;
  expiringSoon: number;
  expired: number;
  actions: HrAction[];
  bySeverity: Record<Severity, number>;
  rows: StaffRow[];
}

export function hrSummary(staff: readonly StaffMember[], sector: Sector, today: string): HrSummary {
  let required = 0, done = 0, expiringSoon = 0, expired = 0;
  const actions: HrAction[] = [];
  const rows: StaffRow[] = [];
  const counts = { starting: 0, offToday: 0, leaving: 0 };
  for (const m of staff) {
    const status = staffStatus(m, today);
    const docs = documentViews(m, sector, today);
    const mine = staffActions(m, sector, today, docs);
    actions.push(...mine);
    rows.push({ id: m.id, name: m.name, jobTitle: m.jobTitle, contract: m.contract, startDate: m.startDate, endDate: m.endDate, status, complete: completeness(docs), openActions: mine.length, worst: mine[0]?.severity, next: mine[0]?.title });
    if (status === "left") continue;
    if (status === "starting") counts.starting++;
    if (status === "on_leave") counts.offToday++;
    if (status === "leaving") counts.leaving++;
    required += docs.length;
    done += docs.filter((d) => d.state === "ok" || d.state === "expiring").length;
    expiringSoon += docs.filter((d) => d.state === "expiring").length;
    expired += docs.filter((d) => d.state === "expired").length;
  }
  const sorted = sortActions(actions);
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of sorted) bySeverity[a.severity]++;
  const current = rows.filter((r) => r.status !== "left").length;
  rows.sort((a, b) => (a.status === "left" ? 1 : 0) - (b.status === "left" ? 1 : 0) || SEVERITY_ORDER[a.worst ?? "low"] - SEVERITY_ORDER[b.worst ?? "low"] - (a.worst ? 0 : -0.5) + (b.worst ? 0 : -0.5) || a.name.localeCompare(b.name));
  return { headcount: current, ...counts, recordsComplete: required ? Math.round((done / required) * 100) : 100, expiringSoon, expired, actions: sorted, bySeverity, rows };
}

/** Who is off on a given day (approved holiday, sickness or other leave). */
export function offOn(staff: readonly StaffMember[], day: string): { staffId: string; name: string; kind: LeaveKind; to: string }[] {
  return staff.flatMap((m) => m.leave.filter((l) => l.status === "approved" && l.from <= day && l.to >= day).map((l) => ({ staffId: m.id, name: m.name, kind: l.kind, to: l.to })));
}

/** A ready-to-send message asking the person for a document, for the owner to paste into email or chat. */
export function requestMessage(m: StaffMember, req: Requirement, businessName: string): string {
  const first = m.name.split(/\s+/)[0] ?? m.name;
  const when = req.due === "before_start" ? "before your first day" : req.due === "day_one" ? "on your first day" : "within your first month";
  return `Hi ${first}, to keep your staff record at ${businessName} complete, could you send me your ${req.label.toLowerCase()} ${when}? ${req.why} Thank you.`;
}

/** The date right-to-work evidence may be deleted: 2 years after employment ends. */
export function rtwRetainUntil(m: StaffMember): string | undefined {
  return m.endDate ? addDays(addMonths(m.endDate, 24), 0) : undefined;
}

// ---- one person's full record, as the desk shows it ----

export interface DeskSettings {
  sector: Sector;
  /** 1 = the leave year starts on 1 January. */
  leaveYearStartMonth: number;
}

export interface StaffDetail {
  member: StaffMember;
  status: StaffStatus;
  documents: DocView[];
  complete: number;
  actions: HrAction[];
  onboarding: (ChecklistItem & { doneOn?: string })[];
  leaving: (ChecklistItem & { doneOn?: string })[];
  leave: LeaveBalance;
  rtwRetainUntil?: string;
  rota?: { weekStart: string; shifts: { date: string; start: string; end: string; hours: number; role?: string }[]; hours: number; cap: number };
}

export function staffDetail(m: StaffMember, s: DeskSettings, today: string): StaffDetail {
  const docs = documentViews(m, s.sector, today);
  const tick = (i: ChecklistItem) => ({ ...i, ...(m.checklist[i.key] ? { doneOn: m.checklist[i.key] } : {}) });
  const retain = rtwRetainUntil(m);
  return {
    member: m,
    status: staffStatus(m, today),
    documents: docs,
    complete: completeness(docs),
    actions: staffActions(m, s.sector, today, docs),
    onboarding: onboardingChecklist(s.sector).map(tick),
    leaving: m.endDate ? leavingChecklist().map(tick) : [],
    leave: leaveBalance(m, today, s.leaveYearStartMonth),
    ...(retain ? { rtwRetainUntil: retain } : {}),
  };
}
