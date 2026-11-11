import { readSse } from "./sse.js";
import { kindForStatus, ProviderError, timedFetch, type CompletionRequest, type CompletionResult, type ModelAdapter } from "../types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/** Calls the Anthropic Messages API directly with fetch (no SDK dependency). */
export class AnthropicAdapter implements ModelAdapter {
  readonly name = "anthropic";
  readonly tiers = ["standard", "premium"] as const;

  constructor(
    private apiKey: string,
    private model: string,
    private http: typeof fetch = fetch,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const model = req.model ?? this.model;
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages = req.messages.filter((m) => m.role !== "system");
    const res = await timedFetch(this.name, "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 1024,
        ...(system ? { system } : {}),
        messages,
        ...(req.stream ? { stream: true } : {}),
      }),
    }, req.timeoutMs ?? DEFAULT_TIMEOUT_MS, this.http);
    if (!res.ok) throw new ProviderError(this.name, kindForStatus(res.status), `anthropic ${res.status}`, res.status);
    if (req.stream && res.body) return this.completeStreaming(req, model, res.body);
    const json = (await res.json()) as {
      content: { type: string; text?: string }[];
      usage: { input_tokens: number; output_tokens: number };
      stop_reason?: string;
    };
    return {
      text: json.content.map((c) => c.text ?? "").join(""),
      provider: this.name,
      model,
      inputTokens: json.usage.input_tokens,
      outputTokens: json.usage.output_tokens,
      truncated: json.stop_reason === "max_tokens",
    };
  }

  private async completeStreaming(req: CompletionRequest, model: string, body: ReadableStream<Uint8Array>): Promise<CompletionResult> {
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let stop: string | undefined;
    try {
      await readSse(body, (data) => {
        let e: { type?: string; message?: { usage?: { input_tokens?: number } }; delta?: { text?: string; stop_reason?: string }; usage?: { output_tokens?: number } } | undefined;
        try { e = JSON.parse(data); } catch { return; }
        if (e?.type === "message_start") inputTokens = e.message?.usage?.input_tokens ?? 0;
        else if (e?.type === "content_block_delta" && e.delta?.text) { text += e.delta.text; req.stream!.text(e.delta.text); }
        else if (e?.type === "message_delta") { outputTokens = e.usage?.output_tokens ?? outputTokens; stop = e.delta?.stop_reason ?? stop; }
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") throw new ProviderError(this.name, "timeout", "anthropic did not finish answering in time");
      throw new ProviderError(this.name, "network", "anthropic stopped part-way");
    }
    if (!text) throw new ProviderError(this.name, "unavailable", "anthropic sent no answer");
    return { text, provider: this.name, model, inputTokens, outputTokens: outputTokens || Math.ceil(text.length / 4), truncated: stop === "max_tokens" };
  }
}
