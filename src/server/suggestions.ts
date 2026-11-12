import type { Platform } from "./platform.js";

/** One thing the records say the owner should look at. Worded from templates: no model is used, so it costs no energy. */
export interface Suggestion {
  /** Stable for the same situation, so a dismissal in the browser keeps working. */
  id: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  /** Where to go, or a question to put to an employee. */
  action: { label: string; href: string } | { label: string; ask: { employee: string; text: string } };
}

const MAX_SHOWN = 5;
const LOW_ENERGY_PERCENT_LEFT = 20;
const TRIAL_WARNING_DAYS = 2;
const SHORT_RUNWAY_MONTHS = 3;
const RANK = { high: 0, medium: 1, low: 2 } as const;

/** Runs each rule on its own: a missing permission or empty books drops that rule, never the whole list. */
function attempt(out: Suggestion[], rule: () => Suggestion | Suggestion[] | undefined): void {
  try {
    const r = rule();
    if (r) out.push(...(Array.isArray(r) ? r : [r]));
  } catch { /* this rule does not apply to this client */ }
}

export function suggestionsFor(p: Platform, userId: string, ws: string): Suggestion[] {
  const out: Suggestion[] = [];
  const nowDate = p.now();
  const today = nowDate.toISOString().slice(0, 10);

  attempt(out, () => {
    const week = p.rota.week(userId, ws, today);
    if (week.staff.length === 0 || week.openShifts === 0) return undefined;
    const n = week.openShifts;
    return { id: `rota-open-${week.weekStart}-${n}`, severity: "high", title: `${n} shift${n === 1 ? " has" : "s have"} nobody on them this week`, detail: "Fill them before the day, or ask for a suggested cover.", action: { label: "Ask for cover ideas", ask: { employee: "hr", text: `Who could cover the ${n} open shift${n === 1 ? "" : "s"} on the rota this week?` } } };
  });

  attempt(out, () => p.people.overview(userId, ws).summary.actions
    .filter((a) => a.severity === "critical" || a.severity === "high")
    .slice(0, 2)
    .map((a): Suggestion => ({ id: `hr-${a.staffName}-${a.title}`.slice(0, 120), severity: "high", title: `${a.staffName}: ${a.title}`, detail: a.detail, action: { label: "Open HR desk", href: "#people" } })));

  attempt(out, () => {
    const waiting = p.reviews.forClient(userId, ws).filter((r) => r.status === "gathering_info" || r.status === "more_info_requested");
    if (!waiting.length) return undefined;
    return { id: `review-answers-${waiting.map((r) => r.id).join(",")}`.slice(0, 120), severity: "high", title: waiting.length === 1 ? "A task is waiting for your answers" : `${waiting.length} tasks are waiting for your answers`, detail: "Quality review cannot start until you answer.", action: { label: "Answer now", href: "#work" } };
  });

  attempt(out, () => {
    const r = p.ledger.runway(userId, ws, today);
    if (r.runwayMonths === null || r.runwayMonths >= SHORT_RUNWAY_MONTHS) return undefined;
    return { id: "cash-short-runway", severity: "high", title: `Cash lasts about ${r.runwayMonths} months at this rate`, detail: "Ask your Finance manager where the money is going.", action: { label: "Ask Finance", ask: { employee: "finance", text: "Where can we cut spending to extend our runway?" } } };
  });

  attempt(out, () => {
    const ends = p.energy.planOf(ws).expiresAt;
    if (!ends) return undefined;
    const days = Math.ceil((new Date(ends).getTime() - nowDate.getTime()) / 86_400_000);
    if (days > TRIAL_WARNING_DAYS || days < 0) return undefined;
    return { id: "trial-ending", severity: "medium", title: days === 0 ? "Your free trial ends today" : `Your free trial ends in ${days} day${days === 1 ? "" : "s"}`, detail: "Choose a plan to keep your team working.", action: { label: "See plans", href: "#store" } };
  });

  attempt(out, () => {
    const t = p.energy.teamEnergy(userId, ws);
    if (!t || t.pool <= 0 || 100 - t.percentUsed > LOW_ENERGY_PERCENT_LEFT) return undefined;
    return { id: `energy-low-${t.refillsAt ?? "trial"}`, severity: "medium", title: `Your team has ${100 - t.percentUsed}% of its energy left`, detail: t.refillsAt ? "It refills on its own, or you can add a top-up." : "Ask for lighter jobs, or add a top-up.", action: { label: "Energy and spend", href: "#usage" } };
  });

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, MAX_SHOWN);
}
