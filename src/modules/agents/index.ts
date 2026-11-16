import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { EnergyMeter } from "../energy/index.js";
import type { IdentityService } from "../identity/index.js";
import type { WorkforceService } from "../workforce/index.js";
import { AgentBudget } from "./budget.js";
import { ConnectionBook, principalOf, type RosterEntry } from "./connections.js";
import { JobStore } from "./jobs.js";
import { fenceBrief, readJobInput } from "./keys.js";
import { PLAN_QUESTIONS, profileContext, proposePlan, type AgentProposal, type PlanQuestion } from "./planner.js";
import {
  AgentAuthError, AgentError, AgentRefusal, BRIEF_MAX_CHARS, DATA_MAX_BYTES, DEFAULT_LIMITS, KEY_EXPIRY_WARNING_DAYS, MAX_CONNECTIONS_PER_WORKSPACE,
  MAX_JOBS_LISTED, MAX_LIMITS, MAX_WAITING_JOBS, NEVER_ALLOWED, OWNER_RECENT_JOBS, READS_PER_MINUTE, STUCK_AFTER_MINUTES, WAITING_EXPIRES_DAYS, publicJob,
  type AgentConnection, type AgentEnergy, type AgentJob, type AgentJobReason, type AgentOverview, type AgentSelf, type ConnectionView, type OwnerJob, type PublicJob,
} from "./types.js";
import { connectionView, ownerJobView, rosterOf } from "./views.js";
import { WebhookQueue, type Delivery, type WebhookEvent } from "./webhooks.js";

export * from "./types.js";
export * from "./planner.js";
export { AGENT_SECRET_PREFIX, principalOf } from "./connections.js";
export { fenceBrief, hashKey } from "./keys.js";
export { GIVE_UP_AFTER_MS, RETRY_AFTER_MS, SIGNATURE_HEADER, WEBHOOK_TIMEOUT_MS, signWebhook, verifyWebhookSignature, type Delivery, type WebhookEvent } from "./webhooks.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const NOTE_MAX_CHARS = 300;

export interface AgentDeps {
  identity: Pick<IdentityService, "require" | "can" | "addMember">;
  audit: Pick<AuditLog, "record">;
  workforce: Pick<WorkforceService, "team" | "templateFor" | "assign">;
  energy: Pick<EnergyMeter, "teamEnergyOf" | "estimateFor" | "planOf">;
  /** Rings the client's bell (and their devices). Must not throw. */
  notify?: (workspaceId: string, notice: { title: string; body: string }) => void;
  /** The client's own time zone, so "today" for the daily ceiling is their day. UTC when not given. */
  timezone?: (workspaceId: string) => string | undefined;
  now?: () => Date;
  http?: typeof fetch;
}

/**
 * Outside agents. A client's own AI tool sends jobs to that client's MAIZ employees through the same door as the ask
 * bar (`workforce.assign`), as a member that is not a person, so energy, permissions and audit all apply. The owner
 * switches a connection on, chooses the employees and the limits, and can pause or remove it at any time.
 */
export class AgentService {
  private sink?: Sink;
  private readonly now: () => Date;
  private readonly book: ConnectionBook;
  private readonly jobs: JobStore;
  private readonly budget: AgentBudget;
  readonly webhooks: WebhookQueue;
  /** Jobs lined up to run. A connection's jobs run one at a time, in order, so a burst cannot overrun its ceiling. */
  private scheduled = new Map<string, Promise<AgentJob>>();
  private lines = new Map<string, Promise<unknown>>();
  private reads = new Map<string, { start: number; count: number }>();

  constructor(private readonly d: AgentDeps) {
    this.now = d.now ?? (() => new Date());
    const sink = (): Sink | undefined => this.sink;
    this.book = new ConnectionBook({ identity: d.identity, audit: d.audit, roster: (u, ws) => this.roster(u, ws), now: this.now, sink });
    this.jobs = new JobStore(sink);
    this.budget = new AgentBudget({ energy: d.energy, timezone: d.timezone, now: this.now }, this.jobs);
    this.webhooks = new WebhookQueue({
      now: this.now, http: d.http,
      target: (id) => {
        const c = this.book.get(id), secret = this.book.secretOf(id);
        return c?.webhookUrl && secret ? { url: c.webhookUrl, secret } : undefined;
      },
      payload: (x) => this.payloadFor(x),
      save: (x) => this.sink?.record(x.workspaceId, "agent_delivery", x.id, x),
      gaveUp: (x) => d.audit.record({ workspaceId: x.workspaceId, actor: principalOf(x.connectionId), action: "agent.callback_failed", target: x.jobId, data: { connection: this.book.get(x.connectionId)?.name, event: x.event, attempts: x.attempts, lastStatus: x.lastStatus ?? null } }),
    });
  }

  useSink(sink: Sink): void { this.sink = sink; }

  restore(kind: "agent_conn" | "agent_job" | "agent_delivery", data: unknown): void {
    if (kind === "agent_conn") this.book.restore(data as AgentConnection);
    else if (kind === "agent_job") this.jobs.restore(data as AgentJob);
    else this.webhooks.restore(data as Delivery);
  }

  restoreSecret(storeKey: string, secret: string): void { this.book.restoreSecret(storeKey, secret); }

  // ---- the owner's side ----

  /** Everything the Apps screen shows: connections, recent jobs (waiting ones first), the limits and who may be chosen. */
  overview(userId: string, workspaceId: string): AgentOverview {
    this.d.identity.require(userId, workspaceId, "task.read");
    const roster = this.roster(userId, workspaceId);
    const mine = this.book.list(workspaceId);
    const all = mine.flatMap((c) => this.jobs.of(c.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const waiting = all.filter((j) => j.status === "waiting_for_owner");
    const rest = all.filter((j) => j.status !== "waiting_for_owner").slice(0, OWNER_RECENT_JOBS);
    return {
      connections: mine.map((c) => this.view(c, roster)),
      jobs: [...waiting.slice(0, MAX_JOBS_LISTED), ...rest].map((j) => this.ownerJob(j, roster)),
      limits: { defaults: DEFAULT_LIMITS, maximums: MAX_LIMITS, weeklyPool: this.budget.pool(workspaceId), maxConnections: MAX_CONNECTIONS_PER_WORKSPACE, briefMaxChars: BRIEF_MAX_CHARS, dataMaxBytes: DATA_MAX_BYTES },
      allowedEmployees: roster.map((e) => ({ key: e.key, title: e.title, allowed: e.allowed, ...(e.reason ? { reason: e.reason } : {}) })),
      canManage: this.d.identity.can(userId, workspaceId, "workspace.manage"),
    };
  }

  /** The Admin manager's questions about a tool, and the client's employees an outside tool may or may not be given. */
  planQuestions(userId: string, workspaceId: string): { questions: readonly PlanQuestion[]; employees: { key: string; title: string; allowed: boolean }[] } {
    this.d.identity.require(userId, workspaceId, "workspace.manage");
    return { questions: PLAN_QUESTIONS, employees: this.roster(userId, workspaceId).map((e) => ({ key: e.key, title: e.title, allowed: e.allowed })) };
  }

  /**
   * The Admin manager proposes a set-up from the owner's answers. It only proposes: nothing is created, switched on or
   * changed here, no AI model is asked and no energy is used. The owner accepts by making the connection themselves.
   */
  plan(userId: string, workspaceId: string, answers: unknown): AgentProposal {
    this.d.identity.require(userId, workspaceId, "workspace.manage");
    const proposal = proposePlan(answers, this.roster(userId, workspaceId), { weeklyPool: this.budget.pool(workspaceId), perJob: this.d.energy.estimateFor(workspaceId) });
    this.d.audit.record({ workspaceId, actor: "admin-manager", action: "agent.proposed", data: { by: userId, purpose: proposal.profile.purpose, volume: proposal.profile.volume, tool: proposal.tool, employees: proposal.employees.map((e) => e.key), limits: proposal.limits, needsApproval: proposal.needsApproval } });
    return proposal;
  }

  /** A new connection. The key and the webhook signing secret are returned here and never again. */
  async create(userId: string, workspaceId: string, input: unknown): Promise<{ connection: ConnectionView; key: string; signingSecret: string }> {
    const made = await this.book.create(userId, workspaceId, input);
    return { connection: this.view(made.connection, this.roster(userId, workspaceId)), key: made.key, signingSecret: made.signingSecret ?? "" };
  }

  async update(userId: string, workspaceId: string, id: string, input: unknown): Promise<ConnectionView> {
    return this.view(await this.book.update(userId, workspaceId, id, input), this.roster(userId, workspaceId));
  }

  rotate(userId: string, workspaceId: string, id: string, withSecret = false): { connection: ConnectionView; key: string; signingSecret?: string } {
    const made = this.book.rotate(userId, workspaceId, id, withSecret);
    return { connection: this.view(made.connection, this.roster(userId, workspaceId)), key: made.key, ...(made.signingSecret ? { signingSecret: made.signingSecret } : {}) };
  }

  pause(userId: string, workspaceId: string, id: string): ConnectionView {
    return this.view(this.book.setStatus(userId, workspaceId, id, "paused"), this.roster(userId, workspaceId));
  }

  resume(userId: string, workspaceId: string, id: string): ConnectionView {
    return this.view(this.book.setStatus(userId, workspaceId, id, "active"), this.roster(userId, workspaceId));
  }

  /** Removes a connection for good, with its key, its jobs and anything still waiting to be announced. */
  remove(userId: string, workspaceId: string, id: string): void {
    this.book.remove(userId, workspaceId, id);
    this.jobs.forget(id);
  }

  /** Sends a signed test message to the connection's webhook address, so the owner can see it arrive. */
  async testWebhook(userId: string, workspaceId: string, id: string): Promise<{ delivered: boolean; status?: number }> {
    this.d.identity.require(userId, workspaceId, "workspace.manage");
    const c = this.book.own(workspaceId, id);
    const secret = this.book.secretOf(id);
    if (!c.webhookUrl || !secret) throw new AgentError("Add a webhook address to this connection first.", "no_webhook");
    const r = await this.webhooks.post({ url: c.webhookUrl, secret }, { id: newId("agent_delivery"), type: "test", created: this.now().toISOString(), connection: { id: c.id, name: c.name }, message: "This is a test from MAIZ Agents. Your webhook address works." });
    this.d.audit.record({ workspaceId, actor: `user:${userId}`, action: "agent.webhook_tested", target: id, data: { name: c.name, delivered: r.ok, status: r.status ?? null } });
    return { delivered: r.ok, ...(r.status !== undefined ? { status: r.status } : {}) };
  }

  /** The owner lets a waiting job go ahead. It is lined up to run; call `run` with its id (the route does, after replying). */
  approve(userId: string, workspaceId: string, jobId: string): OwnerJob {
    const job = this.waitingJob(userId, workspaceId, jobId);
    const { reason: _was, ...rest } = job;
    const next = this.jobs.save({ ...rest, status: "queued", decidedBy: userId });
    this.d.audit.record({ workspaceId, actor: `user:${userId}`, action: "agent.job_approved", target: jobId, data: { connection: this.book.get(job.connectionId)?.name } });
    return this.ownerJob(next, this.roster(userId, workspaceId));
  }

  /** The owner turns a waiting job down. Nothing runs and no energy is used. */
  refuse(userId: string, workspaceId: string, jobId: string, reason?: unknown): OwnerJob {
    const job = this.waitingJob(userId, workspaceId, jobId);
    const note = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, NOTE_MAX_CHARS) : undefined;
    const next = this.close({ ...job, decidedBy: userId, ...(note ? { note } : {}) }, "refused", "owner_refused");
    return this.ownerJob(next, this.roster(userId, workspaceId));
  }

  // ---- the outside tool's side: every call proves itself with the key ----

  /** Who this key is, which employees it may use, its limits and what is left today. */
  me(key: unknown): AgentSelf {
    const c = this.auth(key, true);
    const e = this.budget.of(c);
    const sent = this.jobs.lastHour(c.id, this.now().getTime()).length;
    return {
      connection: { id: c.id, name: c.name, tool: c.tool, keyPrefix: c.keyPrefix, keyExpiresAt: c.keyExpiresAt, needsApproval: c.needsApproval },
      employees: this.usable(c).map((x) => ({ key: x.key, title: x.title })),
      limits: { dailyEnergy: e.dailyCeiling, perJobEnergy: e.perJobCap, jobsPerHour: c.limits.jobsPerHour },
      today: { energyUsed: e.usedToday, energyLeft: e.leftToday, resetsAt: e.resetsAt },
      thisHour: { jobs: sent, jobsLeft: Math.max(0, c.limits.jobsPerHour - sent) },
      examples: (c.profile?.examples ?? []).map((x) => ({ ...x })),
    };
  }

  /** Throws unless the key is a live one. Used before a request body is even read. */
  verify(key: unknown): void { this.auth(key, false); }

  /** The employees this key may give jobs to, with what each can do. */
  employees(key: unknown): { key: string; title: string; summary: string; canDo: readonly string[] }[] {
    return this.usable(this.auth(key, true)).map((x) => ({ key: x.key, title: x.title, summary: x.summary, canDo: x.canDo }));
  }

  /** One of this key's own jobs. Another connection's job looks exactly like one that does not exist. */
  job(key: unknown, jobId: string): PublicJob {
    const c = this.auth(key, true);
    const j = this.jobs.get(jobId);
    if (!j || j.connectionId !== c.id) throw new AgentRefusal(404, "That job was not found.", "not_found");
    return publicJob(j);
  }

  /** This key's recent jobs, newest first, optionally only those with the tool's own reference. */
  recent(key: unknown, limit?: number, reference?: string): PublicJob[] {
    const c = this.auth(key, true);
    const n = Number.isInteger(limit) && limit! > 0 ? Math.min(limit!, MAX_JOBS_LISTED) : OWNER_RECENT_JOBS;
    return this.jobs.of(c.id).filter((j) => !reference || j.reference === reference).reverse().slice(0, n).map(publicJob);
  }

  /**
   * Takes a job from an outside tool. Nothing runs here: the job comes back "queued" (call `run` with its id),
   * "waiting_for_owner" (approval is on, or it is bigger than one job may be), or the call is refused with the reason.
   */
  submit(key: unknown, raw: unknown): { job: AgentJob; replayed: boolean } {
    const c = this.auth(key, false);
    const input = readJobInput(raw);
    this.checkEmployee(c, input.employee);
    const nowMs = this.now().getTime();
    // The same request sent twice (a retry after a timeout) gets the first job back, and is not charged twice.
    const again = input.idempotencyKey ? this.jobs.sameRequest(c.id, input.idempotencyKey, nowMs) : undefined;
    if (again) return { job: again, replayed: true };
    const ws = c.workspaceId;
    const estimate = this.d.energy.estimateFor(ws);
    const e = this.budget.of(c);
    const mustWait = c.needsApproval || estimate > e.perJobCap;
    // Checked before anything is written, so a tool that keeps trying cannot fill the records.
    this.checkRoom(c, mustWait, nowMs);
    const fresh: AgentJob = {
      id: newId("agent_job"), workspaceId: ws, connectionId: c.id, employee: input.employee, brief: input.brief,
      ...(input.data ? { data: input.data } : {}), ...(input.reference ? { reference: input.reference } : {}), ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      urgent: input.urgent, status: "queued", estimate, createdAt: this.now().toISOString(),
    };
    this.book.note(c.id, { lastUsedAt: fresh.createdAt });
    this.d.audit.record({ workspaceId: ws, actor: principalOf(c.id), action: "agent.job_submitted", target: fresh.id, data: { connection: c.name, employee: input.employee, briefChars: input.brief.length, dataBytes: input.data ? Buffer.byteLength(input.data, "utf8") : 0, reference: input.reference ?? null, estimate } });
    const empty = this.budget.teamEmpty(ws);
    if (empty) {
      const job = this.close(fresh, "refused", "no_energy");
      throw new AgentRefusal(402, "This team has no energy left for now.", "no_energy", { resetsAt: empty.resetsAt, job: publicJob(job) });
    }
    if (e.leftToday <= 0) {
      const job = this.close(fresh, "refused", "daily_limit");
      this.tellCeiling(c, e);
      throw new AgentRefusal(402, "This connection has used its energy for today. It starts again tomorrow.", "daily_limit", { resetsAt: e.resetsAt, job: publicJob(job) });
    }
    return { job: mustWait ? this.hold(c, fresh, c.needsApproval ? "needs_approval" : "over_job_limit") : this.jobs.save(fresh), replayed: false };
  }

  /**
   * Runs a queued job through the same door as the ask bar. One connection's jobs run one at a time, in order.
   * Resolves with the job as it ended: done with the answer, refused, or failed. Never rejects for a job that exists.
   */
  run(jobId: string): Promise<AgentJob> {
    const job = this.jobs.get(jobId);
    if (!job) return Promise.reject(new AgentRefusal(404, "That job was not found.", "not_found"));
    if (job.status !== "queued") return Promise.resolve(job);
    const lined = this.scheduled.get(jobId);
    if (lined) return lined;
    const turn = (this.lines.get(job.connectionId) ?? Promise.resolve()).then(() => this.runNow(jobId)).finally(() => this.scheduled.delete(jobId));
    this.scheduled.set(jobId, turn);
    this.lines.set(job.connectionId, turn.catch(() => undefined));
    return turn;
  }

  /** Sends any webhook that is due now. Never throws. */
  async deliverWebhooks(): Promise<number> { return this.webhooks.deliverDue(); }

  /**
   * Once a minute: retries webhooks, starts any queued job that was never started (a restart got in the way), closes
   * jobs cut off mid-run and approvals nobody answered, and warns the owner before a key expires.
   */
  async tick(): Promise<void> {
    const nowMs = this.now().getTime();
    for (const j of this.jobs.all()) {
      if (j.status === "working" && nowMs - Date.parse(j.startedAt ?? j.createdAt) > STUCK_AFTER_MINUTES * MINUTE_MS) this.close(j, "failed", "interrupted");
      else if (j.status === "waiting_for_owner" && nowMs - Date.parse(j.createdAt) > WAITING_EXPIRES_DAYS * DAY_MS) this.close(j, "refused", "approval_expired");
      else if (j.status === "queued" && !this.scheduled.has(j.id)) void this.run(j.id).catch(() => undefined);
    }
    for (const c of this.book.all()) {
      const left = Date.parse(c.keyExpiresAt) - nowMs;
      if (c.expiryWarned || c.status !== "active" || left <= 0 || left > KEY_EXPIRY_WARNING_DAYS * DAY_MS) continue;
      this.book.note(c.id, { expiryWarned: true });
      this.d.notify?.(c.workspaceId, { title: `The key for "${c.name}" expires soon`, body: `It stops working on ${c.keyExpiresAt.slice(0, 10)}. Replace the key on the Apps screen and paste the new one into your tool.` });
    }
    await this.webhooks.deliverDue();
  }

  // ---- inside ----

  private async runNow(jobId: string): Promise<AgentJob> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "queued") return job!;
    const c = this.book.get(job.connectionId);
    // Checked again at the moment of running: the owner may have paused the connection or changed its employees since.
    if (!c || c.status !== "active") return this.close(job, "refused", "connection_off");
    const principal = principalOf(c.id);
    let entry: RosterEntry | undefined;
    try { entry = this.roster(principal, c.workspaceId).find((e) => e.key === job.employee); } catch { entry = undefined; }
    if (!entry) return this.close(job, "refused", "employee_not_found");
    if (!entry.allowed || NEVER_ALLOWED[job.employee] || !c.employees.includes(job.employee)) return this.close(job, "refused", "employee_not_allowed");
    // A job the owner approved runs on the owner's say. Any other stops at the connection's daily ceiling.
    const e = this.budget.of(c);
    if (!job.decidedBy && e.leftToday <= 0) { this.tellCeiling(c, e); return this.close(job, "refused", "daily_limit"); }
    const working = this.jobs.save({ ...job, status: "working", startedAt: this.now().toISOString() });
    let outcome: { status: "done" | "refused" | "failed"; reason?: AgentJobReason; patch: Partial<AgentJob> };
    try {
      const task = await this.d.workforce.assign(principal, c.workspaceId, entry.employeeId, fenceBrief(c.name, job.brief, job.data, profileContext(c.profile)), { when: "now", urgent: job.urgent });
      const used = { taskId: task.id, ...(task.energyUsed !== undefined ? { energyUsed: task.energyUsed, energyDay: this.budget.dayOf(c.workspaceId) } : {}) };
      // "ready_for_review" is a finished draft. Anything else never produced an answer, so no result is passed on.
      if (task.status === "ready_for_review" && task.deliverable !== undefined) outcome = { status: "done", patch: { ...used, result: task.deliverable } };
      else if (task.status === "no_energy") outcome = { status: "refused", reason: "no_energy", patch: used };
      else outcome = { status: "failed", reason: "failed", patch: used };
    } catch {
      // The cause stays in the server's own records. The outside tool only learns that the job failed.
      outcome = { status: "failed", reason: "failed", patch: {} };
    }
    // If the job was closed while it ran (cut off and marked interrupted), that record stands.
    const current = this.jobs.get(jobId);
    if (!current || current.status !== "working") return current ?? working;
    const ended = this.close({ ...working, ...outcome.patch }, outcome.status, outcome.reason);
    await this.webhooks.deliverDue();
    return ended;
  }

  /** Ends a job: stores the final state (without the tool's data, which is no longer needed), writes the audit line and lines up the webhook. */
  private close(job: AgentJob, status: "done" | "refused" | "failed", reason?: AgentJobReason): AgentJob {
    const { reason: _old, data: _spent, ...rest } = job;
    const ended = this.jobs.save({ ...rest, status, ...(reason ? { reason } : {}), finishedAt: this.now().toISOString() });
    const event: WebhookEvent = status === "done" ? "job.done" : status === "refused" ? "job.refused" : "job.failed";
    this.webhooks.enqueue(ended.workspaceId, ended.connectionId, ended.id, event);
    this.d.audit.record({ workspaceId: ended.workspaceId, actor: principalOf(ended.connectionId), action: `agent.job_${status}`, target: ended.id, data: { connection: this.book.get(ended.connectionId)?.name, employee: ended.employee, reason: reason ?? null, energy: ended.energyUsed ?? 0 } });
    return ended;
  }

  /** Parks a job for the owner. The bell rings for the first one waiting, not for every one after it. */
  private hold(c: AgentConnection, job: AgentJob, reason: "needs_approval" | "over_job_limit"): AgentJob {
    const alreadyWaiting = this.waitingFor(c.id) > 0;
    const held = this.jobs.save({ ...job, status: "waiting_for_owner", reason });
    this.webhooks.enqueue(held.workspaceId, c.id, held.id, "job.waiting_for_owner");
    this.d.audit.record({ workspaceId: held.workspaceId, actor: principalOf(c.id), action: "agent.job_waiting", target: held.id, data: { connection: c.name, employee: held.employee, reason } });
    if (!alreadyWaiting) this.d.notify?.(c.workspaceId, { title: `"${c.name}" has a job waiting for you`, body: reason === "needs_approval" ? "You asked to approve its jobs first. Approve or refuse it on the Apps screen." : "It is bigger than one job may be, so it waits for you. Approve or refuse it on the Apps screen." });
    return held;
  }

  /** The employee must be on the connection's list, still on the team, and never one of the two no outside tool may use. */
  private checkEmployee(c: AgentConnection, employee: string): void {
    const notAllowed = new AgentRefusal(403, "This key may not give jobs to that employee. GET /employees lists the ones it may use.", "employee_not_allowed");
    if (NEVER_ALLOWED[employee] || !c.employees.includes(employee)) throw notAllowed;
    const entry = this.roster(principalOf(c.id), c.workspaceId).find((e) => e.key === employee);
    if (!entry) throw new AgentRefusal(404, "That employee is no longer on this team.", "employee_not_found");
    if (!entry.allowed) throw notAllowed;
  }

  /** Jobs an hour, and how many may wait for the owner at once. */
  private checkRoom(c: AgentConnection, mustWait: boolean, nowMs: number): void {
    const lastHour = this.jobs.lastHour(c.id, nowMs);
    if (lastHour.length >= c.limits.jobsPerHour) {
      const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(lastHour[0]!.createdAt) + 60 * MINUTE_MS - nowMs) / 1000));
      throw new AgentRefusal(429, `This key may send ${c.limits.jobsPerHour} jobs an hour. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`, "rate_limit", { retryAfterSeconds });
    }
    if (mustWait && this.waitingFor(c.id) >= MAX_WAITING_JOBS) {
      throw new AgentRefusal(429, "Too many jobs are already waiting for the owner to approve. Try again once some have been decided.", "too_many_waiting", { retryAfterSeconds: 60 * 60 });
    }
  }

  private waitingJob(userId: string, workspaceId: string, jobId: string): AgentJob {
    this.d.identity.require(userId, workspaceId, "workspace.manage");
    const job = this.jobs.get(jobId);
    if (!job || job.workspaceId !== workspaceId) throw new AgentRefusal(404, "That job was not found.", "not_found");
    if (job.status !== "waiting_for_owner") throw new AgentRefusal(409, "That job is not waiting for you any more.", "not_waiting");
    return job;
  }

  /** The owner is told once a day that a connection reached its ceiling, not once per refused job. */
  private tellCeiling(c: AgentConnection, e: AgentEnergy): void {
    const day = this.budget.dayOf(c.workspaceId);
    if (c.ceilingNoticeDay === day) return;
    this.book.note(c.id, { ceilingNoticeDay: day });
    this.d.notify?.(c.workspaceId, { title: `"${c.name}" reached its daily limit`, body: `It used ${e.usedToday} of the ${e.dailyCeiling} energy it may use in a day. More jobs are refused until tomorrow. You can change the limit on the Apps screen.` });
  }

  private auth(key: unknown, reading: boolean): AgentConnection {
    const c = this.book.byKey(key);
    if (!c) throw new AgentAuthError();
    if (!reading) return c;
    const nowMs = this.now().getTime();
    const window = this.reads.get(c.id);
    if (!window || nowMs - window.start >= MINUTE_MS) { this.reads.set(c.id, { start: nowMs, count: 1 }); return c; }
    if (window.count >= READS_PER_MINUTE) throw new AgentRefusal(429, "Too many requests. Slow down and try again in a minute.", "rate_limit", { retryAfterSeconds: Math.max(1, Math.ceil((window.start + MINUTE_MS - nowMs) / 1000)) });
    this.reads.set(c.id, { start: window.start, count: window.count + 1 });
    return c;
  }

  private roster(asUserId: string, workspaceId: string): RosterEntry[] {
    return rosterOf(this.d.workforce, asUserId, workspaceId);
  }

  /** The employees a connection may really use now: on its list, still on the team, and never a forbidden one. */
  private usable(c: AgentConnection): RosterEntry[] {
    return this.roster(principalOf(c.id), c.workspaceId).filter((e) => e.allowed && c.employees.includes(e.key));
  }

  private payloadFor(x: Delivery): Record<string, unknown> | undefined {
    const job = this.jobs.get(x.jobId), c = this.book.get(x.connectionId);
    if (!job || !c) return undefined;
    // A job that has moved on since (approved, refused) is announced by its later event instead.
    if (x.event === "job.waiting_for_owner" && job.status !== "waiting_for_owner") return undefined;
    return { id: x.id, type: x.event, created: x.createdAt, connection: { id: c.id, name: c.name }, job: publicJob(job) };
  }

  private view(c: AgentConnection, roster: RosterEntry[]): ConnectionView {
    const ms = this.now().getTime();
    return connectionView(c, roster, { ms, energy: this.budget.of(c), jobsThisHour: this.jobs.lastHour(c.id, ms).length, waiting: this.waitingFor(c.id) });
  }

  private ownerJob(j: AgentJob, roster: RosterEntry[]): OwnerJob {
    return ownerJobView(j, roster, this.book.get(j.connectionId)?.name ?? "");
  }

  private waitingFor(connectionId: string): number {
    return this.jobs.of(connectionId).filter((j) => j.status === "waiting_for_owner").length;
  }
}
