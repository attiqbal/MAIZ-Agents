// Example staff for the HR desk demo (Kestrel Coffee, a coffee shop and roastery). Dates are relative to
// today, so the demo always shows something expiring, someone starting and someone leaving.
import { addDays, addMonths, requiredDocuments, toIsoDate, type DeskSettings, type StaffDocument, type StaffMember, type StaffProfile } from "../../src/modules/people/browser";

export const EXAMPLE_SETTINGS: DeskSettings = { sector: "hospitality", leaveYearStartMonth: 1 };

const today = toIsoDate(new Date());
const d = (days: number) => addDays(today, days);
const checked = (on: string, extra: Partial<StaffDocument> = {}): StaffDocument => ({ status: "checked", checkedOn: on, checkedBy: "you", updatedAt: on, ...extra });

/** What most of the example staff told the business on their form. */
const told = (p: Partial<StaffProfile>): StaffProfile => ({ updatedOn: d(-20), updatedBy: "staff", emergencyName: "Alex Morgan", emergencyRelation: "Partner", emergencyPhone: "07700 900000", ...p });

let n = 0;
function person(p: Partial<StaffMember> & Pick<StaffMember, "name" | "jobTitle" | "startDate">, docs: "all" | "none" = "all", overrides: Record<string, StaffDocument | undefined> = {}): StaffMember {
  const base: StaffMember = {
    id: `eg-${++n}`, workspaceId: "example", contract: "full_time", hoursPerWeek: 40, daysPerWeek: 5, pension: "enrolled", rtwRoute: "british_irish",
    documents: {}, checklist: {}, leave: [], reviews: [], createdAt: p.startDate, updatedAt: p.startDate, ...p,
  };
  const all: Record<string, StaffDocument> = docs === "all"
    ? Object.fromEntries(requiredDocuments(base, EXAMPLE_SETTINGS.sector, today).map((r) => [r.key, checked(base.startDate > d(-60) ? base.startDate : d(-60))]))
    : {};
  for (const [k, v] of Object.entries(overrides)) { if (v) all[k] = v; else delete all[k]; }
  const onboarded = docs === "all" ? Object.fromEntries(["on_offer", "on_rtw", "on_payroll", "on_pension", "on_rota", "on_access", "on_induction", "on_buddy", "on_probation", "on_food"].map((k) => [k, base.startDate])) : {};
  return { ...base, documents: all, checklist: { ...onboarded, ...base.checklist } };
}

export function exampleStaff(): StaffMember[] {
  n = 0;
  return [
    person({ name: "Priya Shah", jobTitle: "Head barista", startDate: d(-700), rtwRoute: "share_code", rtwExpiresOn: d(21), payPence: 1350, payBasis: "hour", payrollId: "KC014", manager: "You", email: "priya@example.com", profile: told({ hoursMin: 35, hoursMax: 40, prefers: ["early"], skills: [{ name: "Latte art trainer" }], sectorAnswers: { allergen_trained: true, can_open_close: true } }), reviews: [{ id: "r1", kind: "annual", dueOn: d(10) }] }, "all", { right_to_work: checked(d(-700), { expiresOn: d(21) }) }),
    person({ name: "Tom Reed", jobTitle: "Barista", startDate: d(-120), contract: "part_time", hoursPerWeek: 24, daysPerWeek: 3, pension: "to_assess", payPence: 1221, payBasis: "hour",
      profile: told({ hoursMin: 16, hoursMax: 24, availability: [{ day: 0, off: true }, { day: 1, off: true }, { day: 2, from: "07:00", to: "15:00" }], avoids: ["night"], holidayNotes: "Exams in May and June", transport: "public", constraints: "Studying on Monday and Tuesday" }),
      leave: [{ id: "l1", kind: "holiday", from: d(30), to: d(32), days: 3, status: "requested", note: "Family wedding" }] }, "all", { pension_assessment: undefined, food_hygiene: { status: "received", updatedAt: d(-2), note: "Photo sent by email" } }),
    person({ name: "Aisha Bello", jobTitle: "Shift supervisor and first aider", startDate: d(-400), payPence: 1290, payBasis: "hour", profile: told({ prefers: ["late", "weekend"], skills: [{ name: "Allergen awareness", expiresOn: d(40) }] }),
      leave: [{ id: "l2", kind: "holiday", from: d(-1), to: d(2), days: 4, status: "approved" }, { id: "l3", kind: "sick", from: d(-50), to: d(-49), days: 2, status: "approved" }] }, "all", { first_aid: checked(addMonths(d(-5), -36)) }),
    person({ name: "Leo Martins", jobTitle: "Kitchen assistant", startDate: d(5), contract: "zero_hours", hoursPerWeek: 16, daysPerWeek: 2, pension: "to_assess", rtwRoute: "unknown", payPence: 1221, payBasis: "hour" }, "none", { written_statement: { status: "requested", updatedAt: d(-1) }, emergency_contact: checked(d(-1)) }),
    person({ name: "Hannah Cole", jobTitle: "Weekend barista", startDate: d(-60), contract: "part_time", hoursPerWeek: 12, daysPerWeek: 2, dateOfBirth: addMonths(today, -12 * 17 - 3), probationEndsOn: d(12), payPence: 1000, payBasis: "hour", profile: told({ hoursMax: 12, availability: [0, 1, 2, 3, 4].map((day) => ({ day, off: true })), constraints: "At school Monday to Friday" }) }, "all", { young_worker_risk: undefined }),
    person({ name: "Sam Okafor", jobTitle: "Delivery driver", startDate: d(-300), contract: "part_time", hoursPerWeek: 15, daysPerWeek: 3, payPence: 1250, payBasis: "hour", profile: told({ transport: "car", maxShiftHours: 6 }) }, "all", { driving_licence_check: checked(d(-200)) }),
    person({ name: "Grace Lin", jobTitle: "Roaster", startDate: d(-900), payPence: 3100000, payBasis: "year", payrollId: "KC003", profile: told({ prefers: ["early", "day"], skills: [{ name: "Roaster safety", expiresOn: addMonths(today, 14) }] }) }),
    person({ name: "Daniel Price", jobTitle: "Barista", startDate: d(-500), endDate: d(9), contract: "part_time", hoursPerWeek: 20, daysPerWeek: 3, payPence: 1221, payBasis: "hour", checklist: { off_confirm: d(-12), off_holiday: d(-10) }, profile: told({}) }),
  ];
}
