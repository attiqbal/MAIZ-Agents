import type { Sink } from "../../../core/persistence.js";

export interface PolicyDay {
  calls: number;
  runpodMicro: number;
  claudeMicro: number;
  baselineMicro: number;
  escalations: number;
  reviewFails: number;
}

/** One day of AI routing numbers. Small and additive, so it can be saved as one row and rebuilt on restart. */
export interface AiDay {
  day: string;
  calls: number;
  cacheHits: number;
  /** Answers that came from RunPod (including ones later redone on Claude). */
  runpodCalls: number;
  claudeDirect: number;
  /** Work that wanted RunPod but ran on Claude because RunPod was down, slow, capped or paused. */
  fallbacks: number;
  reviews: number;
  reviewFails: number;
  reviewErrors: number;
  escalations: number;
  /** Answers kept although below the threshold because Claude was capped. */
  lowConfidence: number;
  /** Requests refused because a budget was reached. */
  budgetRefused: number;
  failures: number;
  runpodMicro: number;
  claudeMicro: number;
  /** What the same answers would have cost on the Claude-only baseline. Cache hits are left out of both sides. */
  baselineMicro: number;
  /** Cost the cache avoided (at the baseline model's price). Shown separately: a Claude-only setup could cache too. */
  cacheSavedMicro: number;
  runpodSeconds: number;
  /** Batch system: tasks run in batches, batches run, and the same tasks priced both ways. */
  batchJobs: number;
  batchRuns: number;
  batchActualMicro: number;
  batchBaselineMicro: number;
  /** Estimate: tasks that shared a worker start instead of waking one each, priced at the GPU rate. */
  coldStartSavedMicro: number;
  byPolicy: Record<string, PolicyDay>;
  claudeByWorkspace: Record<string, number>;
}

export const emptyDay = (day: string): AiDay => ({
  day, calls: 0, cacheHits: 0, runpodCalls: 0, claudeDirect: 0, fallbacks: 0, reviews: 0, reviewFails: 0, reviewErrors: 0,
  escalations: 0, lowConfidence: 0, budgetRefused: 0, failures: 0, runpodMicro: 0, claudeMicro: 0, baselineMicro: 0,
  cacheSavedMicro: 0, runpodSeconds: 0, batchJobs: 0, batchRuns: 0, batchActualMicro: 0, batchBaselineMicro: 0, coldStartSavedMicro: 0, byPolicy: {}, claudeByWorkspace: {},
});

/** What one request did, added to the day's totals. */
export interface CallRecord {
  workspaceId: string;
  policy: string;
  cacheHit?: boolean;
  runpodServed?: boolean;
  claudeDirect?: boolean;
  fallback?: boolean;
  reviewed?: boolean;
  reviewFailed?: boolean;
  reviewError?: boolean;
  escalated?: boolean;
  lowConfidence?: boolean;
  budgetRefused?: boolean;
  failed?: boolean;
  runpodMicro: number;
  claudeMicro: number;
  baselineMicro: number;
  cacheSavedMicro?: number;
  runpodSeconds?: number;
  batch?: boolean;
}

export interface Totals {
  calls: number; cacheHits: number; runpodCalls: number; claudeDirect: number; fallbacks: number; reviews: number; reviewFails: number;
  reviewErrors: number; escalations: number; lowConfidence: number; budgetRefused: number; failures: number;
  runpodMicro: number; claudeMicro: number; baselineMicro: number; cacheSavedMicro: number; runpodSeconds: number;
  batchJobs: number; batchRuns: number; batchActualMicro: number; batchBaselineMicro: number; coldStartSavedMicro: number;
}

const COUNTERS = ["calls", "cacheHits", "runpodCalls", "claudeDirect", "fallbacks", "reviews", "reviewFails", "reviewErrors", "escalations", "lowConfidence", "budgetRefused", "failures", "runpodMicro", "claudeMicro", "baselineMicro", "cacheSavedMicro", "runpodSeconds", "batchJobs", "batchRuns", "batchActualMicro", "batchBaselineMicro", "coldStartSavedMicro"] as const;

/** Spend and savings, by day. The routing gateway asks it about caps and writes every call into it. */
export class SpendLedger {
  private days = new Map<string, AiDay>();
  private sink?: Sink;
  constructor(private now: () => Date = () => new Date()) {}

  useSink(sink: Sink): void { this.sink = sink; }
  restore(d: AiDay): void { this.days.set(d.day, { ...emptyDay(d.day), ...d }); }

  private today(): string { return this.now().toISOString().slice(0, 10); }

  record(r: CallRecord): void {
    const day = this.today();
    const d = this.days.get(day) ?? emptyDay(day);
    this.days.set(day, d);
    d.calls++;
    if (r.cacheHit) { d.cacheHits++; d.cacheSavedMicro += r.cacheSavedMicro ?? 0; }
    if (r.runpodServed) d.runpodCalls++;
    if (r.claudeDirect) d.claudeDirect++;
    if (r.fallback) d.fallbacks++;
    if (r.reviewed) d.reviews++;
    if (r.reviewFailed) d.reviewFails++;
    if (r.reviewError) d.reviewErrors++;
    if (r.escalated) d.escalations++;
    if (r.lowConfidence) d.lowConfidence++;
    if (r.budgetRefused) d.budgetRefused++;
    if (r.failed) d.failures++;
    d.runpodMicro += r.runpodMicro;
    d.claudeMicro += r.claudeMicro;
    d.baselineMicro += r.baselineMicro;
    d.runpodSeconds += r.runpodSeconds ?? 0;
    if (r.batch) { d.batchJobs++; d.batchActualMicro += r.runpodMicro + r.claudeMicro; d.batchBaselineMicro += r.baselineMicro; }
    const p = (d.byPolicy[r.policy] ??= { calls: 0, runpodMicro: 0, claudeMicro: 0, baselineMicro: 0, escalations: 0, reviewFails: 0 });
    p.calls++;
    p.runpodMicro += r.runpodMicro;
    p.claudeMicro += r.claudeMicro;
    p.baselineMicro += r.baselineMicro;
    if (r.escalated) p.escalations++;
    if (r.reviewFailed) p.reviewFails++;
    if (r.claudeMicro > 0) d.claudeByWorkspace[r.workspaceId] = (d.claudeByWorkspace[r.workspaceId] ?? 0) + r.claudeMicro;
    this.sink?.aiDay(structuredClone(d));
  }

  /** One batch finished: counts the run and the estimated cold starts the batch saved. */
  recordBatchRun(coldStartSavedMicro: number): void {
    const day = this.today();
    const d = this.days.get(day) ?? emptyDay(day);
    this.days.set(day, d);
    d.batchRuns++;
    d.coldStartSavedMicro += coldStartSavedMicro;
    this.sink?.aiDay(structuredClone(d));
  }

  claudeToday(): number { return this.days.get(this.today())?.claudeMicro ?? 0; }

  private monthDays(month = this.today().slice(0, 7)): AiDay[] {
    return [...this.days.values()].filter((d) => d.day.startsWith(month));
  }
  claudeMonth(): number { return this.monthDays().reduce((n, d) => n + d.claudeMicro, 0); }
  runpodMonth(): number { return this.monthDays().reduce((n, d) => n + d.runpodMicro, 0); }
  claudeMonthFor(workspaceId: string): number { return this.monthDays().reduce((n, d) => n + (d.claudeByWorkspace[workspaceId] ?? 0), 0); }

  totals(days: AiDay[]): Totals {
    const t = Object.fromEntries(COUNTERS.map((k) => [k, 0])) as unknown as Totals;
    for (const d of days) for (const k of COUNTERS) t[k] += d[k];
    return t;
  }

  /** Month so far, the last N days, and per-policy numbers for the owner's page. */
  summary(lastDays = 30) {
    const sorted = [...this.days.values()].sort((a, b) => a.day.localeCompare(b.day));
    const month = this.monthDays();
    const byPolicy: Record<string, PolicyDay> = {};
    for (const d of month) for (const [k, p] of Object.entries(d.byPolicy)) {
      const t = (byPolicy[k] ??= { calls: 0, runpodMicro: 0, claudeMicro: 0, baselineMicro: 0, escalations: 0, reviewFails: 0 });
      t.calls += p.calls; t.runpodMicro += p.runpodMicro; t.claudeMicro += p.claudeMicro; t.baselineMicro += p.baselineMicro; t.escalations += p.escalations; t.reviewFails += p.reviewFails;
    }
    return {
      month: this.totals(month),
      today: this.totals(this.days.get(this.today()) ? [this.days.get(this.today())!] : []),
      claudeMonthMicro: this.claudeMonth(),
      claudeTodayMicro: this.claudeToday(),
      runpodMonthMicro: this.runpodMonth(),
      byPolicy,
      days: sorted.slice(-lastDays).map(({ claudeByWorkspace: _w, ...rest }) => rest),
    };
  }
}
