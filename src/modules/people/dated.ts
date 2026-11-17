// Everything in one person's staff record that has a real date on it: a document or permission that runs out, a
// review that is due, a skill or certificate with an end date, a last day. Used by the client's Compliance calendar.
// Only dates somebody recorded (or that follow from a recorded check and its renewal period) are listed.
import { documentViews, staffStatus, type StaffMember } from "./rules.js";
import type { Sector } from "./requirements.js";

export interface StaffDated {
  /** Stable while the record stands: "staff:<id>:doc:<key>" and so on. */
  id: string;
  staffName: string;
  title: string;
  date: string;
  /** True when the law requires the document to be in date. */
  legal: boolean;
}

const REVIEW_NAME = { probation: "Probation review", annual: "Yearly review", one_to_one: "One-to-one" } as const;

export function staffDates(m: StaffMember, sector: Sector, today: string): StaffDated[] {
  if (staffStatus(m, today) === "left") return [];
  const base = { staffName: m.name };
  const out: StaffDated[] = [];
  for (const d of documentViews(m, sector, today)) {
    if (!d.expiresOn) continue;
    out.push({ ...base, id: `staff:${m.id}:doc:${d.key}`, title: `${d.label} ${d.expiresOn < today ? "ran out" : "runs out"}`, date: d.expiresOn, legal: d.level === "legal" });
  }
  for (const r of m.reviews) {
    if (!r.doneOn) out.push({ ...base, id: `staff:${m.id}:review:${r.id}`, title: `${REVIEW_NAME[r.kind]} due`, date: r.dueOn, legal: false });
  }
  if (m.probationEndsOn && !m.reviews.some((r) => r.kind === "probation")) {
    out.push({ ...base, id: `staff:${m.id}:review:probation`, title: "Probation review due", date: m.probationEndsOn, legal: false });
  }
  for (const sk of m.profile?.skills ?? []) {
    if (sk.expiresOn) out.push({ ...base, id: `staff:${m.id}:skill:${sk.name}`, title: `${sk.name} ${sk.expiresOn < today ? "ran out" : "runs out"}`, date: sk.expiresOn, legal: false });
  }
  if (m.endDate) out.push({ ...base, id: `staff:${m.id}:leaving`, title: "Last day at work", date: m.endDate, legal: false });
  return out;
}

export interface LeaveWaiting { staffId: string; staffName: string; leaveId: string; kind: "holiday" | "sick" | "other"; from: string; to: string; days: number }

/** Leave somebody asked for that nobody has approved or declined yet. */
export function leaveWaiting(staff: readonly StaffMember[], today: string): LeaveWaiting[] {
  return staff
    .filter((m) => staffStatus(m, today) !== "left")
    .flatMap((m) => m.leave.filter((l) => l.status === "requested").map((l) => ({ staffId: m.id, staffName: m.name, leaveId: l.id, kind: l.kind, from: l.from, to: l.to, days: l.days })));
}
