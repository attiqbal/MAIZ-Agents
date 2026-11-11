// The staff details form, shared by the HR desk ("About them" tab, filled in by the owner) and the
// staff form page (filled in by the person from their own link). One renderer and one reader, so both
// send exactly what the server's readProfile() expects.
import {
  SHIFT_TIMES, SHIFT_TIME_LABEL, TRANSPORTS, TRANSPORT_LABEL, WEEKDAYS,
  type DayAvailability, type SectorQuestion, type ShiftTime, type StaffProfile,
} from "../../src/modules/people/browser";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const MAX_SKILLS = 30;
const BLANK_SKILL_ROWS = 2;

export interface FieldOptions {
  /** Their own wording ("you") on the staff page, the owner's ("they") on the desk. */
  self: boolean;
  /** Phone and email, shown on the staff page so they can correct them. */
  contact?: { phone?: string; email?: string };
  /** Shows the "ask for time off" block (staff page only; the desk has its own leave form). */
  timeOff?: boolean;
}

const input = (name: string, label: string, value: string | number | undefined, extra = "") =>
  `<div class="field"><label for="sf-${name}">${esc(label)}</label><input class="input" id="sf-${name}" name="${name}" value="${esc(String(value ?? ""))}" ${extra}></div>`;
const area = (name: string, label: string, value: string | undefined, hint: string) =>
  `<div class="field sf-wide"><label for="sf-${name}">${esc(label)}</label><textarea class="input" id="sf-${name}" name="${name}" rows="2" maxlength="1000" aria-describedby="sf-${name}-h">${esc(value ?? "")}</textarea><span class="hint" id="sf-${name}-h">${esc(hint)}</span></div>`;

function dayRow(day: number, p: StaffProfile): string {
  const a = p.availability?.find((x) => x.day === day);
  const mode = a?.off ? "off" : a?.from ? "between" : "any";
  const name = WEEKDAYS[day]!;
  const opt = (v: string, l: string) => `<option value="${v}"${v === mode ? " selected" : ""}>${l}</option>`;
  const dis = mode === "between" ? "" : " disabled hidden";
  return `<div class="sf-day" role="group" aria-label="${name}">
    <span class="sf-dayname">${name}</span>
    <select class="input" name="av-${day}" aria-label="${name}: when">${opt("any", "Any time")}${opt("between", "Only between")}${opt("off", "Not available")}</select>
    <input class="input" type="time" name="av-${day}-from" aria-label="${name}: from" value="${esc(a?.from ?? "09:00")}"${dis}>
    <input class="input" type="time" name="av-${day}-to" aria-label="${name}: to" value="${esc(a?.to ?? "17:00")}"${dis}>
  </div>`;
}

function shiftBoxes(name: "prefers" | "avoids", chosen: ShiftTime[] | undefined): string {
  return SHIFT_TIMES.map((s) => `<label class="sf-check"><input type="checkbox" name="${name}" value="${s}"${chosen?.includes(s) ? " checked" : ""}> ${esc(SHIFT_TIME_LABEL[s])}</label>`).join("");
}

export const skillRow = (name = "", expiresOn = "") =>
  `<div class="sf-skill"><input class="input" name="skill-name" aria-label="Skill or certificate" placeholder="For example: Food hygiene level 2" maxlength="80" value="${esc(name)}"><label class="sf-exp"><span class="hint">Expires</span><input class="input" type="date" name="skill-exp" aria-label="Expiry date" value="${esc(expiresOn)}"></label></div>`;

function question(q: SectorQuestion, answer: string | boolean | undefined): string {
  const id = `sf-q-${q.key}`;
  if (q.kind === "text") return `<div class="field"><label for="${id}">${esc(q.label)}</label><input class="input" id="${id}" name="q-${esc(q.key)}" maxlength="200" value="${esc(typeof answer === "string" ? answer : "")}"></div>`;
  const opt = (v: string, l: string) => `<option value="${v}"${(answer === true && v === "yes") || (answer === false && v === "no") || (answer === undefined && v === "") ? " selected" : ""}>${l}</option>`;
  return `<div class="field"><label for="${id}">${esc(q.label)}</label><select class="input" id="${id}" name="q-${esc(q.key)}">${opt("", "Not answered")}${opt("yes", "Yes")}${opt("no", "No")}</select></div>`;
}

/** The form's fields (no <form> element and no submit button: the page adds those). */
export function profileFieldsHtml(p: StaffProfile, questions: SectorQuestion[], o: FieldOptions): string {
  const you = o.self ? "you" : "they";
  const skills = p.skills ?? [];
  return `
  <fieldset class="sf-set"><legend>${o.self ? "About you" : "Name and contact"}</legend>
    <div class="sf-grid">
      ${input("preferredName", `Name ${you} like to be called`, p.preferredName, 'maxlength="120" autocomplete="nickname"')}
      ${o.contact ? input("phone", "Mobile number", o.contact.phone, 'type="tel" maxlength="40" autocomplete="tel"') + input("email", "Email", o.contact.email, 'type="email" maxlength="200" autocomplete="email"') : ""}
    </div>
  </fieldset>
  <fieldset class="sf-set"><legend>Emergency contact</legend>
    <p class="hint">Who we call if something happens at work.</p>
    <div class="sf-grid">
      ${input("emergencyName", "Name", p.emergencyName, 'maxlength="120"')}
      ${input("emergencyRelation", "Relationship", p.emergencyRelation, 'maxlength="60" placeholder="For example: partner, parent"')}
      ${input("emergencyPhone", "Phone", p.emergencyPhone, 'type="tel" maxlength="40"')}
    </div>
  </fieldset>
  <fieldset class="sf-set"><legend>Hours and when ${you} can work</legend>
    <div class="sf-grid">
      ${input("hoursMin", "Fewest hours a week", p.hoursMin, 'type="number" min="0" max="80" step="0.5" inputmode="decimal"')}
      ${input("hoursMax", "Most hours a week", p.hoursMax, 'type="number" min="0" max="80" step="0.5" inputmode="decimal"')}
      ${input("maxShiftHours", "Longest shift (hours)", p.maxShiftHours, 'type="number" min="0" max="16" step="0.5" inputmode="decimal"')}
    </div>
    <p class="hint">Each day: any time, only between two times, or not available. The rota will not give ${o.self ? "you" : "them"} shifts outside this.</p>
    <div class="sf-days">${WEEKDAYS.map((_, d) => dayRow(d, p)).join("")}</div>
    <div class="sf-two">
      <div><p class="label">Shifts ${you} like</p><div class="sf-checks">${shiftBoxes("prefers", p.prefers)}</div></div>
      <div><p class="label">Shifts ${you} would rather not do</p><div class="sf-checks">${shiftBoxes("avoids", p.avoids)}</div></div>
    </div>
  </fieldset>
  <fieldset class="sf-set"><legend>Holidays and time off</legend>
    ${area("holidayNotes", `Times of year ${you} need off or cannot work`, p.holidayNotes, "For example: school holidays, exams, religious festivals.")}
    ${o.timeOff ? `<div class="sf-grid" role="group" aria-label="Ask for time off">
      ${input("off-from", "Ask for time off from", "", 'type="date"')}
      ${input("off-to", "Until", "", 'type="date"')}
      ${input("off-days", "Working days that covers", "", 'type="number" min="0.5" max="260" step="0.5" inputmode="decimal"')}
      ${input("off-note", "Note (optional)", "", 'maxlength="200"')}
    </div><p class="hint">Your manager approves or declines it. Leave these empty if you don't need time off now.</p>` : ""}
  </fieldset>
  <fieldset class="sf-set"><legend>Skills and certificates</legend>
    <p class="hint">Just the name and the expiry date. Don't upload or send copies here.</p>
    <div class="sf-skills" id="sf-skills">${[...skills.map((s) => skillRow(s.name, s.expiresOn ?? "")), ...Array.from({ length: BLANK_SKILL_ROWS }, () => skillRow())].join("")}</div>
    <button type="button" class="btn btn-ghost btn-sm" id="sf-skill-add">Add another</button>
  </fieldset>
  <fieldset class="sf-set"><legend>Getting to work${questions.length ? " and the job" : ""}</legend>
    <div class="sf-grid">
      <div class="field"><label for="sf-transport">How ${you} get to work</label><select class="input" id="sf-transport" name="transport"><option value="">Not answered</option>${TRANSPORTS.map((t) => `<option value="${t}"${p.transport === t ? " selected" : ""}>${esc(TRANSPORT_LABEL[t])}</option>`).join("")}</select></div>
      ${questions.map((q) => question(q, p.sectorAnswers?.[q.key])).join("")}
    </div>
    ${area("constraints", `Anything else that affects when or how ${you} can work`, p.constraints, `For example: caring for someone, study, the last bus home. ${o.self ? "You" : "They"} don't need to give medical details.`)}
  </fieldset>`;
}

const val = (f: HTMLFormElement, name: string): string => ((f.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "").trim();
const numOrEmpty = (s: string): number | "" => (s === "" ? "" : Number(s));

export interface FormAnswers {
  profile: Record<string, unknown>;
  phone?: string;
  email?: string;
  timeOff?: { from: string; to: string; days: number; note?: string };
}

/** Reads every field, so a field left empty clears the old answer. */
export function readProfileFields(f: HTMLFormElement, questions: SectorQuestion[]): FormAnswers {
  const checks = (name: string) => [...f.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((x) => x.value);
  const availability = WEEKDAYS.flatMap((_, d): DayAvailability[] => {
    const mode = val(f, `av-${d}`);
    if (mode === "off") return [{ day: d, off: true }];
    if (mode === "between") return [{ day: d, from: val(f, `av-${d}-from`), to: val(f, `av-${d}-to`) }];
    return [];
  });
  const names = [...f.querySelectorAll<HTMLInputElement>('input[name="skill-name"]')];
  const exps = [...f.querySelectorAll<HTMLInputElement>('input[name="skill-exp"]')];
  const skills = names.map((n, i) => ({ name: n.value.trim(), expiresOn: exps[i]?.value ?? "" })).filter((s) => s.name);
  const sectorAnswers: Record<string, string | boolean> = {};
  for (const q of questions) {
    const v = val(f, `q-${q.key}`);
    if (!v) continue;
    sectorAnswers[q.key] = q.kind === "yesno" ? v === "yes" : v;
  }
  const out: FormAnswers = {
    profile: {
      preferredName: val(f, "preferredName"), emergencyName: val(f, "emergencyName"), emergencyRelation: val(f, "emergencyRelation"), emergencyPhone: val(f, "emergencyPhone"),
      hoursMin: numOrEmpty(val(f, "hoursMin")), hoursMax: numOrEmpty(val(f, "hoursMax")), maxShiftHours: numOrEmpty(val(f, "maxShiftHours")),
      availability, prefers: checks("prefers"), avoids: checks("avoids"), holidayNotes: val(f, "holidayNotes"),
      skills, transport: val(f, "transport"), constraints: val(f, "constraints"), sectorAnswers,
    },
  };
  if (f.elements.namedItem("phone")) out.phone = val(f, "phone");
  if (f.elements.namedItem("email")) out.email = val(f, "email");
  const from = val(f, "off-from");
  if (from) {
    const note = val(f, "off-note");
    out.timeOff = { from, to: val(f, "off-to") || from, days: Number(val(f, "off-days")), ...(note ? { note } : {}) };
  }
  return out;
}

/** Turns the time fields on only for "Only between", and adds skill rows. Call once per rendered form. */
export function wireProfileFields(root: HTMLElement): void {
  root.addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    const m = /^av-(\d)$/.exec(sel.name ?? "");
    if (!m) return;
    for (const end of ["from", "to"]) {
      const t = root.querySelector<HTMLInputElement>(`input[name="av-${m[1]}-${end}"]`);
      if (t) { t.disabled = sel.value !== "between"; t.hidden = t.disabled; }
    }
  });
  root.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id !== "sf-skill-add") return;
    const box = root.querySelector<HTMLElement>("#sf-skills");
    if (!box || box.children.length >= MAX_SKILLS) return;
    box.insertAdjacentHTML("beforeend", skillRow());
    box.querySelector<HTMLInputElement>(".sf-skill:last-child input")?.focus();
  });
}
