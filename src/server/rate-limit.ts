/**
 * Fixed-window request limits per client address. In memory, so it is per server instance:
 * fine for the single-instance launch setup (see docs/RUNBOOK.md), move to Postgres or Redis before scaling out.
 */
export interface Limit { max: number; windowMs: number }

export class RateLimiter {
  private hits = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Records a hit and returns true when the caller is still under the limit. */
  allow(key: string, limit: Limit): boolean {
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || t - cur.start >= limit.windowMs) {
      this.hits.set(key, { start: t, count: 1 });
      if (this.hits.size > 50_000) this.sweep(t, limit.windowMs);
      return true;
    }
    cur.count += 1;
    return cur.count <= limit.max;
  }

  private sweep(t: number, windowMs: number) {
    for (const [k, v] of this.hits) if (t - v.start >= windowMs) this.hits.delete(k);
  }
}

/** Limits for the API. Sign-in and sign-up are tighter because they send email or create customers. */
export function limitFor(method: string, path: string): Limit | undefined {
  if (method !== "POST") return undefined;
  if (path === "/api/slack/events") return undefined; // signed by Slack, and Slack retries on 429
  if (path === "/api/payments/webhook") return undefined; // signed by the payment provider, which retries on 429
  // Tasks are limited by energy (the team pool, the daily ceiling and the monthly cost cap), not by a request count:
  // a client who wants to spend a week's energy in an hour may. A refused task costs nothing.
  if (path === "/api/ask") return undefined;
  // Each checkout creates a payment session at the provider: keep it to a handful of tries per address.
  if (path === "/api/checkout") return { max: 20, windowMs: 10 * 60_000 };
  if (path.startsWith("/api/auth/")) return { max: 15, windowMs: 10 * 60_000 };
  if (path === "/api/signin/start" || path === "/api/signup") return { max: 10, windowMs: 10 * 60_000 };
  // Run-now wakes the GPU pod, which is billed per second: keep it to a few presses an hour per address.
  if (path === "/api/queue/run-now" || path === "/api/owner/batch/run-now") return { max: 6, windowMs: 60 * 60_000 };
  return { max: 60, windowMs: 60_000 };
}

/**
 * Client address. Behind one hosting proxy (Render, Fly, Railway) the proxy appends the real client address as the
 * LAST X-Forwarded-For entry; earlier entries come from the client and can be forged, so they are ignored.
 */
export function clientIp(headers: Record<string, string | undefined>, socketIp: string | undefined, trustProxy: boolean): string {
  const fwd = trustProxy ? headers["x-forwarded-for"]?.split(",").pop()?.trim() : undefined;
  return fwd || socketIp || "unknown";
}
