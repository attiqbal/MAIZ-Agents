/**
 * The one interface every AI model provider implements. AI employees never
 * talk to a provider directly, so providers (Claude, open models hosted on
 * RunPod, others) can be added or swapped without touching employee logic.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  /** "standard" can run on a cheap open model; "premium" asks for the strongest. */
  tier?: "standard" | "premium";
  /** Which client the work is for. Used for per-client budgets and for keeping cached answers apart. */
  workspaceId?: string;
  /** Names a routing policy (for example an employee template key). Unknown names fall back to the tier. */
  taskType?: string;
  /** Overrides the adapter's own model. Set by the router from editable settings. */
  model?: string;
  /** Gives up on the provider after this many milliseconds (throws a `timeout` ProviderError). */
  timeoutMs?: number;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the provider stopped because it hit the token limit, so the text may be cut off. */
  truncated?: boolean;
  /**
   * Real provider cost of everything done for this request (answer, quality check, retry on Claude),
   * in micro-dollars. Set by the routing gateway; absent for the plain gateway.
   */
  costMicro?: number;
  routing?: RoutingInfo;
}

/** What the routing gateway did for one request. Never shown to clients. */
export interface RoutingInfo {
  policy: string;
  route: "cache" | "runpod" | "claude" | "fallback" | "escalated";
  costMicro: number;
  /** What the same answer would have cost on the Claude-only baseline model. */
  baselineMicro: number;
  cached: boolean;
  reviewed: boolean;
  reviewScore?: number;
  escalated: boolean;
  /** The answer was accepted although it scored below the threshold (Claude could not be used to redo it). */
  lowConfidence: boolean;
  notes: string[];
}

export interface ModelAdapter {
  readonly name: string;
  /** Tiers this adapter is willing to serve. */
  readonly tiers: readonly ("standard" | "premium")[];
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** Anything the workforce can ask for an answer: the plain gateway or the routing gateway. */
export interface Completer {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export type ProviderErrorKind = "timeout" | "rate_limited" | "unavailable" | "bad_request" | "auth" | "network";

/** A provider failure with enough shape for retry, circuit breaker and fallback decisions. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
  /** Worth trying again (or trying the other provider): not our mistake, not a bad key. */
  get transient(): boolean {
    return this.kind === "timeout" || this.kind === "rate_limited" || this.kind === "unavailable" || this.kind === "network";
  }
}

export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "bad_request";
}

/** fetch with a deadline, turning aborts and network errors into ProviderErrors. */
export async function timedFetch(provider: string, url: string, init: RequestInit, timeoutMs: number, http: typeof fetch = fetch): Promise<Response> {
  try {
    return await http(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new ProviderError(provider, "timeout", `${provider} did not answer in ${Math.round(timeoutMs / 1000)}s`);
    throw new ProviderError(provider, "network", `${provider} could not be reached`);
  }
}
