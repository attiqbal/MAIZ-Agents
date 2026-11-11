/**
 * Overnight GPU plan. The batch runs on a fixed number of GPUs of one size (set by the platform owner), so the
 * night's cost is known up front. This turns the tasks waiting and the hours before morning into a recommended
 * number and size of GPUs, and says whether the current setting is enough.
 */
export type GpuSizeGb = 24 | 48 | 80;
export const GPU_SIZES: readonly GpuSizeGb[] = [24, 48, 80];

/**
 * Approximate RunPod Serverless price per active GPU-second by memory size. These are planning figures:
 * the invoice is the truth, and the owner can edit the price they actually pay in the AI settings.
 */
export const GPU_USD_PER_SECOND: Record<GpuSizeGb, number> = { 24: 0.00019, 48: 0.00034, 80: 0.00076 };
export const MAX_GPUS = 16;
/** Seconds one task takes when no batch has run yet (a drafted document on a 14B model). */
export const DEFAULT_TASK_SECONDS = 30;

export interface PlanInput {
  /** Tasks waiting now. */
  pending: number;
  /** Seconds one task takes on one slot of one GPU. */
  taskSeconds: number;
  /** Tasks one GPU serves at once (continuous batching). */
  concurrencyPerGpu: number;
  /** Hours from the start of the run until the results must be in (the overnight window). */
  windowHours: number;
  /** The model the pod serves, for example "Qwen/Qwen3-14B". Decides the smallest GPU that holds it. */
  model: string;
  /** What the owner has set now. */
  current: { gpus: number; sizeGb: GpuSizeGb };
  /** Price per GPU-second of the current size, if the owner has set their own. */
  currentUsdPerSecond?: number;
}

export interface GpuPlan {
  pending: number;
  taskSeconds: number;
  windowHours: number;
  /** Smallest GPU size that holds the model. */
  sizeGb: GpuSizeGb;
  /** GPUs needed to finish inside the window. */
  gpus: number;
  /** Hours the run takes on that many GPUs. */
  runHours: number;
  /** Estimated cost of the run in US dollars. */
  costUsd: number;
  current: { gpus: number; sizeGb: GpuSizeGb; runHours: number; costUsd: number; finishesInWindow: boolean };
  /** One plain sentence for the owner. */
  advice: string;
}

/** Smallest GPU memory size that holds a model, from the size in its name (14B, 32B, ...). Unknown names get 48 GB. */
export function sizeForModel(model: string): GpuSizeGb {
  const b = /(\d+(?:\.\d+)?)\s*b(?![a-z])/i.exec(model);
  if (!b) return 48;
  const billions = Number(b[1]);
  if (billions <= 9) return 24;
  if (billions <= 20) return 48;
  return 80;
}

/** Seconds a task takes, measured from finished runs (run length x slots / tasks); falls back to a default. */
export function measuredTaskSeconds(runs: { startedAt: string; finishedAt?: string; done: number; failed: number }[], concurrency: number): number {
  const recent = runs.filter((r) => r.finishedAt && r.done + r.failed > 0).slice(-10);
  const jobs = recent.reduce((n, r) => n + r.done + r.failed, 0);
  if (!jobs) return DEFAULT_TASK_SECONDS;
  const seconds = recent.reduce((n, r) => n + (Date.parse(r.finishedAt!) - Date.parse(r.startedAt)) / 1000, 0);
  return Math.max(1, Math.round((seconds * Math.max(1, concurrency)) / jobs));
}

const hoursFor = (pending: number, taskSeconds: number, slots: number): number => (pending * taskSeconds) / Math.max(1, slots) / 3600;

export function planGpus(i: PlanInput): GpuPlan {
  const sizeGb = sizeForModel(i.model);
  const windowHours = Math.max(0.5, i.windowHours);
  const concurrency = Math.max(1, i.concurrencyPerGpu);
  const wanted = i.pending === 0 ? 1 : Math.ceil(hoursFor(i.pending, i.taskSeconds, concurrency) / windowHours);
  const gpus = Math.min(MAX_GPUS, Math.max(1, wanted));
  const runHours = hoursFor(i.pending, i.taskSeconds, gpus * concurrency);
  const price = GPU_USD_PER_SECOND[sizeGb];
  // GPUs bill while they work, so cost follows the work, not the number of GPUs.
  const costUsd = i.pending * i.taskSeconds * price / concurrency;
  const curHours = hoursFor(i.pending, i.taskSeconds, i.current.gpus * concurrency);
  const curPrice = i.currentUsdPerSecond ?? GPU_USD_PER_SECOND[i.current.sizeGb];
  const current = { ...i.current, runHours: curHours, costUsd: (i.pending * i.taskSeconds * curPrice) / concurrency, finishesInWindow: curHours <= windowHours };
  const advice = i.pending === 0
    ? "Nothing is waiting, so one GPU is plenty."
    : i.current.gpus === gpus && i.current.sizeGb === sizeGb
      ? `${gpus} x ${sizeGb} GB is right for tonight's ${i.pending} tasks.`
      : !current.finishesInWindow
        ? `${i.current.gpus} GPU${i.current.gpus === 1 ? "" : "s"} would take ${curHours.toFixed(1)} hours for ${i.pending} tasks, past your ${windowHours}-hour window. Use ${gpus} x ${sizeGb} GB.`
        : i.current.sizeGb !== sizeGb
          ? `${i.current.gpus} GPU${i.current.gpus === 1 ? "" : "s"} is enough for ${i.pending} tasks, but your model needs ${sizeGb} GB cards (you have ${i.current.sizeGb} GB).`
          : `${i.current.gpus} GPUs is more than ${i.pending} tasks need; ${gpus} would finish inside the window.`;
  return { pending: i.pending, taskSeconds: i.taskSeconds, windowHours, sizeGb, gpus, runHours, costUsd, current, advice };
}
