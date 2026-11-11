/**
 * How long clients actually wait, by kind of request, so the speed targets can be checked against real numbers
 * instead of guesses. Kept in memory (a rolling window per kind); it is a gauge, not a record, and starts empty
 * after a restart.
 *
 *  - instant:    answered from the client's own records with no model call
 *  - lookup:     a quick question answered by a cheap model
 *  - live:       urgent or chosen-now work answered by RunPod (or Claude covering it)
 *  - batch_wait: from the moment a task was queued until its answer was filed
 */
export type LatencyKind = "instant" | "lookup" | "live" | "batch_wait";
export const LATENCY_KINDS: readonly LatencyKind[] = ["instant", "lookup", "live", "batch_wait"];

/** What each kind should stay under at the 95th percentile (milliseconds), from the plan. */
export const LATENCY_TARGET_MS: Record<LatencyKind, number> = { instant: 100, lookup: 5_000, live: 30_000, batch_wait: 12 * 3_600_000 };

const WINDOW = 500;

export interface LatencyStat { kind: LatencyKind; count: number; p50Ms: number | null; p95Ms: number | null; targetMs: number; overTarget: boolean }
export interface LatencySummary { stats: LatencyStat[]; total: number; liveShare: number | null }

export class LatencyLog {
  private samples = new Map<LatencyKind, number[]>();
  private counts = new Map<LatencyKind, number>();

  record(kind: LatencyKind, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const list = this.samples.get(kind) ?? [];
    list.push(ms);
    if (list.length > WINDOW) list.shift();
    this.samples.set(kind, list);
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
  }

  summary(): LatencySummary {
    const stats = LATENCY_KINDS.map((kind): LatencyStat => {
      const sorted = [...(this.samples.get(kind) ?? [])].sort((a, b) => a - b);
      const p95 = pick(sorted, 0.95);
      return { kind, count: this.counts.get(kind) ?? 0, p50Ms: pick(sorted, 0.5), p95Ms: p95, targetMs: LATENCY_TARGET_MS[kind], overTarget: p95 !== null && p95 > LATENCY_TARGET_MS[kind] };
    });
    const n = (k: LatencyKind) => this.counts.get(k) ?? 0;
    const model = n("lookup") + n("live") + n("batch_wait");
    // Share of model-answered work that did not wait for a batch. High values mean the batch saving is shrinking.
    return { stats, total: stats.reduce((t, s) => t + s.count, 0), liveShare: model === 0 ? null : Math.round(((n("lookup") + n("live")) / model) * 100) / 100 };
  }
}

function pick(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!);
}
