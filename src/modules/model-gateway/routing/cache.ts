import { createHash } from "node:crypto";
import type { ChatMessage, CompletionResult } from "../types.js";

interface Entry { result: CompletionResult; expires: number; savedMicro: number }

/**
 * Exact-match answer cache. The key always includes the client, so one client's answer can never be
 * served to another. Least recently used entries go first when it is full.
 */
export class ResponseCache {
  private entries = new Map<string, Entry>();
  constructor(private now: () => number = Date.now) {}

  static key(workspaceId: string, policy: string, messages: ChatMessage[], maxTokens: number | undefined): string {
    return createHash("sha256").update(JSON.stringify([workspaceId, policy, maxTokens ?? 0, messages])).digest("hex");
  }

  get(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) { this.entries.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, e); // most recently used goes last
    return e;
  }

  set(key: string, result: CompletionResult, savedMicro: number, ttlSeconds: number, maxEntries: number): void {
    this.entries.delete(key);
    this.entries.set(key, { result: { text: result.text, provider: result.provider, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens }, expires: this.now() + ttlSeconds * 1000, savedMicro });
    while (this.entries.size > maxEntries) this.entries.delete(this.entries.keys().next().value as string);
  }

  get size(): number { return this.entries.size; }
  clear(): void { this.entries.clear(); }
}
