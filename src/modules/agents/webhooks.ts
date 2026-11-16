import { createHmac, timingSafeEqual } from "node:crypto";
import { newId } from "../../core/ids.js";
import { assertPublicHost } from "../integrations/connectors/util.js";
import { AgentError } from "./types.js";

export const SIGNATURE_HEADER = "MAIZ-Signature";
export const WEBHOOK_TIMEOUT_MS = 8_000;
/** How long to wait after each failed try: 1 minute, 5 minutes, 30 minutes, 2 hours, then every 6 hours. */
export const RETRY_AFTER_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
/** A webhook that still fails this long after the event is given up on. Polling the job always works. */
export const GIVE_UP_AFTER_MS = 24 * 3_600_000;
/** A receiver should refuse a signature older than this (replayed requests). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const URL_MAX_CHARS = 500;
const HOST_SHAPE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const INSIDE_NAMES = /\.(local|internal|localhost|lan|home|corp)$/;

export type WebhookEvent = "job.done" | "job.refused" | "job.waiting_for_owner" | "job.failed";

/** One announcement waiting to reach the client's tool. */
export interface Delivery {
  id: string;
  workspaceId: string;
  connectionId: string;
  jobId: string;
  event: WebhookEvent;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
  status: "pending" | "delivered" | "gave_up" | "dropped";
  /** The HTTP status of the last try, when the address answered at all. */
  lastStatus?: number;
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "t.body")>`: the time is signed with the body so a copy cannot be replayed later. */
export function signWebhook(secret: string, unixSeconds: number, body: string): string {
  return `t=${unixSeconds},v1=${createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex")}`;
}

/** What a receiver does: recompute the signature over the exact bytes received and refuse old timestamps. */
export function verifyWebhookSignature(secret: string, header: string | undefined, body: string, nowSeconds: number, toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const good = Buffer.from(signWebhook(secret, t, body));
  const got = Buffer.from(header!);
  return good.length === got.length && timingSafeEqual(good, got);
}

/** The shape of an address we are willing to call: https, a normal public name, the usual port, no login in it. */
export function checkWebhookUrl(raw: unknown): URL {
  const bad = new AgentError("The webhook address must be a normal https address, for example https://hooks.zapier.com/hooks/catch/123/abc.", "webhook_url_invalid");
  if (typeof raw !== "string" || !raw.trim() || raw.length > URL_MAX_CHARS) throw bad;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw bad; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || !HOST_SHAPE.test(host) || INSIDE_NAMES.test(host) || /^\d+(\.\d+){3}$/.test(host)) throw bad;
  return u;
}

/** Shape, then where the name really points: an address inside a network is refused. Checked when saved and before every send. */
export async function assertWebhookUrl(raw: unknown): Promise<URL> {
  const u = checkWebhookUrl(raw);
  try { await assertPublicHost(u.hostname, "The webhook address"); } catch { throw new AgentError("The webhook address could not be reached. Check it is a public https address.", "webhook_url_unreachable"); }
  return u;
}

export interface WebhookTarget { url: string; secret: string }

export interface WebhookDeps {
  now: () => Date;
  http?: typeof fetch;
  /** Where to send for a connection, or undefined when it has no webhook (or was removed). */
  target: (connectionId: string) => WebhookTarget | undefined;
  /** The JSON to send for a delivery, built at send time. Undefined means the event no longer applies. */
  payload: (d: Delivery) => Record<string, unknown> | undefined;
  /** Called on every change so the queue survives a restart. */
  save: (d: Delivery) => void;
  /** A webhook that was given up on after a day of tries. */
  gaveUp: (d: Delivery) => void;
}

/**
 * The connection's own delivery queue. An event is tried at once, then again with longer and longer waits from the
 * one-minute timer, and given up on after a day. Each send is signed, never follows a redirect, times out, and the
 * address is checked again first: a name that was public when saved may point somewhere else later.
 */
export class WebhookQueue {
  private waiting = new Map<string, Delivery>();
  private sending = new Set<string>();

  constructor(private readonly d: WebhookDeps) {}

  restore(x: Delivery): void {
    if (x.status === "pending") this.waiting.set(x.id, x); else this.waiting.delete(x.id);
  }

  /** Deliveries still to be made, oldest first. */
  pending(): Delivery[] {
    return [...this.waiting.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Lines up an event. Nothing is queued for a connection without a webhook. */
  enqueue(workspaceId: string, connectionId: string, jobId: string, event: WebhookEvent): Delivery | undefined {
    if (!this.d.target(connectionId)) return undefined;
    const at = this.d.now().toISOString();
    const item: Delivery = { id: newId("agent_delivery"), workspaceId, connectionId, jobId, event, createdAt: at, attempts: 0, nextAttemptAt: at, status: "pending" };
    this.keep(item);
    return item;
  }

  /** Sends everything that is due. Never throws. Returns how many were delivered. */
  async deliverDue(): Promise<number> {
    const nowIso = this.d.now().toISOString();
    const due = this.pending().filter((x) => x.nextAttemptAt <= nowIso && !this.sending.has(x.id));
    const results = await Promise.all(due.map((x) => this.attempt(x)));
    return results.filter(Boolean).length;
  }

  /** One signed POST. `ok` is true only for a 2xx answer. */
  async post(target: WebhookTarget, payload: Record<string, unknown>): Promise<{ ok: boolean; status?: number }> {
    try {
      const url = await assertWebhookUrl(target.url);
      const body = JSON.stringify(payload);
      const res = await (this.d.http ?? fetch)(url.toString(), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        headers: { "content-type": "application/json", "user-agent": "MAIZ-Agents-Webhook/1", [SIGNATURE_HEADER]: signWebhook(target.secret, Math.floor(this.d.now().getTime() / 1000), body) },
        body,
      });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false };
    }
  }

  private async attempt(item: Delivery): Promise<boolean> {
    this.sending.add(item.id);
    try {
      const target = this.d.target(item.connectionId);
      const payload = target ? this.d.payload(item) : undefined;
      if (!target || !payload) { this.keep({ ...item, status: "dropped" }); return false; }
      const r = await this.post(target, payload);
      const tried = { ...item, attempts: item.attempts + 1, ...(r.status !== undefined ? { lastStatus: r.status } : {}) };
      if (r.ok) { this.keep({ ...tried, status: "delivered" }); return true; }
      const nowMs = this.d.now().getTime();
      const next = nowMs + RETRY_AFTER_MS[Math.min(tried.attempts - 1, RETRY_AFTER_MS.length - 1)]!;
      if (next - Date.parse(item.createdAt) > GIVE_UP_AFTER_MS) {
        const lost: Delivery = { ...tried, status: "gave_up" };
        this.keep(lost);
        this.d.gaveUp(lost);
      } else {
        this.keep({ ...tried, nextAttemptAt: new Date(next).toISOString() });
      }
      return false;
    } finally {
      this.sending.delete(item.id);
    }
  }

  /** Stores the new state. Only deliveries still waiting stay in memory. */
  private keep(item: Delivery): void {
    if (item.status === "pending") this.waiting.set(item.id, item); else this.waiting.delete(item.id);
    this.d.save(item);
  }
}
