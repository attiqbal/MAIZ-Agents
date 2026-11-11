import type { Sink } from "../../../core/persistence.js";

/**
 * Everything the platform owner can tune about AI routing. Model names, prices, thresholds and caps are
 * data, not code, so they change from the owner's AI spend page without a deploy. Secrets (API keys,
 * RunPod endpoint id) are never here: they come from environment variables.
 */

/** Micro-dollars (1e-6 USD) per 1,000 tokens. */
export interface ModelPrice { inputPer1k: number; outputPer1k: number }

export interface PolicySettings {
  /** Where the first attempt goes. "claude" is for work that must not run on an open model. */
  primary: "runpod" | "claude";
  /** Claude model used when primary is "claude" and when RunPod cannot be used. */
  claudeModel: string;
  /** The model the savings are measured against: what this work would cost with Claude only. */
  baselineModel: string;
  /** Share of RunPod answers that Claude checks, 0 to 1. Suspicious answers are always checked. */
  reviewRate: number;
  /** Quality score (1 to 10) below which the answer is redone on Claude. */
  minScore: number;
  escalate: boolean;
  escalationModel: string;
  /** Use Claude when RunPod is down, too slow or over its budget. */
  fallbackToClaude: boolean;
  /** May this work be done by the open model when Claude is over budget? Off for regulated work. */
  allowOpenModel: boolean;
  cache: boolean;
}

export interface BatchSettings {
  enabled: boolean;
  /** Run a batch as soon as this many tasks are waiting (all clients together). */
  sizeTrigger: number;
  /** ...or when their estimated tokens reach this. */
  tokenTrigger: number;
  /** A task never waits longer than this many hours, whatever the schedule says. */
  maxQueueAgeHours: number;
  /** Tasks each GPU serves at the same time. The pod's continuous batching serves them from one warm worker. */
  concurrency: number;
  /** How many GPUs the batch runs on. Fixed, so the night's cost is known; the plan on the owner page recommends a number. */
  gpuWorkers: number;
  /** Memory size of each GPU in GB: 24, 48 or 80. */
  gpuSizeGb: 24 | 48 | 80;
  /** Hours the overnight run has to finish in, from the clients' closing time to the morning. */
  windowHours: number;
  /** After this many failed tries the task is marked failed and the client is told. */
  maxAttempts: number;
  retryBackoffMinutes: number;
  /** Claude reads at least this share of batch answers: nobody is watching them run. */
  qaRateMin: number;
  /** On the last try, let Claude do the task if RunPod keeps failing, so it is not lost. */
  claudeAfterFailures: boolean;
  /** Used only for the savings estimate: seconds a worker takes to start. */
  coldStartSeconds: number;
  /** Employee templates whose work is never queued (always answered at once). */
  /** After urgent work runs, send everything waiting to the pod too. */
  flushAfterUrgent: boolean;
  /** Answer ordinary work at once (not in a batch) while a client is on a free trial, so first impressions are quick. */
  liveDuringTrial: boolean;
  /** ...and for a client's first this many finished tasks, whatever the plan. 0 switches it off. */
  liveFirstTasks: number;
  liveTemplates: string[];
}

export interface AiRoutingSettings {
  runpod: {
    enabled: boolean;
    /** The model name the RunPod vLLM worker serves, for example a Qwen model. */
    model: string;
    /** "seconds" bills measured GPU time at gpuUsdPerSecond; "tokens" bills tokens at the price below. */
    billing: "seconds" | "tokens";
    gpuUsdPerSecond: number;
    tokenPrice: ModelPrice;
    /** After this long without an answer (usually a cold start) the request moves to Claude if allowed. */
    softDeadlineMs: number;
    /** The longest a request may wait when there is no Claude fallback. */
    hardTimeoutMs: number;
    attempts: number;
    /** Consecutive failures that stop sending work to RunPod for a while. */
    breakerFailures: number;
    breakerCooldownMs: number;
  };
  reviewer: {
    enabled: boolean;
    model: string;
    /** Longest text sent to the reviewer, in characters, to cap its cost. */
    maxInputChars: number;
    /** Check more often while recent answers keep failing. */
    adaptive: boolean;
  };
  cache: { enabled: boolean; ttlSeconds: number; maxEntries: number };
  budgets: {
    /** US dollars. null means no cap. */
    claudeDailyUsd: number | null;
    claudeMonthlyUsd: number | null;
    claudePerWorkspaceMonthlyUsd: number | null;
    runpodMonthlyUsd: number | null;
    /** When a Claude cap is reached: "degrade" keeps serving from RunPod unchecked, "fail" stops claude-only work. */
    whenClaudeCapped: "degrade" | "fail";
  };
  /** Batch system: non-urgent work is queued and sent to the pod together. */
  batch: BatchSettings;
  /** Claude (and any other) model prices, by model name. */
  prices: Record<string, ModelPrice>;
  /** Keyed by "standard", "premium" or an employee template key. */
  policies: Record<string, PolicySettings>;
}

const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";

export const DEFAULT_PRICES_BY_MODEL: Record<string, ModelPrice> = {
  "claude-haiku-5-5": { inputPer1k: 100, outputPer1k: 500 },
  "claude-sonnet-5-5": { inputPer1k: 2_000, outputPer1k: 10_000 },
  "claude-opus-5-5": { inputPer1k: 4_000, outputPer1k: 20_000 },
};
/** Used for a model with no price entry, so unknown models are never counted as free. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { inputPer1k: 4_000, outputPer1k: 20_000 };

export const DEFAULT_BATCH: BatchSettings = {
  enabled: true, sizeTrigger: 20, tokenTrigger: 200_000, maxQueueAgeHours: 24, concurrency: 6, gpuWorkers: 1, gpuSizeGb: 48, windowHours: 10, maxAttempts: 3, retryBackoffMinutes: 15,
  qaRateMin: 0.3, claudeAfterFailures: true, coldStartSeconds: 40, flushAfterUrgent: true, liveDuringTrial: true, liveFirstTasks: 20, liveTemplates: ["admin-manager"],
};

export function defaultSettings(claudeDirectModel: string = HAIKU): AiRoutingSettings {
  const standard: PolicySettings = {
    primary: "runpod", claudeModel: claudeDirectModel, baselineModel: claudeDirectModel,
    reviewRate: 0.15, minScore: 7, escalate: true, escalationModel: SONNET, fallbackToClaude: true, allowOpenModel: true, cache: true,
  };
  return {
    runpod: {
      enabled: true,
      model: "Qwen/Qwen3-30B-A3B-Instruct-2507",
      billing: "seconds",
      gpuUsdPerSecond: 0.00034,
      tokenPrice: { inputPer1k: 60, outputPer1k: 250 },
      softDeadlineMs: 20_000,
      hardTimeoutMs: 120_000,
      attempts: 2,
      breakerFailures: 3,
      breakerCooldownMs: 60_000,
    },
    reviewer: { enabled: true, model: HAIKU, maxInputChars: 12_000, adaptive: true },
    cache: { enabled: true, ttlSeconds: 3_600, maxEntries: 500 },
    budgets: { claudeDailyUsd: 15, claudeMonthlyUsd: 200, claudePerWorkspaceMonthlyUsd: 20, runpodMonthlyUsd: 300, whenClaudeCapped: "degrade" },
    batch: structuredClone(DEFAULT_BATCH),
    prices: structuredClone(DEFAULT_PRICES_BY_MODEL),
    policies: {
      standard,
      premium: { ...standard, claudeModel: SONNET, baselineModel: SONNET, reviewRate: 0.5, minScore: 8 },
      // Quick lookups through the day ("what's the status", "who is on the rota"): a cheap Claude model reading the records.
      live: { ...standard, primary: "claude", reviewRate: 0, escalate: false, fallbackToClaude: false, allowOpenModel: false },
      // Regulated work stays on Claude by default. Change it here if the open model proves good enough.
      "compliance-manager": { ...standard, primary: "claude", claudeModel: SONNET, baselineModel: SONNET, reviewRate: 0, escalate: false, fallbackToClaude: false, allowOpenModel: false },
    },
  };
}

export class SettingsError extends Error {}

const MODEL_NAME = /^(?!__proto__$|constructor$|prototype$)[\w.\-/:]{1,120}$/;
const POLICY_KEY = /^[a-z0-9][a-z0-9-]{0,60}$/;

const num = (v: unknown, label: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new SettingsError(`${label} must be a number from ${min} to ${max}`);
  return v;
};
const cap = (v: unknown, label: string): number | null => (v === null ? null : num(v, label, 0, 1_000_000));
const bool = (v: unknown, label: string): boolean => { if (typeof v !== "boolean") throw new SettingsError(`${label} must be true or false`); return v; };
const model = (v: unknown, label: string): string => { if (typeof v !== "string" || !MODEL_NAME.test(v)) throw new SettingsError(`${label} must be a model name`); return v; };
const price = (v: unknown, label: string): ModelPrice => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { inputPer1k: num(o.inputPer1k, `${label} input price`, 0, 1_000_000), outputPer1k: num(o.outputPer1k, `${label} output price`, 0, 1_000_000) };
};
const oneOf = <T extends string>(v: unknown, label: string, allowed: readonly T[]): T => {
  if (!allowed.includes(v as T)) throw new SettingsError(`${label} must be one of ${allowed.join(", ")}`);
  return v as T;
};
const obj = (v: unknown, label: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SettingsError(`${label} must be an object`);
  return v as Record<string, unknown>;
};

function validPolicy(v: unknown, label: string): PolicySettings {
  const o = obj(v, label);
  return {
    primary: oneOf(o.primary, `${label} primary`, ["runpod", "claude"]),
    claudeModel: model(o.claudeModel, `${label} Claude model`),
    baselineModel: model(o.baselineModel, `${label} baseline model`),
    reviewRate: num(o.reviewRate, `${label} review rate`, 0, 1),
    minScore: num(o.minScore, `${label} minimum score`, 1, 10),
    escalate: bool(o.escalate, `${label} escalate`),
    escalationModel: model(o.escalationModel, `${label} escalation model`),
    fallbackToClaude: bool(o.fallbackToClaude, `${label} fallback`),
    allowOpenModel: bool(o.allowOpenModel, `${label} allow open model`),
    cache: bool(o.cache, `${label} cache`),
  };
}

/** Checks a complete settings object. Throws SettingsError naming the first bad field. */
export function validateSettings(v: unknown): AiRoutingSettings {
  const o = obj(v, "settings");
  const r = obj(o.runpod, "runpod");
  const rv = obj(o.reviewer, "reviewer");
  const c = obj(o.cache, "cache");
  const b = obj(o.budgets, "budgets");
  const pr = obj(o.prices, "prices");
  const bt = (o.batch === undefined ? DEFAULT_BATCH : obj(o.batch, "batch")) as unknown as Record<string, unknown>;
  const po = obj(o.policies, "policies");
  const policies: Record<string, PolicySettings> = {};
  for (const [k, p] of Object.entries(po)) {
    if (!POLICY_KEY.test(k)) throw new SettingsError(`policy name "${k}" is not valid`);
    policies[k] = validPolicy(p, `policy ${k}`);
  }
  // Settings saved before the batch system existed have no live policy: add the default one.
  if (!policies.live && policies.standard) policies.live = defaultSettings(policies.standard.baselineModel).policies.live!;
  if (!policies.standard || !policies.premium) throw new SettingsError("the standard and premium policies are required");
  if (Object.keys(policies).length > 40) throw new SettingsError("too many policies");
  const prices: Record<string, ModelPrice> = {};
  for (const [k, p] of Object.entries(pr)) prices[model(k, "price model name")] = price(p, `price of ${k}`);
  if (Object.keys(prices).length > 60) throw new SettingsError("too many prices");
  return {
    runpod: {
      enabled: bool(r.enabled, "runpod enabled"),
      model: model(r.model, "RunPod model"),
      billing: oneOf(r.billing, "RunPod billing", ["seconds", "tokens"]),
      gpuUsdPerSecond: num(r.gpuUsdPerSecond, "GPU price per second", 0, 1),
      tokenPrice: price(r.tokenPrice, "RunPod token price"),
      softDeadlineMs: num(r.softDeadlineMs, "soft deadline", 1_000, 600_000),
      hardTimeoutMs: num(r.hardTimeoutMs, "hard timeout", 1_000, 600_000),
      attempts: Math.round(num(r.attempts, "attempts", 1, 5)),
      breakerFailures: Math.round(num(r.breakerFailures, "breaker failures", 1, 50)),
      breakerCooldownMs: num(r.breakerCooldownMs, "breaker cooldown", 1_000, 3_600_000),
    },
    reviewer: { enabled: bool(rv.enabled, "reviewer enabled"), model: model(rv.model, "reviewer model"), maxInputChars: Math.round(num(rv.maxInputChars, "reviewer input limit", 1_000, 100_000)), adaptive: bool(rv.adaptive, "reviewer adaptive") },
    cache: { enabled: bool(c.enabled, "cache enabled"), ttlSeconds: num(c.ttlSeconds, "cache lifetime", 1, 86_400 * 7), maxEntries: Math.round(num(c.maxEntries, "cache size", 1, 10_000)) },
    budgets: {
      claudeDailyUsd: cap(b.claudeDailyUsd, "daily Claude cap"),
      claudeMonthlyUsd: cap(b.claudeMonthlyUsd, "monthly Claude cap"),
      claudePerWorkspaceMonthlyUsd: cap(b.claudePerWorkspaceMonthlyUsd, "per-client Claude cap"),
      runpodMonthlyUsd: cap(b.runpodMonthlyUsd, "monthly RunPod cap"),
      whenClaudeCapped: oneOf(b.whenClaudeCapped, "when Claude is capped", ["degrade", "fail"]),
    },
    batch: validBatch(bt),
    prices,
    policies,
  };
}

function validBatch(b: Record<string, unknown>): BatchSettings {
  const list = b.liveTemplates;
  if (!Array.isArray(list) || list.length > 40 || list.some((t) => typeof t !== "string" || !POLICY_KEY.test(t))) throw new SettingsError("live templates must be a list of employee template keys");
  return {
    enabled: bool(b.enabled, "batch enabled"),
    sizeTrigger: Math.round(num(b.sizeTrigger, "batch size trigger", 1, 10_000)),
    tokenTrigger: Math.round(num(b.tokenTrigger, "batch token trigger", 1_000, 100_000_000)),
    maxQueueAgeHours: num(b.maxQueueAgeHours, "longest wait", 1, 168),
    concurrency: Math.round(num(b.concurrency, "batch concurrency", 1, 64)),
    gpuWorkers: b.gpuWorkers === undefined ? 1 : Math.round(num(b.gpuWorkers, "number of GPUs", 1, 16)),
    gpuSizeGb: b.gpuSizeGb === undefined ? 48 : ((): 24 | 48 | 80 => { const v = num(b.gpuSizeGb, "GPU size", 24, 80); if (v !== 24 && v !== 48 && v !== 80) throw new SettingsError("GPU size must be 24, 48 or 80 GB"); return v; })(),
    windowHours: b.windowHours === undefined ? 10 : num(b.windowHours, "overnight window hours", 1, 24),
    maxAttempts: Math.round(num(b.maxAttempts, "batch attempts", 1, 10)),
    retryBackoffMinutes: num(b.retryBackoffMinutes, "retry wait", 1, 1_440),
    qaRateMin: num(b.qaRateMin, "batch check rate", 0, 1),
    claudeAfterFailures: bool(b.claudeAfterFailures, "Claude after failures"),
    coldStartSeconds: num(b.coldStartSeconds, "cold start seconds", 0, 600),
    flushAfterUrgent: b.flushAfterUrgent === undefined ? true : bool(b.flushAfterUrgent, "flush after urgent"),
    liveDuringTrial: b.liveDuringTrial === undefined ? true : bool(b.liveDuringTrial, "live during trial"),
    liveFirstTasks: b.liveFirstTasks === undefined ? 20 : Math.round(num(b.liveFirstTasks, "first tasks answered live", 0, 1_000)),
    liveTemplates: [...list] as string[],
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Merge a partial change into a settings object. Objects merge key by key; a null policy removes it. */
export function mergeSettings(base: AiRoutingSettings, patch: unknown): AiRoutingSettings {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isObj(b)) return b;
    const out: Record<string, unknown> = isObj(a) ? { ...a } : {};
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined || k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (v === null && isObj(a) && isObj((a as Record<string, unknown>)[k])) delete out[k]; // null removes an entry (policy or price)
      else out[k] = merge(out[k], v);
    }
    return out;
  };
  if (!isObj(patch)) throw new SettingsError("send an object of changes");
  return validateSettings(merge(structuredClone(base), patch));
}

/** Holds the live settings. Reads are free; changes are checked and written to storage. */
export class RoutingSettingsStore {
  private current: AiRoutingSettings;
  private sink?: Sink;
  constructor(initial: AiRoutingSettings = defaultSettings()) {
    this.current = initial;
  }
  useSink(sink: Sink): void { this.sink = sink; }
  restore(saved: unknown): void {
    // A bad saved row must never stop the server starting; keep the defaults and say so.
    try { this.current = validateSettings(saved); } catch (e) { console.error("saved AI settings ignored:", e instanceof Error ? e.message : e); }
  }
  get(): AiRoutingSettings { return this.current; }
  update(patch: unknown): AiRoutingSettings {
    this.current = mergeSettings(this.current, patch);
    this.sink?.aiSettings(this.current);
    return this.current;
  }
}
