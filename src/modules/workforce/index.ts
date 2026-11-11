import { newId, type Id } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { EventBus } from "../../core/events.js";
import type { IdentityService } from "../identity/index.js";
import type { ChatMessage, Completer, TextStream } from "../model-gateway/types.js";
import { getTemplate, type EmployeeTemplate } from "./templates.js";
import { getJobDescription, renderJobDescription } from "./job-descriptions.js";
import type { EnergyMeter } from "../energy/index.js";
import { describePack, packFor } from "./finance/rules-pack.js";

/** Describes the business so every employee can tailor its work. */
export interface BusinessProfile {
  description: string;
  stage?: string;
  audience?: string;
  tone?: string;
  country?: string;
  currency?: string;
}

export interface Employee {
  id: Id<"employee">;
  workspaceId: string;
  templateKey: string;
  name: string;
}

export type TaskStatus = "ready_for_review" | "failed" | "no_energy" | "queued";

export interface TaskResult {
  id: Id<"task">;
  workspaceId: string;
  employeeId: string;
  brief: string;
  status: TaskStatus;
  /** Why work did not start (no_energy only). */
  reason?: string;
  energyUsed?: number;
  /** The employee's draft. Nothing is ever sent outside the platform. */
  deliverable?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Real provider cost and its Claude-only baseline, in micro-dollars. Platform use only: never sent to clients. */
  costMicro?: number;
  baselineMicro?: number;
  /** Queued tasks only: the batch job, when it is due, and why it was not run at once. */
  /** Why a failed task failed (platform use only). */
  failure?: string;
  /** When the task finished (ISO). */
  at?: string;
  /** A second model checked this answer before it was shown. */
  checked?: boolean;
  jobId?: string;
  runsAt?: string;
  queueReason?: string;
}

export interface AssignOptions {
  /** The person wants it now: skip the batch queue. */
  urgent?: boolean;
  /** The ask bar's choice: "now" answers at once, "tonight" waits for the batch. No choice means the platform decides. */
  when?: "now" | "tonight";
  /** Set by the workforce, never by callers: a new client whose ordinary work is answered at once. */
  liveByDefault?: boolean;
  /** Earlier turns of the conversation, so a follow-up ("make it shorter") knows what "it" is. Oldest first. */
  history?: ChatMessage[];
  /** Receives a live answer as it is written. Only answers produced now stream; queued work does not. */
  stream?: TextStream;
}

/** Answers a short question from the client's own records with no model call. Returns undefined when it does not apply. */
export type InstantAnswerer = (userId: string, workspaceId: string, brief: string) => string | undefined;

/** How a request is handled. The batch module implements this; the workforce only asks. */
export interface Intake {
  route(workspaceId: string, templateKey: string, brief: string, opts: AssignOptions): { mode: "lookup" | "urgent" | "batch"; reason: string; flushAfter?: boolean };
  /** Called after urgent work finished: the pod is warm, so waiting work may as well go now. Must not throw. */
  flush?(): void;
  enqueue(job: { userId: string; workspaceId: string; employeeId: string; brief: string; reason: string; estTokens: number }): { jobId: string; runsAt: string };
  /** Rules for answering new clients at once. */
  liveDefaults?(): { liveDuringTrial: boolean; liveFirstTasks: number };
  /** Records how long an answer took, for the owner's speed page. Must not throw. */
  record?(kind: "instant" | "lookup" | "live", ms: number): void;
  /** How many of this client's tasks are waiting for a batch. */
  queuedFor?(workspaceId: string): number;
  /** When this client's next batch runs. */
  nextRunFor?(workspaceId: string): string;
}

/** Most tasks one client may have waiting for a batch, whatever their energy, so one client cannot flood the pod. */
export const MAX_QUEUED_PER_CLIENT = 200;

interface RunContext {
  /** Routing policy. "live" for quick lookups, else the employee template. */
  taskType: string;
  batch?: { allowClaudeFallback: boolean };
  history?: ChatMessage[];
  stream?: TextStream;
}

export class WorkforceService {
  private employees = new Map<string, Employee>();
  private profiles = new Map<string, BusinessProfile>();
  private tasks = new Map<string, TaskResult>();
  private sink?: Sink;
  private intake?: Intake;

  /** Turns on the batch queue: non-urgent work is queued instead of answered at once. */
  setIntake(intake: Intake): void {
    this.intake = intake;
  }

  useSink(sink: Sink): void {
    this.sink = sink;
  }

  /** Extra facts per employee from other modules (for example connected apps). Kept out of this module's imports. */
  private contextSources: ((workspaceId: string, templateKey: string, taskType?: string) => string | undefined)[] = [];
  addContext(source: (workspaceId: string, templateKey: string, taskType?: string) => string | undefined): void {
    this.contextSources.push(source);
  }

  /** Templates made for one client (approved custom specialists). Only that client's workspace can use them. */
  private customTemplates = new Map<string, { workspaceId: string; template: EmployeeTemplate }>();

  registerCustomTemplate(workspaceId: string, template: EmployeeTemplate): void {
    this.customTemplates.set(template.key, { workspaceId, template });
  }

  /** The template for a key, as seen from one workspace: shared templates, plus that workspace's own custom ones. */
  templateFor(key: string, workspaceId?: string): EmployeeTemplate | undefined {
    const custom = this.customTemplates.get(key);
    if (custom) return custom.workspaceId === workspaceId ? custom.template : undefined;
    return getTemplate(key);
  }

  restoreTask(t: TaskResult): void {
    this.tasks.set(t.id, t);
    if (t.status === "ready_for_review") this.noteAnswered(t.workspaceId);
  }

  /** Answers each client has had, for "new clients get answers at once". */
  private answered = new Map<string, number>();
  private noteAnswered(workspaceId: string): void { this.answered.set(workspaceId, (this.answered.get(workspaceId) ?? 0) + 1); }
  private instant?: InstantAnswerer;

  /** Turns on answers straight from the client's records for short questions (who is in today, cash, energy left...). */
  setInstant(fn: InstantAnswerer): void { this.instant = fn; }

  /** A free trial, or one of the client's first answers: ordinary work is answered at once instead of waiting for the batch. */
  private liveByDefault(workspaceId: string): boolean {
    const d = this.intake?.liveDefaults?.();
    if (!d) return false;
    if (d.liveDuringTrial && this.energy?.planOf(workspaceId).expiresAt) return true;
    return d.liveFirstTasks > 0 && (this.answered.get(workspaceId) ?? 0) < d.liveFirstTasks;
  }

  /** Finished tasks for one client since a time, newest first. The board and the week's counts read this. */
  tasksSince(userId: string, workspaceId: string, sinceIso: string): TaskResult[] {
    this.identity.require(userId, workspaceId, "task.read");
    return [...this.tasks.values()]
      .filter((t) => t.workspaceId === workspaceId && t.at && t.at >= sinceIso)
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  }

  restoreEmployee(e: Employee): void {
    this.employees.set(e.id, e);
  }

  restoreTraining(employeeId: string, notes: string): void {
    this.training.set(employeeId, notes);
  }

  restoreProfile(workspaceId: string, p: BusinessProfile): void {
    this.profiles.set(workspaceId, p);
  }

  /** What each employee was taught during setup (from the owner's setup form). */
  private training = new Map<string, string>();

  constructor(
    private identity: IdentityService,
    private audit: AuditLog,
    private bus: EventBus,
    private gateway: Completer,
    private energy?: EnergyMeter,
  ) {}

  setProfile(userId: string, workspaceId: string, profile: BusinessProfile): void {
    this.identity.require(userId, workspaceId, "workspace.manage");
    this.profiles.set(workspaceId, profile);
    this.sink?.profile(workspaceId, profile);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "profile.updated" });
  }

  profileOf(userId: string, workspaceId: string): BusinessProfile | undefined {
    this.identity.require(userId, workspaceId, "task.read");
    const p = this.profiles.get(workspaceId);
    return p ? { ...p } : undefined;
  }

  /** Teaches an employee about this business. Replaces earlier training; undefined clears it. */
  train(userId: string, workspaceId: string, employeeId: string, notes: string | undefined): void {
    this.identity.require(userId, workspaceId, "workspace.manage");
    const employee = this.employees.get(employeeId);
    if (!employee || employee.workspaceId !== workspaceId) throw new Error("employee not found");
    if (notes === undefined) this.training.delete(employeeId);
    else this.training.set(employeeId, notes);
    this.sink?.training(workspaceId, employeeId, notes);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: notes === undefined ? "employee.training_cleared" : "employee.trained", target: employeeId });
  }

  trainingOf(userId: string, workspaceId: string, employeeId: string): string | undefined {
    this.identity.require(userId, workspaceId, "task.read");
    const employee = this.employees.get(employeeId);
    if (!employee || employee.workspaceId !== workspaceId) throw new Error("employee not found");
    return this.training.get(employeeId);
  }

  async hire(userId: string, workspaceId: string, templateKey: string, name?: string): Promise<Employee> {
    this.identity.require(userId, workspaceId, "employee.hire");
    const template = this.templateFor(templateKey, workspaceId);
    if (!template) throw new Error(`unknown employee template: ${templateKey}`);
    const employee: Employee = {
      id: newId("employee"),
      workspaceId,
      templateKey,
      name: name ?? template.title,
    };
    this.employees.set(employee.id, employee);
    this.sink?.employee(employee);
    this.audit.record({
      workspaceId,
      actor: `user:${userId}`,
      action: "employee.hired",
      target: employee.id,
      data: { template: templateKey },
    });
    await this.bus.publish({ type: "employee.hired", workspaceId, payload: { employeeId: employee.id }, at: new Date() });
    return employee;
  }

  /** Platform-level (no user check): how many employees a client has. */
  countIn(workspaceId: string): number {
    return [...this.employees.values()].filter((e) => e.workspaceId === workspaceId).length;
  }

  /** Platform-level (no user check): the template of every employee a client has. */
  templatesIn(workspaceId: string): string[] {
    return [...this.employees.values()].filter((e) => e.workspaceId === workspaceId).map((e) => e.templateKey);
  }

  /** Platform-level lookup (no user check): which template an employee was hired from. */
  templateOf(employeeId: string): string | undefined {
    return this.employees.get(employeeId)?.templateKey;
  }

  team(userId: string, workspaceId: string): Employee[] {
    this.identity.require(userId, workspaceId, "task.read");
    return [...this.employees.values()].filter((e) => e.workspaceId === workspaceId);
  }

  /**
   * Give an employee a piece of work. Quick questions and urgent work are answered now (a draft for the owner to
   * review). Everything else is queued for the next batch and comes back as status "queued" with the time it will run.
   */
  async assign(userId: string, workspaceId: string, employeeId: string, brief: string, opts: AssignOptions = {}): Promise<TaskResult> {
    this.identity.require(userId, workspaceId, "task.create");
    const employee = this.employees.get(employeeId);
    // An employee from another workspace looks exactly like one that does not exist.
    if (!employee || employee.workspaceId !== workspaceId) throw new Error("employee not found");
    const template = this.templateFor(employee.templateKey, workspaceId);
    if (!template) throw new Error("employee template missing");
    const started = Date.now();
    // Short questions the records can answer: no model, no energy, no wait.
    const instant = this.instant?.(userId, workspaceId, brief);
    if (instant !== undefined) {
      const answer: TaskResult = { id: newId("task"), workspaceId, employeeId, brief, status: "ready_for_review", deliverable: instant, provider: "instant", energyUsed: 0, at: new Date().toISOString() };
      this.audit.record({ workspaceId, actor: `employee:${employee.id}`, action: "task.instant", target: answer.id });
      this.intake?.record?.("instant", Date.now() - started);
      return answer;
    }
    const route = this.intake?.route(workspaceId, template.key, brief, { ...opts, liveByDefault: this.liveByDefault(workspaceId) });
    if (route?.mode === "batch") {
      // Only queue work that could start: a client with no energy left learns that now, not tonight.
      const verdict = this.energy?.check(workspaceId, employeeId) ?? { allowed: true as const, overtime: false };
      const expiresAt = this.energy?.planOf(workspaceId).expiresAt;
      // A trial that ends before the next batch: do it now, rather than promise work that will not be allowed tonight.
      const endsFirst = !!expiresAt && !!this.intake?.nextRunFor && this.intake.nextRunFor(workspaceId) > expiresAt;
      if (verdict.allowed && !endsFirst) {
        // Only accept what the energy left can plausibly pay for: a client with 10 energy cannot queue 2,000 tasks.
        const waiting = this.intake?.queuedFor?.(workspaceId) ?? 0;
        const spendable = this.energy?.spendableOf(workspaceId) ?? Number.POSITIVE_INFINITY;
        const estimate = this.energy?.estimateFor(workspaceId) ?? 0;
        if (waiting >= MAX_QUEUED_PER_CLIENT || (waiting > 0 && (waiting + 1) * estimate > spendable)) {
          const full: TaskResult = { id: newId("task"), workspaceId, employeeId, brief, status: "no_energy", reason: waiting >= MAX_QUEUED_PER_CLIENT ? "queue_full" : "queue_exceeds_energy" };
          this.audit.record({ workspaceId, actor: `user:${userId}`, action: "task.refused", target: full.id, data: { reason: full.reason, waiting } });
          return full;
        }
        const q = this.intake!.enqueue({ userId, workspaceId, employeeId, brief, reason: route.reason, estTokens: Math.ceil((brief.length + 6000) / 4) + 1500 });
        const queued: TaskResult = { id: newId("task"), workspaceId, employeeId, brief, status: "queued", jobId: q.jobId, runsAt: q.runsAt, queueReason: route.reason };
        this.audit.record({ workspaceId, actor: `user:${userId}`, action: "task.queued", target: queued.id, data: { jobId: q.jobId, runsAt: q.runsAt } });
        return queued;
      }
    }
    const done = await this.execute(userId, workspaceId, employee, brief, { taskType: route?.mode === "lookup" ? "live" : template.key, history: opts.history, stream: opts.stream });
    if (done.status === "ready_for_review") this.intake?.record?.(route?.mode === "lookup" ? "lookup" : "live", Date.now() - started);
    if (route?.flushAfter && done.status === "ready_for_review") this.intake?.flush?.();
    return done;
  }

  /** The business's country, for its local clock. Internal use, no permission check. */
  countryOf(workspaceId: string): string | undefined {
    return this.profiles.get(workspaceId)?.country;
  }

  /** Runs a queued job. Called by the batch dispatcher, which already checked the person's right to ask when it was queued; it is checked again here. */
  async runQueued(job: { userId: string; workspaceId: string; employeeId: string; brief: string }, batch: { allowClaudeFallback: boolean }): Promise<TaskResult> {
    this.identity.require(job.userId, job.workspaceId, "task.create");
    const employee = this.employees.get(job.employeeId);
    if (!employee || employee.workspaceId !== job.workspaceId) throw new Error("employee not found");
    return this.execute(job.userId, job.workspaceId, employee, job.brief, { taskType: employee.templateKey, batch });
  }

  private async execute(userId: string, workspaceId: string, employee: Employee, brief: string, run: RunContext): Promise<TaskResult> {
    const employeeId = employee.id;
    const template = this.templateFor(employee.templateKey, workspaceId)!;

    const profile = this.profiles.get(workspaceId);
    const jd = template.jobDescription ?? getJobDescription(template.key);
    const parts = [
      template.instructions,
      // The full job description: responsibilities, skills, deliverables and authority limits.
      ...(jd ? [renderJobDescription(jd)] : []),
      profile ? `Business profile:\n${JSON.stringify(profile, null, 2)}` : "No business profile has been set yet.",
    ];
    // The Finance manager keeps books to the owner's country rules (or a safe generic set).
    if (template.key === "finance-manager") parts.push(describePack(packFor(profile?.country)));
    const training = this.training.get(employeeId);
    if (training) parts.push(`What the owner told you during setup:\n${training}`);
    for (const source of this.contextSources) {
      const extra = source(workspaceId, template.key, run.taskType);
      if (extra) parts.push(extra);
    }
    const system = parts.join("\n\n");

    // The employee only starts work if there is energy left (or paid overtime).
    const verdict = this.energy?.check(workspaceId, employeeId) ?? { allowed: true as const, overtime: false };
    if (!verdict.allowed) {
      const blocked: TaskResult = { id: newId("task"), workspaceId, employeeId, brief, status: "no_energy", reason: verdict.reason };
      this.tasks.set(blocked.id, blocked);
      this.audit.record({ workspaceId, actor: `user:${userId}`, action: "task.blocked", target: blocked.id, data: { reason: verdict.reason } });
      await this.bus.publish({ type: "energy.exhausted", workspaceId, payload: { employeeId, reason: verdict.reason }, at: new Date() });
      return blocked;
    }
    const task: TaskResult = { id: newId("task"), workspaceId, employeeId, brief, status: "ready_for_review" };
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "task.created", target: task.id });
    // Set the expected energy aside while the model works, so tasks running at once cannot spend the same energy.
    const hold = this.energy?.hold(workspaceId, verdict);
    try {
      const result = await this.gateway.complete({
        tier: template.tier,
        workspaceId,
        taskType: run.taskType,
        ...(run.batch ? { mode: "batch" as const, allowClaudeFallback: run.batch.allowClaudeFallback } : {}),
        // Long deliverables (reports, journals) must not be cut off mid-sentence.
        maxTokens: 4096,
        ...(run.stream ? { stream: run.stream } : {}),
        messages: [
          { role: "system", content: system },
          ...(run.history ?? []),
          { role: "user", content: brief },
        ],
      });
      task.deliverable = result.text;
      task.provider = result.provider;
      task.inputTokens = result.inputTokens;
      task.outputTokens = result.outputTokens;
      task.costMicro = result.costMicro;
      task.baselineMicro = result.routing?.baselineMicro;
      if (result.routing?.reviewed && !result.routing.lowConfidence) task.checked = true;
      task.energyUsed = this.energy?.record(workspaceId, employeeId, result.provider, result.inputTokens, result.outputTokens, verdict.overtime, result.costMicro).energy;
    } catch (err) {
      task.status = "failed";
      task.failure = err instanceof Error ? err.message : String(err);
    } finally {
      if (hold) this.energy?.release(hold);
    }
    task.at = new Date().toISOString();
    this.tasks.set(task.id, task);
    if (task.status === "ready_for_review") this.noteAnswered(workspaceId);
    this.sink?.record(workspaceId, "task", task.id, task);
    this.audit.record({
      workspaceId,
      actor: `employee:${employee.id}`,
      action: task.status === "failed" ? "task.failed" : "task.completed",
      target: task.id,
      data: { provider: task.provider, inputTokens: task.inputTokens, outputTokens: task.outputTokens },
    });
    await this.bus.publish({ type: `task.${task.status}`, workspaceId, payload: { taskId: task.id }, at: new Date() });
    return task;
  }
}
