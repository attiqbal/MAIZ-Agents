import { LatencyLog } from "./latency.js";
import { zoneForCountry } from "./zones.js";
import type { Sink } from "../../core/persistence.js";
import { newId } from "../../core/ids.js";
import type { AuditLog } from "../audit/index.js";
import { PermissionError, type IdentityService } from "../identity/index.js";
import type { SpendLedger } from "../model-gateway/routing/ledger.js";
import type { RoutingSettingsStore } from "../model-gateway/routing/settings.js";
import type { AssignOptions, Intake, TaskResult, WorkforceService } from "../workforce/index.js";
import { measuredTaskSeconds, planGpus, type GpuPlan } from "./gpu-plan.js";
import { classifyWork, REAL_TIME_RULES } from "./classify.js";
import { BatchError, DEFAULT_SCHEDULE, formatLocal, mergeSchedule, nextRunAt, type ClientSchedule } from "./schedule.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type Trigger = "schedule" | "size" | "age" | "run_now" | "owner" | "urgent";

/** One piece of queued work and, once it has run, its result. This is the client's filed record of the task. */
export interface BatchJob {
  id: string;
  workspaceId: string;
  userId: string;
  employeeId: string;
  brief: string;
  reason: string;
  status: JobStatus;
  createdAt: string;
  /** The client's next scheduled run when it was queued. */
  runAfter: string;
  /** A failed try waits until here before the next one. */
  notBefore?: string;
  attempts: number;
  estTokens: number;
  lastError?: string;
  finishedAt?: string;
  runId?: string;
  deliverable?: string;
  energyUsed?: number;
}

export interface BatchRunRecord {
  id: string;
  trigger: Trigger;
  startedAt: string;
  finishedAt?: string;
  jobs: number;
  done: number;
  failed: number;
  retried: number;
  clients: number;
  actualMicro: number;
  baselineMicro: number;
  savedMicro: number;
  coldStartSavedMicro: number;
}

export interface BatchDeps {
  identity: IdentityService;
  audit: AuditLog;
  workforce: WorkforceService;
  settings: RoutingSettingsStore;
  ledger: SpendLedger;
  isPlatformOwner: (userId: string) => boolean;
  /** Tells a client something through the Admin manager. */
  notify: (workspaceId: string, text: string, link?: string) => Promise<unknown>;
  /** A queued job ended: its answer (done) or nothing (failed), so the conversation it came from can be updated. Must not throw. */
  ended?: (job: BatchJob, outcome: "done" | "failed", answer?: string) => void;
  now?: () => Date;
}

const MAX_RUNS_KEPT = 200;
const KEEP_FINISHED_DAYS = 30;
const SHOWN_JOBS = 60;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Non-urgent work waits in a queue and goes to the RunPod pod together, so the GPU starts once per batch instead of
 * once per request. A batch runs when a client's schedule says so (after closing by default), when enough work is waiting,
 * when the oldest task has waited too long, or when someone presses Run now. Quick questions never wait: the Admin
 * manager and anything urgent are answered at once, and lookups go to a cheap Claude model that reads the records.
 * One server instance only: the queue lock and tick live in memory.
 */
export class BatchService implements Intake {
  private jobs = new Map<string, BatchJob>();
  private schedules = new Map<string, ClientSchedule>();
  private runs: BatchRunRecord[] = [];
  private running = false;
  private sink?: Sink;
  private now: () => Date;

  constructor(private d: BatchDeps) {
    this.now = d.now ?? (() => new Date());
  }

  useSink(sink: Sink): void { this.sink = sink; }
  restoreJob(j: BatchJob): void {
    // A restart mid-batch leaves jobs "running": put them back in the queue, they were never finished.
    this.jobs.set(j.id, j.status === "running" ? { ...j, status: "queued" } : j);
  }
  restoreSchedule(workspaceId: string, s: ClientSchedule): void { this.schedules.set(workspaceId, s); }
  restoreRun(r: BatchRunRecord): void { this.runs.push(r); this.runs = this.runs.slice(-MAX_RUNS_KEPT); }

  // ---------- intake (called by the workforce) ----------

  route(workspaceId: string, templateKey: string, brief: string, opts: AssignOptions) {
    const s = this.d.settings.get().batch;
    const c = classifyWork({ brief, templateKey, urgent: opts.urgent, when: opts.when, liveByDefault: opts.liveByDefault, liveTemplates: s.liveTemplates });
    if (c.mode === "batch" && (!s.enabled || !this.scheduleOf(workspaceId).enabled)) return { mode: "urgent" as const, reason: "batching is switched off" };
    return { ...c, flushAfter: c.mode === "urgent" && s.flushAfterUrgent && !s.liveTemplates.includes(templateKey) };
  }

  liveDefaults() {
    const { liveDuringTrial, liveFirstTasks } = this.d.settings.get().batch;
    return { liveDuringTrial, liveFirstTasks };
  }

  /** How long clients wait, by kind. Shown to the platform owner. */
  readonly latency = new LatencyLog();
  record(kind: "instant" | "lookup" | "live", ms: number): void { this.latency.record(kind, ms); }

  /** Urgent work just ran on the pod, so send everything that is waiting now, whatever the time. Runs in the background. */
  flush(): void {
    this.current = this.dispatch("urgent").catch((err) => { console.error("batch flush failed:", err instanceof Error ? err.message : err); return undefined; });
  }
  /** Resolves when the batch now running (if any) has finished. */
  async idle(): Promise<void> { await this.current; }
  private current?: Promise<unknown>;

  enqueue(a: { userId: string; workspaceId: string; employeeId: string; brief: string; reason: string; estTokens: number }): { jobId: string; runsAt: string } {
    const runAfter = nextRunAt(this.scheduleOf(a.workspaceId), this.now()).toISOString();
    const job: BatchJob = { id: newId("batchjob"), workspaceId: a.workspaceId, userId: a.userId, employeeId: a.employeeId, brief: a.brief, reason: a.reason, status: "queued", createdAt: this.now().toISOString(), runAfter, attempts: 0, estTokens: a.estTokens };
    this.save(job);
    return { jobId: job.id, runsAt: runAfter };
  }

  queuedFor(workspaceId: string): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.workspaceId === workspaceId && j.status === "queued") n++;
    return n;
  }

  nextRunFor(workspaceId: string): string {
    return nextRunAt(this.scheduleOf(workspaceId), this.now()).toISOString();
  }

  // ---------- client views and controls ----------

  scheduleOf(workspaceId: string): ClientSchedule {
    return this.schedules.get(workspaceId) ?? { ...DEFAULT_SCHEDULE, timezone: zoneForCountry(this.d.workforce.countryOf(workspaceId)) };
  }

  /** Changes when this client's batch runs. Queued tasks move to the new time. */
  setSchedule(userId: string, workspaceId: string, patch: unknown): ClientSchedule {
    this.d.identity.require(userId, workspaceId, "workspace.manage");
    const next = mergeSchedule(this.scheduleOf(workspaceId), patch);
    this.schedules.set(workspaceId, next);
    this.sink?.batchSchedule(workspaceId, next);
    const runAfter = nextRunAt(next, this.now()).toISOString();
    for (const j of this.jobs.values()) if (j.workspaceId === workspaceId && j.status === "queued") this.save({ ...j, runAfter });
    this.d.audit.record({ workspaceId, actor: `user:${userId}`, action: "batch.schedule_set", data: { ...next } });
    return next;
  }

  forClient(userId: string, workspaceId: string) {
    this.d.identity.require(userId, workspaceId, "task.read");
    const s = this.scheduleOf(workspaceId);
    const mine = [...this.jobs.values()].filter((j) => j.workspaceId === workspaceId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const next = nextRunAt(s, this.now());
    return {
      schedule: s,
      nextRunAt: next.toISOString(),
      nextRunLabel: formatLocal(next, s.timezone),
      queued: mine.filter((j) => j.status === "queued").length,
      jobs: mine.slice(0, SHOWN_JOBS).map((j) => ({
        id: j.id, employeeId: j.employeeId, brief: clip(j.brief, 200), status: j.status, createdAt: j.createdAt,
        runsAt: j.status === "queued" ? (j.notBefore && j.notBefore > j.runAfter ? j.notBefore : j.runAfter) : undefined,
        runsAtLabel: j.status === "queued" ? formatLocal(new Date(j.notBefore && j.notBefore > j.runAfter ? j.notBefore : j.runAfter), s.timezone) : undefined,
        attempts: j.attempts, finishedAt: j.finishedAt, deliverable: j.status === "done" ? j.deliverable : undefined,
        problem: j.status === "failed" ? "We could not finish this one. Nothing was charged." : j.status === "queued" && j.attempts > 0 ? "Retrying after a hiccup" : undefined,
      })),
      realTime: REAL_TIME_RULES,
    };
  }

  /** Waiting and running jobs for one client, for the dashboard's board (the caller already checked permission). */
  openJobsOf(workspaceId: string): { id: string; employeeId: string; brief: string; status: JobStatus; runsAt?: string }[] {
    return [...this.jobs.values()]
      .filter((j) => j.workspaceId === workspaceId && (j.status === "queued" || j.status === "running"))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((j) => ({ id: j.id, employeeId: j.employeeId, brief: clip(j.brief, 120), status: j.status, ...(j.status === "queued" ? { runsAt: j.notBefore && j.notBefore > j.runAfter ? j.notBefore : j.runAfter } : {}) }));
  }

  /** Run now: this client's waiting tasks are sent to the pod now (together with anything else already waiting). */
  async runNow(userId: string, workspaceId: string): Promise<BatchRunRecord | undefined> {
    this.d.identity.require(userId, workspaceId, "task.create");
    const nowIso = this.now().toISOString();
    for (const j of this.jobs.values()) if (j.workspaceId === workspaceId && j.status === "queued") this.save({ ...j, runAfter: nowIso, notBefore: undefined });
    this.d.audit.record({ workspaceId, actor: `user:${userId}`, action: "batch.run_now" });
    return this.dispatch("run_now");
  }

  cancel(userId: string, workspaceId: string, jobId: string): void {
    this.d.identity.require(userId, workspaceId, "task.create");
    const j = this.jobs.get(jobId);
    if (!j || j.workspaceId !== workspaceId) throw new BatchError("that task was not found");
    if (j.status !== "queued") throw new BatchError("it already started, so it cannot be cancelled");
    this.save({ ...j, status: "cancelled", finishedAt: this.now().toISOString() });
    this.d.audit.record({ workspaceId, actor: `user:${userId}`, action: "batch.cancelled", target: jobId });
  }

  /** What a cheap live model needs to answer "what's the status": a short digest of the queue and recent filings. Lookups only. */
  contextFor(workspaceId: string, _templateKey: string, taskType?: string): string | undefined {
    if (taskType !== "live") return undefined;
    const mine = [...this.jobs.values()].filter((j) => j.workspaceId === workspaceId);
    if (!mine.length) return undefined;
    const s = this.scheduleOf(workspaceId);
    const line = (j: BatchJob) => `- ${clip(j.brief, 80)} (${j.status}${j.finishedAt ? ` ${formatLocal(new Date(j.finishedAt), s.timezone)}` : ""})`;
    const queued = mine.filter((j) => j.status === "queued");
    const recent = mine.filter((j) => j.status !== "queued" && j.status !== "cancelled").sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? "")).slice(0, 8);
    return [
      `Work records (current): ${queued.length} task(s) waiting for the next batch, which runs ${formatLocal(nextRunAt(s, this.now()), s.timezone)}.`,
      ...queued.slice(0, 8).map(line),
      recent.length ? "Recently filed:" : "",
      ...recent.map(line),
      "Answer only from these records and the business profile. If the answer is not here, say so.",
    ].filter(Boolean).join("\n");
  }

  // ---------- platform owner ----------

  ownerView(userId: string) {
    if (!this.d.isPlatformOwner(userId)) throw new PermissionError("only the platform owner sees the batch queue");
    const queued = [...this.jobs.values()].filter((j) => j.status === "queued");
    const byClient = new Map<string, BatchJob[]>();
    for (const j of queued) (byClient.get(j.workspaceId) ?? byClient.set(j.workspaceId, []).get(j.workspaceId)!).push(j);
    const nowMs = this.now().getTime();
    const oldest = queued.reduce((m, j) => Math.min(m, Date.parse(j.createdAt)), Infinity);
    return {
      queued: queued.length,
      running: [...this.jobs.values()].filter((j) => j.status === "running").length,
      estTokens: queued.reduce((n, j) => n + j.estTokens, 0),
      oldestMinutes: Number.isFinite(oldest) ? Math.round((nowMs - oldest) / 60_000) : 0,
      nextDueAt: queued.length ? new Date(Math.min(...queued.map((j) => Date.parse(j.runAfter)))).toISOString() : null,
      byClient: [...byClient.entries()].map(([id, js]) => ({ id, name: this.d.identity.workspaceById(id)?.name ?? id, queued: js.length, nextAt: new Date(Math.min(...js.map((j) => Date.parse(j.runAfter)))).toISOString() })),
      runs: [...this.runs].reverse().slice(0, 30),
      settings: this.d.settings.get().batch,
      gpuPlan: this.gpuPlan(queued.length),
      realTime: REAL_TIME_RULES,
      latency: this.latency.summary(),
    };
  }

  /** The number and size of GPUs the tasks waiting need before morning, next to what is set now. */
  gpuPlan(pending: number): GpuPlan {
    const cfg = this.d.settings.get();
    const b = cfg.batch;
    return planGpus({
      pending,
      taskSeconds: measuredTaskSeconds(this.runs, b.gpuWorkers * b.concurrency),
      concurrencyPerGpu: b.concurrency,
      windowHours: b.windowHours,
      model: cfg.runpod.model,
      current: { gpus: b.gpuWorkers, sizeGb: b.gpuSizeGb },
      currentUsdPerSecond: cfg.runpod.gpuUsdPerSecond,
    });
  }

  async runAllNow(userId: string): Promise<BatchRunRecord | undefined> {
    if (!this.d.isPlatformOwner(userId)) throw new PermissionError("only the platform owner can start a batch");
    return this.dispatch("owner");
  }

  // ---------- the dispatcher ----------

  /** Call every minute. Starts a batch when one is due; does nothing otherwise. Never throws. */
  async tick(): Promise<BatchRunRecord | undefined> {
    try {
      this.prune();
      const trigger = this.dueTrigger();
      return trigger ? await this.dispatch(trigger) : undefined;
    } catch (err) {
      console.error("batch tick failed:", err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  private ready(): BatchJob[] {
    const nowIso = this.now().toISOString();
    return [...this.jobs.values()].filter((j) => j.status === "queued" && (!j.notBefore || j.notBefore <= nowIso));
  }

  private dueTrigger(): Trigger | undefined {
    const s = this.d.settings.get().batch;
    if (!s.enabled) return undefined;
    const ready = this.ready();
    if (!ready.length) return undefined;
    const nowIso = this.now().toISOString();
    if (ready.some((j) => j.runAfter <= nowIso)) return "schedule";
    if (ready.length >= s.sizeTrigger || ready.reduce((n, j) => n + j.estTokens, 0) >= s.tokenTrigger) return "size";
    const cutoff = new Date(this.now().getTime() - s.maxQueueAgeHours * 3_600_000).toISOString();
    if (ready.some((j) => j.createdAt <= cutoff)) return "age";
    return undefined;
  }

  /**
   * One batch: every ready task from every client goes to the pod in one go (the pod starts once), answers are read by
   * Claude on a sample, results are filed into each client's records, and each client hears once.
   */
  private async dispatch(trigger: Trigger): Promise<BatchRunRecord | undefined> {
    if (this.running) return undefined;
    const batch = fairOrder(this.ready());
    if (!batch.length) return undefined;
    this.running = true;
    const started = this.now();
    const run: BatchRunRecord = { id: newId("batchrun"), trigger, startedAt: started.toISOString(), jobs: batch.length, done: 0, failed: 0, retried: 0, clients: 0, actualMicro: 0, baselineMicro: 0, savedMicro: 0, coldStartSavedMicro: 0 };
    try {
      for (const j of batch) this.save({ ...j, status: "running", runId: run.id });
      const finished = new Map<string, { done: number; failed: number }>();
      const bs = this.d.settings.get().batch;
      await pool(batch, bs.gpuWorkers * bs.concurrency, async (j) => {
        const outcome = await this.runJob(j.id, run);
        if (outcome) { const c = finished.get(j.workspaceId) ?? { done: 0, failed: 0 }; c[outcome]++; finished.set(j.workspaceId, c); }
      });
      run.clients = finished.size;
      run.savedMicro = run.baselineMicro - run.actualMicro;
      const cfg = this.d.settings.get();
      run.coldStartSavedMicro = Math.round(Math.max(0, run.done - 1) * cfg.batch.coldStartSeconds * cfg.runpod.gpuUsdPerSecond * 1_000_000);
      run.finishedAt = this.now().toISOString();
      this.d.ledger.recordBatchRun(run.coldStartSavedMicro);
      this.runs.push(run);
      this.runs = this.runs.slice(-MAX_RUNS_KEPT);
      this.sink?.batchRun(run);
      await Promise.all([...finished].map(([ws, c]) => this.tellClient(ws, c)));
      return run;
    } finally {
      this.running = false;
    }
  }

  /** Runs one job and files the result. Returns whether it ended (done/failed), or undefined when it will be retried. */
  private async runJob(id: string, run: BatchRunRecord): Promise<"done" | "failed" | undefined> {
    const job = this.jobs.get(id)!;
    const cfg = this.d.settings.get().batch;
    const last = job.attempts + 1 >= cfg.maxAttempts;
    let task: Pick<TaskResult, "status" | "deliverable" | "energyUsed" | "costMicro" | "baselineMicro" | "failure" | "reason">;
    try {
      task = await this.d.workforce.runQueued(job, { allowClaudeFallback: cfg.claudeAfterFailures && last });
    } catch (err) {
      task = { status: "failed", failure: err instanceof Error ? err.message : String(err) };
    }
    const at = this.now().toISOString();
    if (task.status === "ready_for_review") {
      this.save({ ...job, status: "done", finishedAt: at, deliverable: task.deliverable, energyUsed: task.energyUsed, attempts: job.attempts + 1, lastError: undefined, notBefore: undefined });
      this.latency.record("batch_wait", new Date(at).getTime() - new Date(job.createdAt).getTime());
      run.done++; run.actualMicro += task.costMicro ?? 0; run.baselineMicro += task.baselineMicro ?? 0;
      this.d.audit.record({ workspaceId: job.workspaceId, actor: `employee:${job.employeeId}`, action: "batch.filed", target: job.id, data: { runId: run.id } });
      this.d.ended?.(job, "done", task.deliverable);
      return "done";
    }
    if (task.status === "no_energy" || last) {
      this.save({ ...job, status: "failed", finishedAt: at, attempts: job.attempts + 1, lastError: task.status === "no_energy" ? `no energy (${task.reason ?? "unknown"})` : task.failure });
      run.failed++;
      this.d.audit.record({ workspaceId: job.workspaceId, actor: "system", action: "batch.failed", target: job.id, data: { runId: run.id, error: task.status === "no_energy" ? task.reason : task.failure } });
      this.d.ended?.(job, "failed");
      return "failed";
    }
    const wait = cfg.retryBackoffMinutes * (job.attempts + 1) * 60_000;
    this.save({ ...job, status: "queued", attempts: job.attempts + 1, lastError: task.failure, notBefore: new Date(this.now().getTime() + wait).toISOString() });
    run.retried++;
    return undefined;
  }

  private async tellClient(workspaceId: string, c: { done: number; failed: number }): Promise<void> {
    const parts: string[] = [];
    if (c.done) parts.push(`${c.done} task${c.done === 1 ? "" : "s"} finished and filed for you to review`);
    if (c.failed) parts.push(`${c.failed} could not be finished (nothing was charged)`);
    await this.d.notify(workspaceId, `Today's batch is done: ${parts.join("; ")}.`, "/app.html#work").catch((e) => console.error("batch notice failed:", e instanceof Error ? e.message : e));
  }

  private prune(): void {
    const cutoff = new Date(this.now().getTime() - KEEP_FINISHED_DAYS * 86_400_000).toISOString();
    for (const [id, j] of this.jobs) if ((j.status === "done" || j.status === "failed" || j.status === "cancelled") && (j.finishedAt ?? j.createdAt) < cutoff) this.jobs.delete(id);
  }

  private save(job: BatchJob): void {
    this.jobs.set(job.id, job);
    this.sink?.batchJob(job);
  }
}

/**
 * Takes one task from each client in turn (oldest first within a client), so one client with hundreds of tasks
 * cannot make every other client wait behind all of them.
 */
export function fairOrder(jobs: BatchJob[]): BatchJob[] {
  const byClient = new Map<string, BatchJob[]>();
  for (const j of [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) (byClient.get(j.workspaceId) ?? byClient.set(j.workspaceId, []).get(j.workspaceId)!).push(j);
  const lanes = [...byClient.values()];
  const out: BatchJob[] = [];
  for (let i = 0; out.length < jobs.length; i++) for (const lane of lanes) if (lane[i]) out.push(lane[i]!);
  return out;
}

/** Runs fn over items, at most `limit` at once. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]!); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
