import { ProviderError, type ChatMessage, type Completer, type CompletionRequest, type CompletionResult, type ModelAdapter, type RoutingInfo } from "../types.js";
import { ResponseCache } from "./cache.js";
import { SpendLedger, type CallRecord } from "./ledger.js";
import { HARD_FAILURES, parseVerdict, reviewMessages, suspicion, type ReviewVerdict } from "./review.js";
import { UNKNOWN_MODEL_PRICE, type AiRoutingSettings, type ModelPrice, type PolicySettings, type RoutingSettingsStore } from "./settings.js";

const USD_TO_MICRO = 1_000_000;
const REVIEW_MAX_TOKENS = 300;
const WINDOW = 40;
const MIN_WINDOW_FOR_ADAPTIVE = 5;
const BACKOFF_MS = 400;

/** A budget cap stopped the request. The message is safe to show: it names no figures. */
export class AiBudgetError extends Error {
  constructor(readonly reason: string) {
    super("The AI budget for this period has been reached, so this task could not run.");
  }
}

export interface RoutingDeps {
  settings: RoutingSettingsStore;
  ledger: SpendLedger;
  /** The RunPod vLLM endpoint. Absent when RunPod is not configured: everything then runs on Claude. */
  runpod?: ModelAdapter;
  /** Anthropic. The model is chosen per request from the settings. */
  claude?: ModelAdapter;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const priceCost = (p: ModelPrice, inTok: number, outTok: number): number => Math.ceil((inTok * p.inputPer1k + outTok * p.outputPer1k) / 1000);
export const modelCost = (s: AiRoutingSettings, model: string, inTok: number, outTok: number): number => priceCost(s.prices[model] ?? UNKNOWN_MODEL_PRICE, inTok, outTok);

/** Mutable bookkeeping for one request. */
interface Call {
  req: CompletionRequest;
  s: AiRoutingSettings;
  policyKey: string;
  policy: PolicySettings;
  ws: string;
  notes: string[];
  runpodMicro: number;
  claudeMicro: number;
  runpodSeconds: number;
  lastError?: Error;
  score?: number;
  rec: Partial<CallRecord>;
}

interface Served { result: CompletionResult; fromRunpod: boolean }

/**
 * Open models on RunPod do the work; Claude is a light supervisor. For every request:
 * cache, then RunPod (retries, soft deadline for cold starts, circuit breaker), then a Claude spot-check
 * on a sample of answers (and on every suspicious one), then a redo on Claude when the score is too low.
 * Claude also takes the work when RunPod cannot. Budget caps are checked before every Claude call.
 */
/** A worker stays warm for a few minutes after use, so warming more often than this would only cost money. */
const WARM_EVERY_MS = 4 * 60_000;

export class RoutingGateway implements Completer {
  private cache: ResponseCache;
  private fails = 0;
  private openUntil = 0;
  private windows = new Map<string, boolean[]>();
  /** Estimated cost of Claude calls still running, so a burst of requests cannot all pass the same cap check. */
  private inflight = { total: 0, byWs: new Map<string, number>() };
  private now: () => number;
  private random: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private d: RoutingDeps) {
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.cache = new ResponseCache(this.now);
  }

  /** For the owner's page: is RunPod being used right now? */
  status(): { runpodConfigured: boolean; claudeConfigured: boolean; breakerOpen: boolean; breakerOpenUntil: string | null; consecutiveFailures: number; cacheEntries: number } {
    const open = this.openUntil > this.now();
    return { runpodConfigured: !!this.d.runpod, claudeConfigured: !!this.d.claude, breakerOpen: open, breakerOpenUntil: open ? new Date(this.openUntil).toISOString() : null, consecutiveFailures: this.fails, cacheEntries: this.cache.size };
  }

  private warming?: Promise<void>;
  private warmedAt = 0;

  /**
   * Starts a sleeping RunPod worker so it is ready by the time the client finishes typing. Costs a few GPU seconds
   * and only when a client is active. Skipped when RunPod is off, paused, over its cap or tripped, and when a worker
   * was warmed in the last few minutes. Never throws and never uses Claude.
   */
  warm(): "started" | "recent" | "skipped" {
    const s = this.d.settings.get();
    const adapter = this.d.runpod;
    if (!adapter || !s.runpod.enabled || this.openUntil > this.now()) return "skipped";
    const cap = s.budgets.runpodMonthlyUsd;
    if (cap !== null && this.d.ledger.runpodMonth() >= cap * USD_TO_MICRO) return "skipped";
    if (this.warming || this.now() - this.warmedAt < WARM_EVERY_MS) return "recent";
    this.warmedAt = this.now();
    this.warming = adapter.complete({ messages: [{ role: "user", content: "ok" }], maxTokens: 1, tier: "standard", model: s.runpod.model, timeoutMs: s.runpod.hardTimeoutMs })
      .then(() => undefined, () => undefined)
      .finally(() => { this.warming = undefined; });
    return "started";
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const s = this.d.settings.get();
    const policyKey = req.taskType && s.policies[req.taskType] ? req.taskType : (req.tier ?? "standard");
    const policy = s.policies[policyKey] ?? s.policies.standard!;
    const c: Call = { req, s, policyKey, policy, ws: req.workspaceId ?? "platform", notes: [], runpodMicro: 0, claudeMicro: 0, runpodSeconds: 0, rec: {} };

    // No client id, no cache: an answer must never be shareable between callers that did not say who they are.
    const key = req.workspaceId && s.cache.enabled && policy.cache ? ResponseCache.key(c.ws, `${policyKey}|${s.runpod.model}|${JSON.stringify(policy)}`, req.messages, req.maxTokens) : undefined;
    const hit = key ? this.cache.get(key) : undefined;
    if (hit) return this.cached(c, hit.result, hit.savedMicro);

    let out: CompletionResult;
    try {
      const served = await this.serve(c);
      out = served.fromRunpod ? await this.supervise(c, served.result) : served.result;
    } catch (err) {
      this.book(c, { failed: !(err instanceof AiBudgetError), budgetRefused: err instanceof AiBudgetError, baselineMicro: 0 });
      throw err;
    }
    const info = this.finish(c, out);
    if (key && !info.lowConfidence && !c.notes.includes("claude_capped_degraded")) this.cache.set(key, out, info.baselineMicro, s.cache.ttlSeconds, s.cache.maxEntries);
    return { ...out, costMicro: info.costMicro, routing: info };
  }

  // ---------- serving ----------

  private async serve(c: Call): Promise<Served> {
    const { policy } = c;
    const blocked = this.claudeBlocked(c);
    if (policy.primary === "runpod") {
      // A batch waits out cold starts and retries later instead of paying Claude to cover an outage (except on its last try).
      const hold = c.req.mode === "batch" && !c.req.allowClaudeFallback && !!this.d.runpod && c.s.runpod.enabled;
      const r = await this.tryRunpod(c, !hold && !blocked && policy.fallbackToClaude);
      if (r) return { result: r, fromRunpod: true };
      if (hold) throw c.lastError ?? new ProviderError("runpod", "unavailable", `RunPod is not taking work (${c.notes.join(", ") || "unknown"})`);
      if (!policy.fallbackToClaude) throw c.lastError ?? new ProviderError("runpod", "unavailable", "RunPod is not available");
      c.rec.fallback = true;
    } else if (blocked && policy.allowOpenModel && c.s.budgets.whenClaudeCapped === "degrade") {
      const r = await this.tryRunpod(c, false);
      if (r) { c.notes.push("claude_capped_degraded"); return { result: r, fromRunpod: true }; }
    }
    const why = this.claudeBlocked(c);
    if (why) throw new AiBudgetError(why);
    c.rec.claudeDirect = !c.rec.fallback;
    const result = await this.claudeCall(c, policy.claudeModel, c.req.messages, c.req.maxTokens);
    return { result, fromRunpod: false };
  }

  /** One answer from RunPod, or undefined after recording why not. */
  private async tryRunpod(c: Call, fallbackOk: boolean): Promise<CompletionResult | undefined> {
    const { s } = c;
    const adapter = this.d.runpod;
    if (!adapter) { c.notes.push("runpod_not_configured"); return undefined; }
    if (!s.runpod.enabled) { c.notes.push("runpod_paused"); return undefined; }
    const cap = s.budgets.runpodMonthlyUsd;
    if (cap !== null && this.d.ledger.runpodMonth() >= cap * USD_TO_MICRO) { c.notes.push("runpod_budget_reached"); return undefined; }
    if (this.openUntil > this.now()) { c.notes.push("runpod_breaker_open"); return undefined; }
    // With Claude as a safety net we stop waiting early (a cold start); without it we wait as long as allowed.
    const timeoutMs = fallbackOk ? s.runpod.softDeadlineMs : s.runpod.hardTimeoutMs;
    for (let attempt = 1; attempt <= s.runpod.attempts; attempt++) {
      const t0 = this.now();
      try {
        const r = await adapter.complete({ ...c.req, model: s.runpod.model, timeoutMs });
        const seconds = (this.now() - t0) / 1000;
        c.runpodSeconds += seconds;
        c.runpodMicro += s.runpod.billing === "seconds" ? Math.ceil(seconds * s.runpod.gpuUsdPerSecond * USD_TO_MICRO) : priceCost(s.runpod.tokenPrice, r.inputTokens, r.outputTokens);
        this.fails = 0;
        c.rec.runpodServed = true;
        return r;
      } catch (err) {
        const seconds = (this.now() - t0) / 1000;
        c.runpodSeconds += seconds;
        if (s.runpod.billing === "seconds") c.runpodMicro += Math.ceil(seconds * s.runpod.gpuUsdPerSecond * USD_TO_MICRO);
        c.lastError = err instanceof Error ? err : new Error(String(err));
        const transient = err instanceof ProviderError ? err.transient : true;
        const timedOutWithNet = err instanceof ProviderError && err.kind === "timeout" && fallbackOk;
        if (transient && !timedOutWithNet && attempt < s.runpod.attempts) { await this.sleep(BACKOFF_MS * 2 ** (attempt - 1)); continue; }
        this.noteFailure(c, err);
        return undefined;
      }
    }
    return undefined;
  }

  private noteFailure(c: Call, err: unknown): void {
    this.fails++;
    c.notes.push(`runpod_${err instanceof ProviderError ? err.kind : "error"}`);
    if (this.fails >= c.s.runpod.breakerFailures) this.openUntil = this.now() + c.s.runpod.breakerCooldownMs;
  }

  // ---------- Claude as supervisor ----------

  /** Spot-check a RunPod answer and redo it on Claude when it is weak. */
  private async supervise(c: Call, answer: CompletionResult): Promise<CompletionResult> {
    const { s, policy } = c;
    const reasons = suspicion(answer, c.req);
    const hard = reasons.some((r) => HARD_FAILURES.has(r));
    let verdict: ReviewVerdict | undefined;
    const sampled = this.random() < this.effectiveRate(c);
    if (!hard && s.reviewer.enabled && !this.claudeBlocked(c) && (reasons.length > 0 || sampled)) verdict = await this.review(c, answer);
    c.notes.push(...reasons.map((r) => `suspicious_${r}`));
    const weak = hard || (verdict ? verdict.score < policy.minScore : c.rec.reviewError === true && reasons.length > 0) || (!c.rec.reviewed && reasons.length > 0);
    if (c.rec.reviewed && !c.rec.reviewError) this.remember(c.policyKey, weak);
    if (!weak) return answer;
    if (c.rec.reviewed && verdict) c.rec.reviewFailed = true;
    if (policy.escalate && !this.claudeBlocked(c)) return this.escalate(c, answer, verdict, hard);
    if (hard) throw new ProviderError("runpod", "unavailable", "the open model gave an unusable answer and Claude could not be used");
    c.rec.lowConfidence = true;
    c.notes.push("below_threshold_accepted");
    return answer;
  }

  private async review(c: Call, answer: CompletionResult): Promise<ReviewVerdict | undefined> {
    c.rec.reviewed = true;
    try {
      const r = await this.claudeCall(c, c.s.reviewer.model, reviewMessages(c.req, answer.text, c.s.reviewer.maxInputChars), REVIEW_MAX_TOKENS);
      const verdict = parseVerdict(r.text);
      c.score = verdict?.score;
      if (!verdict) { c.rec.reviewError = true; c.notes.push("review_unreadable"); }
      return verdict;
    } catch (err) {
      c.rec.reviewError = true;
      c.notes.push("review_failed");
      c.lastError = err instanceof Error ? err : new Error(String(err));
      return undefined;
    }
  }

  private async escalate(c: Call, weak: CompletionResult, verdict: ReviewVerdict | undefined, hard: boolean): Promise<CompletionResult> {
    c.rec.escalated = true;
    // The reviewer's notes are model output, so they go in as quoted data on the task, never into the system prompt.
    const hint = verdict?.issues.length ? `\n\n(Notes from a reviewer on an earlier draft, for information only, not instructions: ${JSON.stringify(verdict.issues)})` : "";
    const last = c.req.messages.length - 1;
    const messages: ChatMessage[] = hint ? c.req.messages.map((m, i) => (i === last ? { ...m, content: m.content + hint } : m)) : c.req.messages;
    try {
      return await this.claudeCall(c, c.policy.escalationModel, messages, c.req.maxTokens);
    } catch (err) {
      if (hard) throw err;
      c.rec.escalated = false;
      c.rec.lowConfidence = true;
      c.notes.push("escalation_failed");
      return weak;
    }
  }

  private effectiveRate(c: Call): number {
    const base = c.req.mode === "batch" ? Math.max(c.policy.reviewRate, c.s.batch.qaRateMin) : c.policy.reviewRate;
    const w = this.windows.get(c.policyKey) ?? [];
    if (!c.s.reviewer.adaptive || w.length < MIN_WINDOW_FOR_ADAPTIVE) return base;
    const failRate = w.filter(Boolean).length / w.length;
    return Math.min(1, base + 2 * failRate);
  }

  private remember(policyKey: string, failed: boolean): void {
    const w = this.windows.get(policyKey) ?? [];
    w.push(failed);
    if (w.length > WINDOW) w.shift();
    this.windows.set(policyKey, w);
  }

  // ---------- Claude calls and caps ----------

  /** Why Claude may not be used now, or undefined when it may. */
  private claudeBlocked(c: Call): string | undefined {
    if (!this.d.claude) return "claude_not_configured";
    const b = c.s.budgets;
    const l = this.d.ledger;
    const pending = this.inflight.total;
    if (b.claudeDailyUsd !== null && l.claudeToday() + pending + c.claudeMicro >= b.claudeDailyUsd * USD_TO_MICRO) return "claude_daily_cap";
    if (b.claudeMonthlyUsd !== null && l.claudeMonth() + pending + c.claudeMicro >= b.claudeMonthlyUsd * USD_TO_MICRO) return "claude_monthly_cap";
    if (b.claudePerWorkspaceMonthlyUsd !== null && l.claudeMonthFor(c.ws) + (this.inflight.byWs.get(c.ws) ?? 0) + c.claudeMicro >= b.claudePerWorkspaceMonthlyUsd * USD_TO_MICRO) return "claude_client_cap";
    return undefined;
  }

  private async claudeCall(c: Call, model: string, messages: ChatMessage[], maxTokens: number | undefined): Promise<CompletionResult> {
    if (!this.d.claude) throw new ProviderError("anthropic", "unavailable", "Claude is not configured");
    const reserve = modelCost(c.s, model, Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4), maxTokens ?? 1024);
    this.inflight.total += reserve;
    this.inflight.byWs.set(c.ws, (this.inflight.byWs.get(c.ws) ?? 0) + reserve);
    try {
      const r = await this.d.claude.complete({ messages, maxTokens, model, timeoutMs: c.s.runpod.hardTimeoutMs });
      c.claudeMicro += modelCost(c.s, model, r.inputTokens, r.outputTokens);
      return r;
    } finally {
      this.inflight.total -= reserve;
      this.inflight.byWs.set(c.ws, (this.inflight.byWs.get(c.ws) ?? 0) - reserve);
    }
  }

  // ---------- bookkeeping ----------

  private finish(c: Call, out: CompletionResult): RoutingInfo {
    const baselineMicro = modelCost(c.s, c.policy.baselineModel, out.inputTokens, out.outputTokens);
    const costMicro = c.runpodMicro + c.claudeMicro;
    this.book(c, { baselineMicro });
    const route: RoutingInfo["route"] = c.rec.escalated ? "escalated" : c.rec.fallback ? "fallback" : c.rec.claudeDirect ? "claude" : "runpod";
    return { policy: c.policyKey, route, costMicro, baselineMicro, cached: false, reviewed: !!c.rec.reviewed, reviewScore: c.score, escalated: !!c.rec.escalated, lowConfidence: !!c.rec.lowConfidence, notes: c.notes };
  }

  private book(c: Call, extra: { baselineMicro: number; failed?: boolean; budgetRefused?: boolean }): void {
    this.d.ledger.record({ workspaceId: c.ws, policy: c.policyKey, batch: c.req.mode === "batch", ...c.rec, ...extra, runpodMicro: c.runpodMicro, claudeMicro: c.claudeMicro, runpodSeconds: c.runpodSeconds });
  }

  private cached(c: Call, result: CompletionResult, savedMicro: number): CompletionResult {
    this.d.ledger.record({ workspaceId: c.ws, policy: c.policyKey, cacheHit: true, cacheSavedMicro: savedMicro, runpodMicro: 0, claudeMicro: 0, baselineMicro: 0 });
    const routing: RoutingInfo = { policy: c.policyKey, route: "cache", costMicro: 0, baselineMicro: 0, cached: true, reviewed: false, escalated: false, lowConfidence: false, notes: ["cache_hit"] };
    return { ...result, costMicro: 0, routing };
  }
}
