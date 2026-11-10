/**
 * Consultants: one-off help for work that is not part of the permanent team.
 *
 * Instead of a separate hire for every small job, similar jobs are grouped by the
 * skills they need into five consultants. You hire a consultant for a time-boxed
 * pass (7 or 30 days) with a pool of energy. During the pass you, or the Admin
 * manager, give it tasks from its menu (task-roles.ts) until the days or the
 * energy run out. Then it leaves the team; you can extend with another pass.
 *
 * Prices are draft list prices in GBP for the owner of MAIZ agents to confirm.
 * Pure data, no server imports: the website imports this file too.
 */
import type { JobDescription } from "./job-descriptions.js";
import { OVERAGE_RULE, TASK_ROLES, type TaskRole } from "./task-roles.js";

export interface Pass {
  /** "sprint" or "month". */
  key: "sprint" | "month";
  label: string;
  days: number;
  gbp: number;
  /** Energy pool for the whole pass. 1 energy = $0.001 of model cost. */
  energy: number;
}

export interface Consultant {
  key: string;
  title: string;
  /** Who it is for and what it is good at, in one sentence. */
  purpose: string;
  tier: "standard" | "premium";
  passes: readonly [Pass, Pass];
}

const pass = (key: Pass["key"], days: number, gbp: number, energy: number): Pass => ({
  key,
  label: key === "sprint" ? `${days}-day sprint` : `${days}-day pass`,
  days,
  gbp,
  energy,
});

export const CONSULTANTS: readonly Consultant[] = [
  {
    key: "web-developer", title: "Web and automation developer", tier: "premium",
    purpose: "Builds and fixes websites and landing pages, automates repeated work between your tools, and cleans up messy data.",
    passes: [pass("sprint", 7, 99, 3000), pass("month", 30, 349, 12000)],
  },
  {
    key: "content-creator", title: "Brand and content creator", tier: "standard",
    purpose: "Creates your brand kit and writes the blogs, product copy, scripts and emails that go with it.",
    passes: [pass("sprint", 7, 79, 2500), pass("month", 30, 249, 9000)],
  },
  {
    key: "growth-consultant", title: "Growth marketing consultant", tier: "standard",
    purpose: "Finds customers: SEO audits, ad campaigns, social launches and market research.",
    passes: [pass("sprint", 7, 89, 2500), pass("month", 30, 279, 9000)],
  },
  {
    key: "finance-funding-consultant", title: "Finance and funding consultant", tier: "premium",
    purpose: "Gets the money side ready: financial models, bookkeeping catch-up, business plans, pitch decks, grants and tenders.",
    passes: [pass("sprint", 7, 129, 4000), pass("month", 30, 399, 14000)],
  },
  {
    key: "people-ops-consultant", title: "People, policy and operations consultant", tier: "standard",
    purpose: "Sets up how the business runs: staff handbook, website legal pages, recruitment, procedures and events.",
    passes: [pass("sprint", 7, 79, 2500), pass("month", 30, 249, 8000)],
  },
];

export function getConsultant(key: string): Consultant | undefined {
  return CONSULTANTS.find((c) => c.key === key);
}

/** The jobs a consultant can be asked to do. */
export function menuOf(consultantKey: string): TaskRole[] {
  return TASK_ROLES.filter((t) => t.consultant === consultantKey);
}

export function getPass(consultantKey: string, passKey: string): Pass | undefined {
  return getConsultant(consultantKey)?.passes.find((p) => p.key === passKey);
}

/** How a pass works. Shown in the store, in the job description and to the employee. */
export const HOW_A_PASS_WORKS = [
  "You, or your Admin manager, give the consultant a brief. The consultant gathers everything it needs, compiles it into one summary with the directions it could take, and brings it to you with a plan that fits the days and the energy.",
  "Nothing starts until you sign off. You either choose a direction and sign off, or ask for more information, and the consultant comes back with it. Sign-off stays locked while anything is missing.",
  "You can also ask the consultant directly. The Admin manager stays informed and keeps the plan up to date.",
  "The consultant stops at each approval point for your OK. Nothing is published, sent or paid for without you.",
  "The Admin manager tracks days and energy and tells you at 80%. Work that will not fit is moved, trimmed or quoted as an extension.",
  "At the end the consultant hands over every file, document and record, then leaves the team. Unused energy does not carry over. To keep going, add another pass: it starts when this one ends.",
] as const;

const dedupe = (xs: readonly string[]): string[] => [...new Set(xs)];

/** A full job description for a consultant, merged from the tasks on its menu. */
export function consultantJobDescription(key: string): JobDescription | undefined {
  const c = getConsultant(key);
  if (!c) return undefined;
  const menu = menuOf(key);
  return {
    key: c.key,
    jobTitle: c.title,
    department: "Consultant · one-off pass",
    reportsTo: "Owner",
    worksWith: ["Admin manager (plans the tasks, tracks days and energy, collects approvals)", "Any team member whose work a task feeds or depends on"],
    purpose: `${c.purpose} Hired for a time-boxed pass, not as a permanent team member.`,
    responsibilities: [
      { area: "Task menu: what you can ask for", duties: menu.map((t) => `${t.title}: ${t.purpose}`) },
      { area: "Working a pass", duties: ["Work to the plan the Admin manager agrees with the owner, and fit it to the days and energy of the pass", "Say before starting if a task will not fit, and offer a smaller version", "Stop at every approval point and wait for the owner"] },
      { area: "Documentation and legal records", duties: ["Keep every record listed below complete and hand them over at the end of the pass", "Know the legal requirements of each task and say when a rule must be confirmed for the owner's country"] },
    ],
    legal: dedupe(menu.flatMap((t) => t.legal)),
    records: dedupe(menu.flatMap((t) => t.records)),
    competencies: dedupe(menu.flatMap((t) => t.skills)).map((skill) => ({ skill, level: "Advanced" as const, detail: "Applied to the owner's brief and checked at each approval point." })),
    knowledge: [`Good practice for ${c.title.toLowerCase()} work`, "The owner's brief and business profile"],
    tools: [{ name: "Business profile and setup answers", status: "available" }],
    deliverables: menu.map((t) => ({ name: `${t.title}: ${t.deliverables.join(", ")}`, cadence: t.turnaround, energy: [Math.round(t.includedEnergy / 2), t.includedEnergy] as const })),
    kpis: ["Tasks delivered inside the pass's days and energy", "Approved at each approval point without major rework", "Every required record handed over before the pass ends"],
    authority: {
      autonomous: ["Work through the agreed plan as drafts", "Keep the records for each task"],
      needsApproval: [...dedupe(menu.flatMap((t) => t.approvalPoints)), "Any work outside the menu or the agreed plan", "Using energy beyond the pass"],
      never: ["Go beyond the pass's energy without the owner's approval", "Publish, submit, send or pay for anything", "Give legal, tax or financial advice", "Invent facts, figures or rules"],
    },
    escalate: ["Anything with legal, tax, safety or financial risk: tell the owner and recommend a qualified professional"],
    handover: ["A brief of what you want, in order of importance", "Examples you like", "Access or files the tasks need", ...dedupe(menu.flatMap((t) => t.notIncluded)).map((n) => `Not included: ${n}`)],
    engagement: {
      passes: c.passes.map((p) => ({ label: p.label, days: p.days, gbp: p.gbp, energy: p.energy })),
      menu: menu.map((t) => ({ task: t.title, summary: t.purpose, energy: t.includedEnergy, turnaround: t.turnaround, deliverables: t.deliverables, notIncluded: t.notIncluded })),
      howItWorks: HOW_A_PASS_WORKS,
      approvalPoints: dedupe(menu.flatMap((t) => t.approvalPoints)),
      overageRule: OVERAGE_RULE,
    },
  };
}
