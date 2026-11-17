// The Compliance calendar: real dates only. Each one comes from a record the client (or their staff, plan or
// connections) really has, and says which. No statutory deadline is invented here: the product holds no researched
// country rules with real dates, so the client adds their own. Pure functions over plain data.
import { addDays, addMonths, daysBetween } from "../people/dates.js";
import { humanDate } from "../people/rules.js";

export const REPEATS = ["none", "monthly", "quarterly", "yearly"] as const;
export type Repeat = (typeof REPEATS)[number];
const REPEAT_MONTHS: Record<Repeat, number> = { none: 0, monthly: 1, quarterly: 3, yearly: 12 };
export const REPEAT_WORDS: Record<Repeat, string> = { none: "does not repeat", monthly: "repeats every month", quarterly: "repeats every 3 months", yearly: "repeats every year" };

/** How many days before a date the reminder may be sent. 0 means only on the day. */
export const REMIND_CHOICES = [0, 1, 3, 7, 14, 30] as const;
/** Anything due within this many days is marked as coming up soon. */
export const SOON_DAYS = 30;
/** Reminder keys kept per date, so the list cannot grow for ever on a monthly date. */
const REMINDED_KEPT = 12;
const MAX_STEPS = 2400;

/** A date the client added themselves. */
export interface OwnDate {
  id: string;
  workspaceId: string;
  title: string;
  /** The first (or only) time it falls, YYYY-MM-DD. A repeating date keeps this day of the month. */
  date: string;
  repeat: Repeat;
  note?: string;
  /** Template key of the employee who looks after it. */
  employee?: string;
  remindDays: number;
  /** Every occurrence up to and including this day has been ticked as done. */
  doneThrough?: string;
  /** Reminders already sent, as "<date>:before" or "<date>:day". */
  reminded: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** The first time a repeating date falls on or after `floor`, counted from its first day so the 31st stays the 31st. */
function occurrenceFrom(d: OwnDate, floor: string): string {
  const step = REPEAT_MONTHS[d.repeat];
  for (let k = 0; k < MAX_STEPS; k++) {
    const on = addMonths(d.date, k * step);
    if (on >= floor) return on;
  }
  return d.date;
}

/**
 * The occurrence the client should be looking at. A one-off stays on its date. A repeating date starts from the
 * day it was added (not from years ago) and stays on a missed occurrence until it is ticked, then moves on.
 */
export function currentOccurrence(d: OwnDate, _today?: string): { on: string; done: boolean } {
  if (d.repeat === "none") return { on: d.date, done: !!d.doneThrough && d.doneThrough >= d.date };
  const floor = d.doneThrough ? addDays(d.doneThrough, 1) : d.createdAt.slice(0, 10);
  return { on: occurrenceFrom(d, floor), done: false };
}

/** What `doneThrough` goes back to when the client unticks: the occurrence before, if there was one since it was added. */
export function undoneThrough(d: OwnDate): string | undefined {
  if (d.repeat === "none" || !d.doneThrough) return undefined;
  const added = d.createdAt.slice(0, 10);
  const first = occurrenceFrom(d, added);
  let before: string | undefined;
  for (let on = first, k = 0; on < d.doneThrough && k < MAX_STEPS; k++) {
    before = on;
    on = occurrenceFrom(d, addDays(on, 1));
  }
  return before;
}

export interface DueReminder { key: string; stage: "before" | "day"; on: string; daysLeft: number }

/** Reminders that should go out today and have not gone yet: one inside the lead time, one on the day. */
export function dueReminders(d: OwnDate, today: string): DueReminder[] {
  const { on, done } = currentOccurrence(d, today);
  if (done) return [];
  const daysLeft = daysBetween(today, on);
  if (daysLeft < 0) return [];
  const stage: DueReminder["stage"] | undefined = daysLeft === 0 ? "day" : d.remindDays > 0 && daysLeft <= d.remindDays ? "before" : undefined;
  if (!stage) return [];
  const key = `${on}:${stage}`;
  return d.reminded.includes(key) ? [] : [{ key, stage, on, daysLeft }];
}

export const rememberReminder = (reminded: readonly string[], key: string): string[] => [...reminded.filter((k) => k !== key), key].slice(-REMINDED_KEPT);

export type CalendarKind = "staff" | "plan" | "connection" | "yours";
export type CalendarState = "overdue" | "soon" | "later";

export interface CalendarItem {
  id: string;
  kind: CalendarKind;
  date: string;
  title: string;
  note?: string;
  /** Where the date comes from, in the words the menu uses. */
  source: string;
  /** Where to go to deal with it. */
  href: string;
  daysLeft: number;
  state: CalendarState;
  owner?: { key: string; title: string };
  /** Only on a date the client added: what the edit form needs. */
  own?: { id: string; firstDate: string; repeat: Repeat; remindDays: number };
}

export interface StaffDate { id: string; staffName: string; title: string; date: string; legal: boolean }

export interface CalendarSources {
  /** The client's own date today, YYYY-MM-DD. */
  today: string;
  /** Undefined when this person may not open staff records. */
  staff?: readonly StaffDate[];
  plan: { trialEndsOn?: string; planEndsOn?: string; renewals: readonly { orderId: string; on: string; what: string; monthlyMinor?: number }[] };
  toolKeys: readonly { id: string; name: string; expiresOn: string }[];
  socialSignIns: readonly { id: string; name: string; kind: string; expiresOn: string }[];
  appSignIns: readonly { id: string; app: string; expiresOn: string }[];
  own: readonly { date: OwnDate; employeeTitle?: string }[];
}

type Draft = Omit<CalendarItem, "daysLeft" | "state">;

const pounds = (minor: number): string => `£${(minor / 100).toFixed(2)}`;
const SOCIAL_NAME: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", whatsapp: "WhatsApp" };

function planDates(p: CalendarSources["plan"], today: string): Draft[] {
  const out: Draft[] = [];
  if (p.trialEndsOn) out.push({ id: "plan:trial", kind: "plan", date: p.trialEndsOn, title: p.trialEndsOn < today ? "Your free trial has ended" : "Your free trial ends", note: "Choose your plan before then to keep your team working. Your work is kept either way.", source: "Your plan", href: "#store" });
  if (p.planEndsOn) out.push({ id: "plan:ends", kind: "plan", date: p.planEndsOn, title: p.planEndsOn < today ? "Your Team package has ended" : "Your Team package ends", note: "It was cancelled, and your team works until this date. You can start it again from the store.", source: "Your plan", href: "#store" });
  for (const r of p.renewals) {
    out.push({
      id: `plan:renewal:${r.orderId}`, kind: "plan", date: r.on, title: `Monthly payment: ${r.what}`,
      note: r.monthlyMinor !== undefined ? `${pounds(r.monthlyMinor)} is taken by card on or near this date.` : "Taken by card on or near this date.", source: "Your plan", href: "#settings",
    });
  }
  return out;
}

function connectionDates(s: CalendarSources): Draft[] {
  return [
    ...s.appSignIns.map((a): Draft => ({ id: `connection:app:${a.id}`, kind: "connection", date: a.expiresOn, title: `Your ${a.app} sign-in ${a.expiresOn < s.today ? "has run out" : "runs out"}`, note: "Connect it again before then so its figures keep arriving.", source: "Apps and connections", href: "#apps" })),
    ...s.socialSignIns.map((c): Draft => ({ id: `connection:social:${c.id}`, kind: "connection", date: c.expiresOn, title: `Your ${SOCIAL_NAME[c.kind] ?? "social"} sign-in for ${c.name} needs renewing`, note: "Sign in again before then so posts keep going out.", source: "Social accounts", href: "/connect-social.html" })),
    ...s.toolKeys.map((k): Draft => ({ id: `connection:key:${k.id}`, kind: "connection", date: k.expiresOn, title: `The key for "${k.name}" ${k.expiresOn < s.today ? "has stopped working" : "stops working"}`, note: "Make a new key before then and put it in your tool.", source: "Your own AI tools", href: "#apps" })),
  ];
}

function ownDates(s: CalendarSources): Draft[] {
  return s.own.flatMap(({ date: d, employeeTitle }): Draft[] => {
    const { on, done } = currentOccurrence(d, s.today);
    if (done) return [];
    return [{
      id: `own:${d.id}`, kind: "yours", date: on, title: d.title, ...(d.note ? { note: d.note } : {}), source: "Added by you", href: "#compliance",
      ...(d.employee && employeeTitle ? { owner: { key: d.employee, title: employeeTitle } } : {}),
      own: { id: d.id, firstDate: d.date, repeat: d.repeat, remindDays: d.remindDays },
    }];
  });
}

/** Every real date, soonest first, with how far away it is. */
export function buildCalendar(s: CalendarSources): CalendarItem[] {
  const staff = (s.staff ?? []).map((x): Draft => ({ id: x.id, kind: "staff", date: x.date, title: `${x.staffName}: ${x.title}`, source: "Staff records", href: "#people" }));
  return [...staff, ...planDates(s.plan, s.today), ...connectionDates(s), ...ownDates(s)]
    .map((d): CalendarItem => {
      const daysLeft = daysBetween(s.today, d.date);
      return { ...d, daysLeft, state: daysLeft < 0 ? "overdue" : daysLeft <= SOON_DAYS ? "soon" : "later" };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** One-off dates the client ticked, newest first, so a tick made by mistake can be undone. */
export function finishedOwn(own: readonly OwnDate[], today: string): { id: string; title: string; date: string }[] {
  return own.filter((d) => currentOccurrence(d, today).done).sort((a, b) => b.date.localeCompare(a.date)).map((d) => ({ id: d.id, title: d.title, date: d.date }));
}

/** "In 7 days: X", "Tomorrow: X" or "Today: X", with a body that says when and who knows. */
export function reminderText(d: OwnDate, r: DueReminder, employeeTitle: string | undefined): { title: string; body: string } {
  const lead = r.stage === "day" ? "Today" : r.daysLeft === 1 ? "Tomorrow" : `In ${r.daysLeft} days`;
  const when = r.stage === "day" ? "It is due today." : `It is due on ${humanDate(r.on)}.`;
  const who = employeeTitle ? ` Your ${employeeTitle} knows about it.` : "";
  return { title: `${lead}: ${d.title}`, body: `${when}${who} Open your calendar to see it or tick it off.` };
}
