/**
 * Sign-off gate for specialised tasks (consultant work and anything from a task menu).
 * Nothing specialised starts on its own: the employee collects all the information it needs,
 * compiles it into one brief with the directions it could take, and brings it to the owner.
 * The owner either asks for more information (the brief goes back to the employee) or signs
 * off on one direction. Sign-off is refused while information is missing or no direction is chosen.
 *
 * Pure data and functions, no server imports: the website imports this file too.
 */
export interface BriefItem {
  /** What the employee needs to know, in the owner's words. */
  label: string;
  /** The answer, once the owner (or a connected app) has given it. Empty means missing. */
  value?: string;
  /** Optional items never block sign-off. */
  optional?: boolean;
  /** Who has to supply it. "employee" marks a question the owner sent back for more information. */
  from?: "owner" | "employee";
}

/** One way the work could go. The owner picks one at sign-off. */
export interface Direction {
  key: string;
  name: string;
  /** What the owner gets if they pick this, in a sentence. */
  summary: string;
  /** The employee's recommendation, with its reason in the summary. */
  recommended?: boolean;
}

export interface PlanStep {
  title: string;
  energy: number;
}

export interface TaskProposal {
  title: string;
  /** Who will do the work. */
  employee: string;
  brief: readonly BriefItem[];
  /** The approach in one or two plain sentences. */
  design: string;
  /** The directions the employee compiled. Empty when there is only one sensible way to do the job. */
  directions?: readonly Direction[];
  /** The direction the owner signed off on. */
  chosenDirection?: string;
  plan: readonly PlanStep[];
  /** Working days from sign-off to delivery. */
  days: number;
  signedOffAt?: string;
}

export type ProposalStage = "needs_info" | "ready_for_sign_off" | "signed_off";

const answered = (item: BriefItem): boolean => Boolean(item.value?.trim());

/** Required brief items that still have no answer. */
export function missingInfo(p: TaskProposal): BriefItem[] {
  return p.brief.filter((item) => !item.optional && !answered(item));
}

/** Total energy the plan will use, shown to the owner before sign-off. */
export function planEnergy(p: TaskProposal): number {
  return p.plan.reduce((sum, step) => sum + step.energy, 0);
}

export function proposalStage(p: TaskProposal): ProposalStage {
  if (p.signedOffAt) return "signed_off";
  return missingInfo(p).length === 0 && p.design.trim() !== "" && p.plan.length > 0 ? "ready_for_sign_off" : "needs_info";
}

export type SignOffResult = { ok: true; proposal: TaskProposal } | { ok: false; reason: string; missing: string[] };

/** The owner's sign-off. Returns a new proposal; refuses while information, design or plan is missing. */
export function signOff(p: TaskProposal, at: Date, directionKey?: string): SignOffResult {
  if (p.signedOffAt) return { ok: false, reason: "This task is already signed off.", missing: [] };
  const directions = p.directions ?? [];
  if (directions.length && !directions.some((d) => d.key === directionKey)) return { ok: false, reason: "Choose which direction to take first.", missing: [] };
  const missing = missingInfo(p).map((item) => item.label);
  if (missing.length) return { ok: false, reason: "Some information is still missing.", missing };
  if (!p.design.trim() || p.plan.length === 0) return { ok: false, reason: "The design and plan are not ready yet.", missing: [] };
  return { ok: true, proposal: { ...p, signedOffAt: at.toISOString(), ...(directions.length ? { chosenDirection: directionKey } : {}) } };
}

/** Work may only start once the owner has signed off. */
export const mayStart = (p: TaskProposal): boolean => proposalStage(p) === "signed_off";

/** Fills in one brief item, returning a new proposal. */
export function answerBrief(p: TaskProposal, label: string, value: string): TaskProposal {
  return { ...p, brief: p.brief.map((item) => (item.label === label ? { ...item, value } : item)) };
}

/**
 * The owner asks for more information instead of signing off. The question joins the brief as
 * something the employee must find out, so the task cannot be signed off until it is answered.
 */
export function requestMoreInfo(p: TaskProposal, question: string): TaskProposal {
  const label = question.trim();
  if (!label || p.signedOffAt || p.brief.some((item) => item.label === label)) return p;
  return { ...p, brief: [...p.brief, { label, from: "employee" }] };
}
