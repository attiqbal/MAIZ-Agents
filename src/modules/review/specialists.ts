import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";
import { PermissionError } from "../identity/index.js";
import { draftCustomRole, type RoleBrief } from "../workforce/custom-roles.js";
import type { RoleBlueprint } from "../workforce/blueprints.js";
import type { JobDescription } from "../workforce/job-descriptions.js";
import { ReviewError } from "./index.js";

/**
 * New custom specialists, reviewed by the MAIZ platform owner before anyone is trained.
 * A custom specialist is a new product: the Admin manager drafts the role and job description
 * from the client's brief, the platform owner checks it (and may set the price), and only then
 * can the client hire it. The client never approves its own new specialist.
 */
export type SpecialistStatus = "in_review" | "changes_requested" | "approved" | "declined";

export interface SpecialistRequest {
  id: string;
  workspaceId: string;
  brief: RoleBrief;
  role: RoleBlueprint;
  jobDescription: JobDescription;
  notes: string[];
  similar: string[];
  /** Monthly price quoted to the client. The platform owner may change it at approval. */
  priceGbp: number;
  status: SpecialistStatus;
  submittedAt: string;
  updatedAt: string;
  /** The platform owner's message to the client (what to change, or why it was declined). */
  messageToClient?: string;
  decidedBy?: string;
  history: { at: string; by: "client" | "platform_owner"; action: SpecialistStatus | "submitted"; detail?: string }[];
}

export interface ClientSpecialistView {
  id: string;
  title: string;
  status: SpecialistStatus;
  statusLabel: string;
  priceGbp: number;
  messageToClient?: string;
  submittedAt: string;
}

export const SPECIALIST_STATUS_LABEL: Record<SpecialistStatus, string> = {
  in_review: "With MAIZ for review",
  changes_requested: "MAIZ asked for changes",
  approved: "Approved by MAIZ, ready to hire",
  declined: "Not offered",
};

export const MAX_OPEN_SPECIALIST_REQUESTS = 10;
const MAX_MESSAGE = 1000;

export class SpecialistReviewService {
  private items = new Map<string, SpecialistRequest>();
  private sink?: Sink;

  constructor(
    private identity: IdentityService,
    private audit: AuditLog,
    private isPlatformOwner: (userId: string) => boolean,
    private priceFor: (tier: "standard" | "premium") => number,
    private opts: { now?: () => Date; notifyOwner?: (r: SpecialistRequest, clientName: string) => Promise<void>; notifyClient?: (r: SpecialistRequest) => Promise<void> } = {},
  ) {}

  useSink(sink: Sink): void {
    this.sink = sink;
  }

  restore(r: SpecialistRequest): void {
    this.items.set(r.id, r);
  }

  private now(): string {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }

  /** The client (through the Admin manager's role designer) asks for a new specialist. */
  async request(userId: string, workspaceId: string, input: unknown): Promise<SpecialistRequest> {
    this.identity.require(userId, workspaceId, "employee.hire");
    const brief = parseBrief(input);
    const draft = draftCustomRole(brief);
    if (!draft.ok) throw new ReviewError(draft.problems.join(" "));
    const open = [...this.items.values()].filter((r) => r.workspaceId === workspaceId && (r.status === "in_review" || r.status === "changes_requested")).length;
    if (open >= MAX_OPEN_SPECIALIST_REQUESTS) throw new ReviewError(`you already have ${MAX_OPEN_SPECIALIST_REQUESTS} specialists waiting for review`);
    const at = this.now();
    const r: SpecialistRequest = {
      id: newId("specialist"),
      workspaceId,
      brief,
      role: draft.role,
      jobDescription: draft.jobDescription,
      notes: draft.notes,
      similar: draft.similar,
      priceGbp: this.priceFor(draft.role.tier === "premium" ? "premium" : "standard"),
      status: "in_review",
      submittedAt: at,
      updatedAt: at,
      history: [{ at, by: "client", action: "submitted" }],
    };
    this.save(r);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "specialist.requested", target: `specialist:${r.id}`, data: { title: r.role.title } });
    const clientName = this.identity.workspaceById(workspaceId)?.name ?? "a client";
    void this.opts.notifyOwner?.(r, clientName).catch((e) => console.error("specialist notification failed:", e));
    return r;
  }

  forClient(userId: string, workspaceId: string): ClientSpecialistView[] {
    this.identity.require(userId, workspaceId, "task.read");
    return [...this.items.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((r) => ({ id: r.id, title: r.role.title, status: r.status, statusLabel: SPECIALIST_STATUS_LABEL[r.status], priceGbp: r.priceGbp, ...(r.messageToClient ? { messageToClient: r.messageToClient } : {}), submittedAt: r.submittedAt }));
  }

  /** Every client's requests for the platform owner, waiting ones first. */
  queue(userId: string): (SpecialistRequest & { clientName: string })[] {
    this.requireOwner(userId);
    const order: Record<SpecialistStatus, number> = { in_review: 0, changes_requested: 1, approved: 2, declined: 3 };
    return [...this.items.values()]
      .map((r) => ({ ...r, clientName: this.identity.workspaceById(r.workspaceId)?.name ?? "Unknown client" }))
      .sort((a, b) => order[a.status] - order[b.status] || a.submittedAt.localeCompare(b.submittedAt));
  }

  /** The platform owner approves (optionally at a different price), asks for changes, or declines. */
  async decide(userId: string, id: string, input: { decision?: unknown; message?: unknown; priceGbp?: unknown }): Promise<SpecialistRequest> {
    this.requireOwner(userId);
    const r = this.items.get(id);
    if (!r) throw new ReviewError("request not found");
    if (r.status !== "in_review") throw new ReviewError("this request is not waiting for review");
    const decision = input.decision;
    if (decision !== "approved" && decision !== "changes_requested" && decision !== "declined") throw new ReviewError("choose approve, ask for changes or decline");
    const message = typeof input.message === "string" ? input.message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_MESSAGE) : "";
    if (decision !== "approved" && !message) throw new ReviewError("tell the client what to change, or why");
    let priceGbp = r.priceGbp;
    if (input.priceGbp !== undefined && input.priceGbp !== null && input.priceGbp !== "") {
      if (typeof input.priceGbp !== "number" || !Number.isFinite(input.priceGbp) || input.priceGbp < 0 || input.priceGbp > 100_000) throw new ReviewError("price must be a number of pounds");
      priceGbp = Math.round(input.priceGbp * 100) / 100;
    }
    const at = this.now();
    const next: SpecialistRequest = {
      ...r,
      status: decision,
      priceGbp,
      updatedAt: at,
      decidedBy: userId,
      ...(message ? { messageToClient: message } : {}),
      history: [...r.history, { at, by: "platform_owner", action: decision, ...(message ? { detail: message } : {}) }],
    };
    this.save(next);
    this.audit.record({ workspaceId: r.workspaceId, actor: `platform-owner:${userId}`, action: `specialist.${decision}`, target: `specialist:${r.id}`, data: { priceGbp } });
    await this.opts.notifyClient?.(next).catch((e) => console.error("client notification failed:", e));
    return next;
  }

  /** A specialist may be trained (and hired) only after the platform owner approved it. */
  mayTrain(id: string): boolean {
    return this.items.get(id)?.status === "approved";
  }

  private save(r: SpecialistRequest): void {
    this.items.set(r.id, r);
    this.sink?.specialistRequest(r);
  }

  private requireOwner(userId: string): void {
    if (!this.isPlatformOwner(userId)) throw new PermissionError("only the platform owner reviews new specialists");
  }
}

function parseBrief(input: unknown): RoleBrief {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ReviewError("brief is not valid");
  const b = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 20).map(str) : []);
  return { title: str(b.title).slice(0, 200), purpose: str(b.purpose).slice(0, 1000), duties: list(b.duties).map((d) => d.slice(0, 1000)) };
}
