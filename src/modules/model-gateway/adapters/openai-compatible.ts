import { readSse } from "./sse.js";
import { kindForStatus, ProviderError, timedFetch, type CompletionRequest, type CompletionResult, type ModelAdapter } from "../types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Works with any server that speaks the OpenAI chat API, which includes vLLM
 * on RunPod and most hosted open-model providers. This is the adapter for
 * the cheap open models.
 */
export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly tiers: readonly ("standard" | "premium")[];

  constructor(
    readonly name: string,
    protected baseUrl: string,
    protected apiKey: string,
    protected model: string,
    tiers: readonly ("standard" | "premium")[] = ["standard"],
    protected http: typeof fetch = fetch,
  ) {
    this.tiers = tiers;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const model = req.model ?? this.model;
    const res = await timedFetch(this.name, `${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model, messages: req.messages, max_tokens: req.maxTokens ?? 1024, ...(req.stream ? { stream: true, stream_options: { include_usage: true } } : {}) }),
    }, req.timeoutMs ?? DEFAULT_TIMEOUT_MS, this.http);
    if (!res.ok) throw new ProviderError(this.name, kindForStatus(res.status), `${this.name} ${res.status}`, res.status);
    if (req.stream && res.body) return this.completeStreaming(req, model, res.body);
    const json = (await res.json().catch(() => undefined)) as
      | { choices?: { message?: { content?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens: number; completion_tokens: number } }
      | undefined;
    const choice = json?.choices?.[0];
    if (!choice) throw new ProviderError(this.name, "unavailable", `${this.name} sent no answer`);
    const text = choice.message?.content ?? "";
    // vLLM normally reports usage. If a server does not, estimate (about 4 characters a token) so cost tracking never reads zero.
    const approxIn = Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    return {
      text,
      provider: this.name,
      model,
      inputTokens: json?.usage?.prompt_tokens ?? approxIn,
      outputTokens: json?.usage?.completion_tokens ?? Math.ceil(text.length / 4),
      truncated: choice.finish_reason === "length",
    };
  }

  /** The same answer, read as it is written: each piece goes to the caller's stream and the whole is returned at the end. */
  private async completeStreaming(req: CompletionRequest, model: string, body: ReadableStream<Uint8Array>): Promise<CompletionResult> {
    let text = "";
    let finish: string | undefined;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    try {
      await readSse(body, (data) => {
        if (data === "[DONE]") return;
        let j: { choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[]; usage?: typeof usage } | undefined;
        try { j = JSON.parse(data); } catch { return; }
        const c = j?.choices?.[0];
        if (c?.delta?.content) { text += c.delta.content; req.stream!.text(c.delta.content); }
        if (c?.finish_reason) finish = c.finish_reason;
        if (j?.usage) usage = j.usage;
      });
    } catch (err) {
      // A deadline or a dropped connection part-way: the same kinds of failure as before, so retry and fallback still work.
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") throw new ProviderError(this.name, "timeout", `${this.name} did not finish answering in time`);
      throw new ProviderError(this.name, "network", `${this.name} stopped part-way`);
    }
    if (!text) throw new ProviderError(this.name, "unavailable", `${this.name} sent no answer`);
    const approxIn = Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    return { text, provider: this.name, model, inputTokens: usage?.prompt_tokens ?? approxIn, outputTokens: usage?.completion_tokens ?? Math.ceil(text.length / 4), truncated: finish === "length" };
  }
}
