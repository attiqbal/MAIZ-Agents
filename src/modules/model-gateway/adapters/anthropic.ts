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
      }),
    }, req.timeoutMs ?? DEFAULT_TIMEOUT_MS, this.http);
    if (!res.ok) throw new ProviderError(this.name, kindForStatus(res.status), `anthropic ${res.status}`, res.status);
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
}
