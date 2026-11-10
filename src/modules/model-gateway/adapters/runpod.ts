import { OpenAICompatibleAdapter } from "./openai-compatible.js";
import { timedFetch } from "../types.js";

const ENDPOINT_ID = /^[a-z0-9]{6,40}$/i;
const HEALTH_TIMEOUT_MS = 8_000;

export interface RunPodHealth {
  reachable: boolean;
  /** Workers by state, as RunPod reports them (idle, running, initializing, throttled, ...). */
  workers?: Record<string, number>;
  /** Jobs by state (inQueue, inProgress, completed, failed, ...). */
  jobs?: Record<string, number>;
  error?: string;
}

/**
 * A RunPod Serverless endpoint running the vLLM worker, reached through its OpenAI-compatible route.
 * The host is fixed and the endpoint id is checked, so configuration can never point this at another server.
 * The API key and endpoint id come from environment variables, never from code or chat.
 */
export class RunPodAdapter extends OpenAICompatibleAdapter {
  private readonly endpointBase: string;

  constructor(apiKey: string, endpointId: string, model: string, http: typeof fetch = fetch) {
    if (!ENDPOINT_ID.test(endpointId)) throw new Error("RUNPOD_ENDPOINT_ID must be the endpoint's id (letters and digits only)");
    const endpointBase = `https://api.runpod.ai/v2/${endpointId}`;
    super("runpod", `${endpointBase}/openai/v1`, apiKey, model, ["standard", "premium"], http);
    this.endpointBase = endpointBase;
  }

  /** Worker and queue counts, for the owner's dashboard. Does not wake a sleeping worker. */
  async health(): Promise<RunPodHealth> {
    try {
      const res = await timedFetch(this.name, `${this.endpointBase}/health`, { headers: { authorization: `Bearer ${this.apiKey}` } }, HEALTH_TIMEOUT_MS, this.http);
      if (!res.ok) return { reachable: false, error: `RunPod answered ${res.status}` };
      const j = (await res.json()) as { workers?: Record<string, number>; jobs?: Record<string, number> };
      return { reachable: true, workers: j.workers, jobs: j.jobs };
    } catch (err) {
      return { reachable: false, error: err instanceof Error ? err.message : "unreachable" };
    }
  }
}
