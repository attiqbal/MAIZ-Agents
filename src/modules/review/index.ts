import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";
import { PermissionError } from "../identity/index.js";
import { CLIENT_STATUS_LABEL, answerBrief, missingInfo, planEnergy, requestMoreInfo, reviewStatus, signOff, type ReviewStatus, type TaskProposal } from "../workforce/signoff.js";

export type { ReviewStatus };

/**
 * MAIZ quality review: the sign-off gate for specialised tasks, enforced on the server.
 *
 * Roles are separate on purpose:
 * - The client (a business that hires MAIZ employees) asks for the work and answers the
 *   specialist's questions. A client can never approve, pick a direction or see review notes.
 * - The specialist compiles the brief and the directions it could take.
 * - The platform owner (MAIZ, identified by PLATFORM_OWNER_EMAILS) reviews every client's tasks in
 *   one queue and approves a direction or asks for more information. Work starts, and the result
 *   goes to the client, only after that approval.
 */
export type ReviewActor =
  | { kind: "client"; userId: string }
  | { kind: "specialist"; employeeId: string }
  | { kind: "platform_owner"; userId: string };

export interface ReviewEvent {
  at: string;
  by: ReviewActor["kind"];
  action: "submitted" | "answered" | "entered_review" | "info_requested" | "approved";
  /** What was answered or asked, in plain words. */
  detail?: string;
}

export interface ReviewItem {
  id: string;
  workspaceId: string;
  employeeId?: string;
  /** Who compiled the brief. A client's own submission is marked so the reviewer does not take it for a specialist's work. */
  source: "specialist" | "client";
  proposal: TaskProposal;
  status: ReviewStatus;
  submittedAt: string;
  updatedAt: string;
  /** When it last joined the review queue. The queue is sorted oldest first by this. */
  queuedAt?: string;
  /** The platform owner's notes for the specialist. Never shown to the client. */
  reviewNotes: { at: string; note: string }[];
  /** Shown to the client once the task is approved. */
  noteToClient?: string;
  approvedBy?: string;
  history: ReviewEvent[];
}

/** What the client sees: status, the brief and its own questions, and the outcome after approval. */
export interface ClientReviewView {
  id: string;
  title: string;
  employee: string;
  status: ReviewStatus;
  statusLabel: string;
  days: number;
  energy: number;
  design: string;
  brief: TaskProposal["brief"];
  /** Only after approval. */
  chosenDirection?: { name: string; summary: string };
  noteToClient?: string;
  submittedAt: string;
  updatedAt: string;
}

/** One row of the platform owner's queue, across every client. */
export interface OwnerReviewView extends Omit<ReviewItem, "proposal"> {
  clientName: string;
  proposal: TaskProposal;
  missing: string[];
  energy: number;
  /** Hours since it joined the queue (or since it was submitted, while still gathering information). */
  ageHours: number;
}

export class ReviewError extends Error {}

/** Called whenever a task joins the review queue, so the platform owner hears about it. */
export type ReviewNotifier = (item: ReviewItem, clientName: string) => Promise<void>;
/** Called after approval, so the client is told through the Admin manager. */
export type ClientNotifier = (item: ReviewItem) => Promise<void>;

export { CLIENT_STATUS_LABEL } from "../workforce/signoff.js";

/** Tasks a client may have open (not yet approved) at once, so the queue cannot be flooded. */
export const MAX_OPEN_PER_CLIENT = 20;
const LIMITS = { title: 200, label: 300, value: 2000, design: 2000, brief: 40, directions: 6, plan: 30, maxEnergy: 100_000, maxDays: 90 };
const DIRECTION_KEY = /^[a-z0-9-]{1,40}$/;

export const statusOf = reviewStatus;

export class QualityReviewService {
  private items = new Map<string, ReviewItem>();
  private sink?: Sink;

  constructor(
    private identity: IdentityService,
    private audit: AuditLog,
    private isPlatformOwner: (userId: string) => boolean,
    private opts: { now?: () => Date; notifyOwner?: ReviewNotifier; notifyClient?: ClientNotifier } = {},
  ) {}

  useSink(sink: Sink): void {
    this.sink = sink;
  }

  restore(item: ReviewItem): void {
    this.items.set(item.id, { ...item, source: item.source ?? "client" });
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /**
   * A specialist (or, until the agent run loop compiles briefs itself, the client's own request)
   * submits a compiled brief. Whatever the input says, it arrives unapproved.
   */
  async submit(actor: ReviewActor, workspaceId: string, input: unknown): Promise<ReviewItem> {
    if (actor.kind === "client") this.identity.require(actor.userId, workspaceId, "task.create");
    if (actor.kind === "platform_owner") throw new ReviewError("quality review does not submit tasks");
    const { proposal } = parseProposal(input);
    const open = this.inWorkspace(workspaceId).filter((i) => i.status !== "approved").length;
    if (open >= MAX_OPEN_PER_CLIENT) throw new ReviewError(`you already have ${MAX_OPEN_PER_CLIENT} specialised tasks waiting; finish some first`);
    const at = this.now().toISOString();
    const item: ReviewItem = {
      id: newId("review"),
      workspaceId,
      // Only the specialist itself is trusted to name the employee; a client's own submission names none.
      ...(actor.kind === "specialist" ? { employeeId: actor.employeeId } : {}),
      source: actor.kind === "specialist" ? "specialist" : "client",
      proposal,
      status: "gathering_info",
      submittedAt: at,
      updatedAt: at,
      reviewNotes: [],
      history: [{ at, by: actor.kind, action: "submitted" }],
    };
    this.record(actor, item, "review.submitted", { title: proposal.title });
    return this.save(actor, item, undefined);
  }

  /** The client's list: only its own workspace, with review notes and unchosen directions left out. */
  forClient(userId: string, workspaceId: string): ClientReviewView[] {
    this.identity.require(userId, workspaceId, "task.read");
    return this.inWorkspace(workspaceId).map(clientView);
  }

  /**
   * The client (or the specialist) answers one open item of the brief. A client can only fill a gap:
   * an answer already given cannot be changed by the client, so the reviewer never approves a brief
   * that changed under them. Never possible after approval.
   */
  async answer(actor: ReviewActor, workspaceId: string, id: string, label: string, value: string): Promise<ReviewItem> {
    if (actor.kind === "client") this.identity.require(actor.userId, workspaceId, "task.create");
    if (actor.kind === "platform_owner") throw new ReviewError("quality review asks; the client or specialist answers");
    const item = this.get(id);
    if (item.workspaceId !== workspaceId) throw new ReviewError("task not found");
    if (item.status === "approved") throw new ReviewError("this task is already approved");
    const text = clean(value, LIMITS.value, "answer");
    const target = item.proposal.brief.find((b) => b.label === label);
    if (!target) throw new ReviewError("that question is not in the brief");
    if (actor.kind === "client" && target.value?.trim()) throw new ReviewError("that question is already answered");
    const at = this.now().toISOString();
    const next: ReviewItem = { ...item, proposal: answerBrief(item.proposal, label, text), updatedAt: at, history: [...item.history, { at, by: actor.kind, action: "answered", detail: label }] };
    this.record(actor, next, "review.answered", { question: label });
    return this.save(actor, next, item.status);
  }

  /** The platform owner's queue across every client. Waiting for review first, oldest first. */
  queue(userId: string): OwnerReviewView[] {
    this.requireOwner(userId);
    const order: Record<ReviewStatus, number> = { in_review: 0, more_info_requested: 1, gathering_info: 2, approved: 3 };
    const nowMs = this.now().getTime();
    return [...this.items.values()]
      .map((i) => this.ownerView(i, nowMs))
      .sort((a, b) => order[a.status] - order[b.status] || (a.queuedAt ?? a.submittedAt).localeCompare(b.queuedAt ?? b.submittedAt));
  }

  /** The platform owner approves, picking a direction when the specialist offered several. */
  async approve(userId: string, id: string, input: { direction?: string; noteToClient?: string; note?: string; seenVersion?: string }): Promise<ReviewItem> {
    this.requireOwner(userId);
    const item = this.get(id);
    // The page sends the version it showed; a brief that changed since then must be read again first.
    if (input.seenVersion && input.seenVersion !== item.updatedAt) throw new ReviewError("this task changed since you opened it; reload and check it again");
    if (item.status !== "in_review") throw new ReviewError(item.status === "approved" ? "this task is already approved" : "this task is still waiting for information");
    const at = this.now();
    const r = signOff(item.proposal, at, input.direction);
    if (!r.ok) throw new ReviewError(r.missing.length ? `${r.reason} ${r.missing.join(", ")}` : r.reason);
    const noteToClient = input.noteToClient ? clean(input.noteToClient, LIMITS.value, "note to the client") : undefined;
    const note = input.note ? clean(input.note, LIMITS.value, "note") : undefined;
    const iso = at.toISOString();
    const next: ReviewItem = {
      ...item,
      proposal: r.proposal,
      updatedAt: iso,
      approvedBy: userId,
      ...(noteToClient ? { noteToClient } : {}),
      reviewNotes: note ? [...item.reviewNotes, { at: iso, note }] : item.reviewNotes,
      history: [...item.history, { at: iso, by: "platform_owner", action: "approved", ...(r.proposal.chosenDirection ? { detail: r.proposal.chosenDirection } : {}) }],
    };
    const actor: ReviewActor = { kind: "platform_owner", userId };
    this.record(actor, next, "review.approved", { direction: r.proposal.chosenDirection ?? null });
    const saved = this.save(actor, next, item.status);
    await this.opts.notifyClient?.(saved).catch((e) => console.error("client notification failed:", e));
    return saved;
  }

  /** The platform owner sends the brief back with a question. The task cannot be approved until it is answered. */
  async requestInfo(userId: string, id: string, input: { question?: string; note?: string }): Promise<ReviewItem> {
    this.requireOwner(userId);
    const item = this.get(id);
    if (item.status === "approved") throw new ReviewError("this task is already approved");
    const question = clean(input.question ?? "", LIMITS.label, "question");
    if (item.proposal.brief.some((b) => b.label === question)) throw new ReviewError("that question is already in the brief");
    const note = input.note ? clean(input.note, LIMITS.value, "note") : undefined;
    const at = this.now().toISOString();
    const next: ReviewItem = {
      ...item,
      proposal: requestMoreInfo(item.proposal, question),
      updatedAt: at,
      reviewNotes: note ? [...item.reviewNotes, { at, note }] : item.reviewNotes,
      history: [...item.history, { at, by: "platform_owner", action: "info_requested", detail: question }],
    };
    const actor: ReviewActor = { kind: "platform_owner", userId };
    this.record(actor, next, "review.info_requested", { question });
    return this.save(actor, next, item.status);
  }

  /** Work may start only on an approved task. The agent run loop must call this before doing anything. */
  mayStart(id: string): boolean {
    return this.items.get(id)?.status === "approved";
  }

  // ---------- internals ----------

  private requireOwner(userId: string): void {
    if (!this.isPlatformOwner(userId)) throw new PermissionError("only the platform owner reviews specialised tasks");
  }

  private get(id: string): ReviewItem {
    const item = this.items.get(id);
    if (!item) throw new ReviewError("task not found");
    return item;
  }

  private inWorkspace(workspaceId: string): ReviewItem[] {
    return [...this.items.values()].filter((i) => i.workspaceId === workspaceId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Works out the new status, stores the item and tells the platform owner when it joins the queue. */
  private save(actor: ReviewActor, draft: ReviewItem, before: ReviewStatus | undefined): ReviewItem {
    const status = statusOf(draft.proposal);
    const joined = status === "in_review" && before !== "in_review";
    const item: ReviewItem = {
      ...draft,
      status,
      ...(joined ? { queuedAt: draft.updatedAt, history: [...draft.history, { at: draft.updatedAt, by: actor.kind, action: "entered_review" as const }] } : {}),
    };
    this.items.set(item.id, item);
    this.sink?.review(item);
    if (joined) {
      this.record(actor, item, "review.entered_queue", {});
      const clientName = this.identity.workspaceById(item.workspaceId)?.name ?? "a client";
      void this.opts.notifyOwner?.(item, clientName).catch((e) => console.error("review notification failed:", e));
    }
    return item;
  }

  private record(actor: ReviewActor, item: ReviewItem, action: string, data: Record<string, unknown>): void {
    const who = actor.kind === "specialist" ? `employee:${actor.employeeId}` : actor.kind === "platform_owner" ? `platform-owner:${actor.userId}` : `user:${actor.userId}`;
    this.audit.record({ workspaceId: item.workspaceId, actor: who, action, target: `review:${item.id}`, data });
  }

  private ownerView(i: ReviewItem, nowMs: number): OwnerReviewView {
    const since = Date.parse(i.queuedAt ?? i.submittedAt);
    return {
      ...i,
      clientName: this.identity.workspaceById(i.workspaceId)?.name ?? "Unknown client",
      missing: missingInfo(i.proposal).map((m) => m.label),
      energy: planEnergy(i.proposal),
      ageHours: Math.max(0, Math.floor((nowMs - since) / 3_600_000)),
    };
  }
}

function clientView(i: ReviewItem): ClientReviewView {
  const p = i.proposal;
  const chosen = i.status === "approved" ? p.directions?.find((d) => d.key === p.chosenDirection) : undefined;
  return {
    id: i.id,
    title: p.title,
    employee: p.employee,
    status: i.status,
    statusLabel: CLIENT_STATUS_LABEL[i.status],
    days: p.days,
    energy: planEnergy(p),
    design: p.design,
    brief: p.brief.map((b) => ({ ...b })),
    ...(chosen ? { chosenDirection: { name: chosen.name, summary: chosen.summary } } : {}),
    ...(i.status === "approved" && i.noteToClient ? { noteToClient: i.noteToClient } : {}),
    submittedAt: i.submittedAt,
    updatedAt: i.updatedAt,
  };
}

function clean(v: unknown, max: number, what: string): string {
  // Control characters (newlines included) are flattened to spaces: these strings go into email subjects and one-line labels.
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
  if (!s) throw new ReviewError(`${what} is required`);
  if (s.length > max) throw new ReviewError(`${what} is too long`);
  return s;
}
const optionalText = (v: unknown, max: number, what: string): string | undefined => (v === undefined || v === null || v === "" ? undefined : clean(v, max, what));

function list(v: unknown, max: number, what: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw new ReviewError(`${what} must be a list of up to ${max}`);
  return v;
}
const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ReviewError(`${what} is not valid`);
  return v as Record<string, unknown>;
};
function whole(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new ReviewError(`${what} must be a whole number from ${min} to ${max}`);
  return v;
}

/** Builds a proposal from untrusted input. Sign-off fields are never taken from the input. */
export function parseProposal(input: unknown): { proposal: TaskProposal } {
  const b = obj(input, "task");
  const brief = list(b.brief, LIMITS.brief, "brief").map((x) => {
    const item = obj(x, "brief item");
    const value = optionalText(item.value, LIMITS.value, "answer");
    return { label: clean(item.label, LIMITS.label, "question"), ...(value ? { value } : {}), ...(item.optional === true ? { optional: true } : {}), from: "client" as const };
  });
  if (new Set(brief.map((x) => x.label)).size !== brief.length) throw new ReviewError("each question in the brief must be different");
  const directions = list(b.directions, LIMITS.directions, "directions").map((x) => {
    const d = obj(x, "direction");
    const key = typeof d.key === "string" ? d.key : "";
    if (!DIRECTION_KEY.test(key)) throw new ReviewError("a direction key must be lower-case letters, numbers or dashes");
    return { key, name: clean(d.name, LIMITS.title, "direction name"), summary: clean(d.summary, LIMITS.value, "direction summary"), ...(d.recommended === true ? { recommended: true } : {}) };
  });
  if (new Set(directions.map((d) => d.key)).size !== directions.length) throw new ReviewError("each direction needs its own key");
  const plan = list(b.plan, LIMITS.plan, "plan").map((x) => {
    const s = obj(x, "plan step");
    return { title: clean(s.title, LIMITS.title, "step"), energy: whole(s.energy, 0, LIMITS.maxEnergy, "step energy") };
  });
  const proposal: TaskProposal = {
    title: clean(b.title, LIMITS.title, "title"),
    employee: clean(b.employee, LIMITS.title, "employee"),
    brief,
    design: typeof b.design === "string" ? b.design.trim().slice(0, LIMITS.design) : "",
    ...(directions.length ? { directions } : {}),
    plan,
    days: whole(b.days, 1, LIMITS.maxDays, "days"),
  };
  return { proposal };
}
