/**
 * Sign-off gate for specialised tasks (consultant work and anything from a task menu).
 * Nothing specialised starts on its own: the specialist collects all the information it needs
 * (from the client and their connected apps), compiles it into one brief with the directions it
 * could take, and sends it to MAIZ quality review. The platform owner (MAIZ, not the client)
 * checks the brief against what the client asked for and either asks for more information (the
 * brief goes back to the specialist) or signs off on one direction. Only then does work start and
 * the result go to the client. Sign-off is refused while information is missing or no direction
 * is chosen. Who may sign off is enforced on the server (src/modules/review).
 *
 * Pure data and functions, no server imports: the website imports this file too.
 */
export interface BriefItem {
  /** What the specialist needs to know, in the client's words. */
  label: string;
  /** The answer, once the client (or a connected app, or the specialist) has given it. Empty means missing. */
  value?: string;
  /** Optional items never block sign-off. */
  optional?: boolean;
  /** Who has to supply it. "specialist" marks a question quality review sent back for more information. */
  from?: "client" | "specialist";
}

/** One way the work could go. Quality review picks one at sign-off. */
export interface Direction {
  key: string;
  name: string;
  /** What the client gets if this is picked, in a sentence. */
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
  /** The direction quality review signed off on. */
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

/** Total energy the plan will use, shown at review and to the client. */
export function planEnergy(p: TaskProposal): number {
  return p.plan.reduce((sum, step) => sum + step.energy, 0);
}

export function proposalStage(p: TaskProposal): ProposalStage {
  if (p.signedOffAt) return "signed_off";
  return missingInfo(p).length === 0 && p.design.trim() !== "" && p.plan.length > 0 ? "ready_for_sign_off" : "needs_info";
}

export type SignOffResult = { ok: true; proposal: TaskProposal } | { ok: false; reason: string; missing: string[] };

/** Quality review's sign-off. Returns a new proposal; refuses while information, design or plan is missing. */
export function signOff(p: TaskProposal, at: Date, directionKey?: string): SignOffResult {
  if (p.signedOffAt) return { ok: false, reason: "This task is already signed off.", missing: [] };
  const directions = p.directions ?? [];
  if (directions.length && !directions.some((d) => d.key === directionKey)) return { ok: false, reason: "Choose which direction to take first.", missing: [] };
  const missing = missingInfo(p).map((item) => item.label);
  if (missing.length) return { ok: false, reason: "Some information is still missing.", missing };
  if (!p.design.trim() || p.plan.length === 0) return { ok: false, reason: "The design and plan are not ready yet.", missing: [] };
  return { ok: true, proposal: { ...p, signedOffAt: at.toISOString(), ...(directions.length ? { chosenDirection: directionKey } : {}) } };
}

/** Work may only start once quality review has signed off. */
export const mayStart = (p: TaskProposal): boolean => proposalStage(p) === "signed_off";

/** Fills in one brief item, returning a new proposal. */
export function answerBrief(p: TaskProposal, label: string, value: string): TaskProposal {
  return { ...p, brief: p.brief.map((item) => (item.label === label ? { ...item, value } : item)) };
}

/**
 * Quality review asks for more information instead of signing off. The question joins the brief as
 * something the specialist must find out, so the task cannot be signed off until it is answered.
 */
export function requestMoreInfo(p: TaskProposal, question: string): TaskProposal {
  const label = question.trim();
  if (!label || p.signedOffAt || p.brief.some((item) => item.label === label)) return p;
  return { ...p, brief: [...p.brief, { label, from: "specialist" }] };
}

/** Where a specialised task is in MAIZ quality review. */
export type ReviewStatus = "gathering_info" | "in_review" | "more_info_requested" | "approved";

/**
 * gathering_info: the client still has to answer something. in_review: complete, waiting for the
 * platform owner. more_info_requested: the platform owner asked a question that is not answered yet.
 */
export function reviewStatus(p: TaskProposal): ReviewStatus {
  if (p.signedOffAt) return "approved";
  const missing = missingInfo(p);
  if (missing.some((m) => m.from === "specialist")) return "more_info_requested";
  if (missing.length || !p.design.trim() || p.plan.length === 0) return "gathering_info";
  return "in_review";
}

/** What the client is told at each stage. The client never signs off. */
export const CLIENT_STATUS_LABEL: Record<ReviewStatus, string> = {
  gathering_info: "Your specialist needs a few answers from you",
  in_review: "In quality review",
  more_info_requested: "In quality review: the specialist is finding out more",
  approved: "Approved, work has started",
};
