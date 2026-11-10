import { newId, type Id } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { EventBus } from "../../core/events.js";
import type { IdentityService } from "../identity/index.js";
import type { Completer } from "../model-gateway/types.js";
import { getTemplate } from "./templates.js";
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

export type TaskStatus = "ready_for_review" | "failed" | "no_energy";

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
}

export class WorkforceService {
  private employees = new Map<string, Employee>();
  private profiles = new Map<string, BusinessProfile>();
  private tasks = new Map<string, TaskResult>();
  private sink?: Sink;

  useSink(sink: Sink): void {
    this.sink = sink;
  }

  /** Extra facts per employee from other modules (for example connected apps). Kept out of this module's imports. */
  private contextSources: ((workspaceId: string, templateKey: string) => string | undefined)[] = [];
  addContext(source: (workspaceId: string, templateKey: string) => string | undefined): void {
    this.contextSources.push(source);
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
    const template = getTemplate(templateKey);
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

  /** Platform-level lookup (no user check): which template an employee was hired from. */
  templateOf(employeeId: string): string | undefined {
    return this.employees.get(employeeId)?.templateKey;
  }

  team(userId: string, workspaceId: string): Employee[] {
    this.identity.require(userId, workspaceId, "task.read");
    return [...this.employees.values()].filter((e) => e.workspaceId === workspaceId);
  }

  /** Give an employee a piece of work. Returns a draft for the owner to review. */
  async assign(userId: string, workspaceId: string, employeeId: string, brief: string): Promise<TaskResult> {
    this.identity.require(userId, workspaceId, "task.create");
    const employee = this.employees.get(employeeId);
    // An employee from another workspace looks exactly like one that does not exist.
    if (!employee || employee.workspaceId !== workspaceId) throw new Error("employee not found");
    const template = getTemplate(employee.templateKey);
    if (!template) throw new Error("employee template missing");

    const profile = this.profiles.get(workspaceId);
    const jd = getJobDescription(template.key);
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
      const extra = source(workspaceId, template.key);
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
    try {
      const result = await this.gateway.complete({
        tier: template.tier,
        workspaceId,
        taskType: template.key,
        // Long deliverables (reports, journals) must not be cut off mid-sentence.
        maxTokens: 4096,
        messages: [
          { role: "system", content: system },
          { role: "user", content: brief },
        ],
      });
      task.deliverable = result.text;
      task.provider = result.provider;
      task.inputTokens = result.inputTokens;
      task.outputTokens = result.outputTokens;
      task.energyUsed = this.energy?.record(workspaceId, employeeId, result.provider, result.inputTokens, result.outputTokens, verdict.overtime, result.costMicro).energy;
    } catch {
      task.status = "failed";
    }
    this.tasks.set(task.id, task);
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
