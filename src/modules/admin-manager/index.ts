import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { EventBus } from "../../core/events.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";
import type { WorkforceService } from "../workforce/index.js";
import type { ChannelKind, ChannelRouter } from "../channels/index.js";
import type { ContactChannel, Organisation } from "../onboarding/index.js";
import { getTemplate } from "../workforce/templates.js";
import { formFor, trainingNotes, validateAnswers, type Answers, type FormField } from "./form.js";
import { formInviteText, readyText, stepTitle, welcomeText } from "./messages.js";
import {
  StepRunner,
  drivePlan,
  installMode,
  modelsFor,
  type Drive,
  type ModelInstall,
  type ModelProvisioner,
  type SetupRun,
  type SetupStep,
  type StorageProvisioner,
} from "./provisioning.js";

/**
 * The Admin manager is the free AI manager every organisation gets. After signup it:
 *  1. contacts the owner where they chose (dashboard, or Slack / Teams once connected),
 *  2. introduces the employees in their package and what each can do,
 *  3. sends the setup form,
 *  4. once the form is in: applies it to the business profile, creates storage,
 *     prepares the AI models, trains every employee and finishes setup.
 * Every setup step is journaled and can be rolled back (see provisioning.ts).
 *
 * The welcome and setup messages are written from templates, not by a model, so
 * they cost the customer no energy and always say the same true thing.
 */

export type SetupState = "awaiting_form" | "setting_up" | "ready" | "needs_attention";

export type AdminMessageKind = "welcome" | "form" | "progress" | "ready" | "failed" | "rolled_back" | "review";

export interface AdminMessage {
  id: string;
  workspaceId: string;
  kind: AdminMessageKind;
  text: string;
  /** Link to open, for example the setup form. */
  link?: string;
  at: string;
  /** Where it was delivered. The dashboard inbox always has every message. */
  delivered: ContactChannel[];
  /** A chat app that was chosen but is not connected yet. Sent when it is. */
  pendingOn?: ChannelKind;
}

export interface SetupStatus {
  state: SetupState;
  contact: ContactChannel;
  form: FormField[];
  runs: SetupRun[];
}

interface OrgState {
  org: Organisation;
  ownerUserId: string;
  contact: ContactChannel;
  state: SetupState;
  runs: SetupRun[];
  /** Step definitions per run, so a finished run can be rolled back later. */
  steps: Map<string, SetupStep[]>;
}

/** What is stored for each organisation. Step definitions are rebuilt from code, not stored. */
export interface AdminOrgRecord {
  org: Organisation;
  ownerUserId: string;
  contact: ContactChannel;
  state: SetupState;
  runs: SetupRun[];
}

export class SetupError extends Error {}

export interface AdminManagerOptions {
  /** Where the setup form lives in the control center. */
  formUrl?: string;
  now?: () => Date;
}

export class AdminManager {
  private orgs = new Map<string, OrgState>();
  private inbox: AdminMessage[] = [];
  private sink?: Sink;

  useSink(sink: Sink): void {
    this.sink = sink;
  }

  /** Put back an organisation read from storage. A setup that was running when the server stopped needs a person to look at it. */
  restoreOrg(r: AdminOrgRecord): void {
    const s: OrgState = { org: r.org, ownerUserId: r.ownerUserId, contact: r.contact, state: r.state === "setting_up" ? "needs_attention" : r.state, runs: r.runs, steps: new Map() };
    // Undo only needs what each step returned (kept in the run), so steps are rebuilt from code.
    for (const run of r.runs) s.steps.set(run.id, this.buildSteps(s, formFor(r.org.blueprint.employees), {}));
    this.orgs.set(r.org.workspaceId, s);
  }

  restoreMessage(m: AdminMessage): void {
    this.inbox.push(m);
  }

  private save(workspaceId: string): void {
    const s = this.orgs.get(workspaceId);
    if (s) this.sink?.adminOrg(workspaceId, { org: s.org, ownerUserId: s.ownerUserId, contact: s.contact, state: s.state, runs: s.runs });
  }
  private runner: StepRunner;
  private formUrl: string;
  private now: () => Date;

  constructor(
    private identity: IdentityService,
    private workforce: WorkforceService,
    private audit: AuditLog,
    private bus: EventBus,
    private storage: StorageProvisioner,
    private models: ModelProvisioner,
    private router?: ChannelRouter,
    opts: AdminManagerOptions = {},
  ) {
    this.formUrl = opts.formUrl ?? "/app.html#setup";
    this.now = opts.now ?? (() => new Date());
    this.runner = new StepRunner(audit, this.now);
  }

  /** Called straight after signup. Introduces the team and sends the setup form. */
  async welcome(ownerUserId: string, org: Organisation): Promise<AdminMessage[]> {
    this.identity.require(ownerUserId, org.workspaceId, "workspace.manage");
    if (this.orgs.has(org.workspaceId)) throw new SetupError("already welcomed");
    const contact = org.blueprint.contact;
    this.orgs.set(org.workspaceId, { org, ownerUserId, contact, state: "awaiting_form", runs: [], steps: new Map() });
    this.save(org.workspaceId);
    const { businessName, employees, trialDays, privacy, plan } = org.blueprint;
    const out = [await this.deliver(org.workspaceId, "welcome", welcomeText(businessName, employees, trialDays))];
    out.push(await this.deliver(org.workspaceId, "form", formInviteText(employees, drivePlan(privacy, plan).kind), this.formUrl));
    this.audit.record({ workspaceId: org.workspaceId, actor: "employee:admin-manager", action: "admin.welcomed", data: { contact, employees: org.blueprint.employees } });
    return out;
  }

  /** The form for this organisation's team, and how setup is going. */
  status(userId: string, workspaceId: string): SetupStatus {
    this.identity.require(userId, workspaceId, "task.read");
    const s = this.state(workspaceId);
    return { state: s.state, contact: s.contact, form: formFor(s.org.blueprint.employees), runs: s.runs.map((r) => structuredClone(r)) };
  }

  /** Dashboard inbox: every Admin manager message, oldest first. */
  messages(userId: string, workspaceId: string): AdminMessage[] {
    this.identity.require(userId, workspaceId, "task.read");
    return this.inbox.filter((m) => m.workspaceId === workspaceId).map((m) => ({ ...m, delivered: [...m.delivered] }));
  }

  /** Sends messages that were waiting for the chosen chat app to be connected. Returns how many went out. */
  async deliverPending(userId: string, workspaceId: string): Promise<number> {
    this.identity.require(userId, workspaceId, "workspace.manage");
    const s = this.state(workspaceId);
    let sent = 0;
    for (const m of this.inbox) {
      if (m.workspaceId !== workspaceId || !m.pendingOn) continue;
      if (!(await this.sendChat(workspaceId, m.pendingOn, s.ownerUserId, m))) break;
      m.delivered.push(m.pendingOn);
      delete m.pendingOn;
      this.sink?.adminMessage(m);
      sent++;
    }
    return sent;
  }

  /** The owner sends the form. Setup runs straight away; a failure is rolled back automatically. */
  async submitForm(userId: string, workspaceId: string, answers: Answers): Promise<SetupRun> {
    this.identity.require(userId, workspaceId, "workspace.manage");
    const s = this.state(workspaceId);
    if (s.state === "setting_up") throw new SetupError("setup is already running");
    if (s.state === "ready") throw new SetupError("already set up; roll back first to start again");
    const fields = formFor(s.org.blueprint.employees);
    const v = validateAnswers(fields, answers);
    if (!v.ok) throw new SetupError(`form has errors: ${Object.keys(v.errors).join(", ")}`);
    this.audit.record({ workspaceId, actor: `user:${userId}`, action: "setup.form_submitted", data: { fields: Object.keys(v.clean) } });

    s.state = "setting_up";
    this.save(workspaceId);
    await this.deliver(workspaceId, "progress", "Thanks, got your answers. Setting up your team now.");
    const steps = this.buildSteps(s, fields, v.clean);
    const run = await this.runner.run(userId, workspaceId, steps);
    s.runs.push(run);
    s.steps.set(run.id, steps);
    this.save(workspaceId);

    if (run.status === "completed") {
      s.state = "ready";
      await this.deliver(workspaceId, "ready", readyText(s.org.blueprint.employees));
      await this.bus.publish({ type: "setup.completed", workspaceId, payload: { runId: run.id }, at: this.now() });
    } else {
      s.state = run.status === "rolled_back" ? "awaiting_form" : "needs_attention";
      const failed = run.steps.find((r) => r.status === "failed");
      await this.deliver(
        workspaceId,
        "failed",
        run.status === "rolled_back"
          ? `Setup stopped at "${failed?.title}". I undid every step, so nothing is left half done. Please send the form again; your answers are kept in this message thread.`
          : `Setup stopped at "${failed?.title}" and I could not undo every step. The MAIZ team has been alerted and will fix it; you don't need to do anything.`,
        this.formUrl,
      );
      await this.bus.publish({ type: "setup.failed", workspaceId, payload: { runId: run.id, status: run.status }, at: this.now() });
    }
    this.save(workspaceId);
    return run;
  }

  /** The owner undoes the finished setup: training, models, storage and profile changes, newest first. */
  async rollback(userId: string, workspaceId: string): Promise<SetupRun> {
    this.identity.require(userId, workspaceId, "workspace.manage");
    const s = this.state(workspaceId);
    const run = [...s.runs].reverse().find((r) => r.status === "completed");
    if (!run || s.state !== "ready") throw new SetupError("nothing to roll back");
    await this.runner.rollback(userId, run, s.steps.get(run.id) ?? [], "owner_request");
    s.state = run.status === "rolled_back" ? "awaiting_form" : "needs_attention";
    this.save(workspaceId);
    await this.deliver(
      workspaceId,
      "rolled_back",
      run.status === "rolled_back"
        ? "Done: I undid the setup. Your storage, models and training are removed and your profile is back as it was. Send the form again whenever you're ready."
        : "I undid most of the setup but some steps need the MAIZ team. They have been alerted and will finish it.",
      this.formUrl,
    );
    await this.bus.publish({ type: "setup.rolled_back", workspaceId, payload: { runId: run.id, status: run.status }, at: this.now() });
    return structuredClone(run);
  }

  // ---------- setup steps ----------

  private buildSteps(s: OrgState, fields: FormField[], answers: Answers): SetupStep[] {
    const { org } = s;
    const ws = org.workspaceId;
    const memberIds = [org.adminManagerId, ...org.employeeIds];
    return [
      {
        key: "profile",
        title: stepTitle("profile"),
        run: async (ctx) => {
          const before = this.workforce.profileOf(ctx.userId, ws);
          const base = before ?? org.blueprint.profile;
          this.workforce.setProfile(ctx.userId, ws, {
            ...base,
            audience: typeof answers.customers === "string" ? answers.customers : base.audience,
            tone: typeof answers.tone === "string" ? answers.tone : base.tone,
          });
          return { before };
        },
        undo: async (ctx, out) => {
          const before = (out as { before?: Parameters<WorkforceService["setProfile"]>[2] }).before;
          this.workforce.setProfile(ctx.userId, ws, before ?? org.blueprint.profile);
        },
      },
      {
        key: "storage",
        title: stepTitle("storage"),
        run: async () => {
          const plan = drivePlan(org.blueprint.privacy, org.blueprint.plan);
          return await this.storage.create({ workspaceId: ws, ...plan });
        },
        undo: async (_ctx, out) => this.storage.remove((out as Drive).id),
      },
      {
        key: "models",
        title: stepTitle("models"),
        run: async (ctx) => {
          const drive = ctx.outputs.storage as Drive;
          const tiers = org.blueprint.employees.map((k) => getTemplate(k)?.tier).filter((t): t is "standard" | "premium" => !!t);
          const needs = modelsFor(tiers);
          const downloadGb = needs.filter((n) => installMode(n, drive) === "download").reduce((a, n) => a + n.sizeGb, 0);
          if (downloadGb > drive.quotaGb) throw new Error(`models need ${downloadGb} GB but the drive has ${drive.quotaGb} GB`);
          const done: ModelInstall[] = [];
          try {
            for (const need of needs) done.push(await this.models.install(ws, need, installMode(need, drive), drive));
          } catch (err) {
            // Leave nothing behind from a half-finished step.
            for (const i of done.reverse()) await this.models.uninstall(i.id).catch(() => {});
            throw err;
          }
          return done;
        },
        undo: async (_ctx, out) => {
          for (const i of [...(out as ModelInstall[])].reverse()) await this.models.uninstall(i.id);
        },
      },
      {
        key: "training",
        title: stepTitle("training"),
        run: async (ctx) => {
          const before: Record<string, string | undefined> = {};
          const team = this.workforce.team(ctx.userId, ws).filter((e) => memberIds.includes(e.id));
          try {
            for (const e of team) {
              before[e.id] = this.workforce.trainingOf(ctx.userId, ws, e.id);
              this.workforce.train(ctx.userId, ws, e.id, trainingNotes(e.templateKey, fields, answers));
            }
          } catch (err) {
            for (const [id, notes] of Object.entries(before)) this.workforce.train(ctx.userId, ws, id, notes);
            throw err;
          }
          return { before };
        },
        undo: async (ctx, out) => {
          for (const [id, notes] of Object.entries((out as { before: Record<string, string | undefined> }).before)) this.workforce.train(ctx.userId, ws, id, notes);
        },
      },
      {
        key: "finish",
        title: stepTitle("finish"),
        run: async (ctx) => {
          // Every member of the team must be trained and every chosen model ready before we say "ready".
          for (const id of memberIds) if (!this.workforce.trainingOf(ctx.userId, ws, id)) throw new Error("an employee was not trained");
          if (!(ctx.outputs.models as ModelInstall[]).length) throw new Error("no models prepared");
          return { checkedAt: this.now().toISOString() };
        },
        undo: async () => {},
      },
    ];
  }

  // ---------- messaging ----------

  /**
   * A note from the Admin manager to the client, for example that a specialised task passed quality
   * review. Returns undefined for a workspace that was never welcomed (no inbox to post to).
   */
  async tell(workspaceId: string, text: string, link?: string): Promise<AdminMessage | undefined> {
    if (!this.orgs.has(workspaceId)) return undefined;
    return this.deliver(workspaceId, "review", text, link);
  }

  private state(workspaceId: string): OrgState {
    const s = this.orgs.get(workspaceId);
    if (!s) throw new SetupError("organisation not welcomed yet");
    return s;
  }

  private async deliver(workspaceId: string, kind: AdminMessageKind, text: string, link?: string): Promise<AdminMessage> {
    const s = this.state(workspaceId);
    const msg: AdminMessage = { id: newId("admin-msg"), workspaceId, kind, text, ...(link ? { link } : {}), at: this.now().toISOString(), delivered: ["dashboard"] };
    this.inbox.push(msg);
    if (s.contact !== "dashboard") {
      // Keep order: if earlier messages are still waiting for the chat app, this one waits too.
      const behind = this.inbox.some((m) => m !== msg && m.workspaceId === workspaceId && m.pendingOn);
      if (!behind && (await this.sendChat(workspaceId, s.contact, s.ownerUserId, msg))) msg.delivered.push(s.contact);
      else msg.pendingOn = s.contact;
    }
    this.sink?.adminMessage(msg);
    return msg;
  }

  private async sendChat(workspaceId: string, channel: ChannelKind, ownerUserId: string, m: AdminMessage): Promise<boolean> {
    if (!this.router) return false;
    try {
      return await this.router.sendToUser(workspaceId, channel, ownerUserId, m.link ? `${m.text}\n${m.link}` : m.text);
    } catch {
      return false;
    }
  }
}

export { SETUP_FORM, formFor, validateAnswers, trainingNotes, type Answers, type FormField } from "./form.js";
export { SETUP_STEPS, welcomeText, formInviteText, readyText } from "./messages.js";
export * from "./provisioning.js";
