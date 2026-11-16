import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import { MAX_PAYLOAD_BYTES, encryptPayload, generateVapidKeys, isVapidKeys, vapidAuthorization, type PushTarget, type VapidKeys } from "./webpush.js";

export * from "./webpush.js";

export class PushError extends Error {}

/** One browser (or installed app) that asked to be told when something happens. */
export interface PushSubscriptionRecord extends PushTarget {
  id: string;
  userId: string;
  /** The client's workspace. Left out for the platform owner, who is told about decisions waiting. */
  workspaceId?: string;
  createdAt: string;
  /** Set when the browser unsubscribed or the push service said the subscription is gone. Kept so storage can forget it. */
  removed?: boolean;
}

export interface PushMessage {
  title: string;
  body?: string;
  /** A path on this site to open when the notification is tapped. */
  link?: string;
  /** Notifications with the same tag replace each other instead of stacking. */
  tag?: string;
}

export interface PushOptions {
  /** Who the push service may contact about this sender: the site's https address or a mailto: address. */
  subject: string;
  now: () => Date;
  http?: typeof fetch;
}

/** The name the sender's key pair is stored under, alongside the owner's other encrypted connection details. */
export const VAPID_STORE_KEY = "push:vapid";
export const MAX_SUBSCRIPTIONS_PER_USER = 8;
/** How long a push service keeps a message for a device that is switched off. */
const TTL_SECONDS = 12 * 3600;
const SEND_TIMEOUT_MS = 8_000;
const ENDPOINT_MAX = 1_000;
/**
 * Only the push services browsers actually use. The address comes from the browser, so without this list the server
 * could be told to call any address at all.
 */
const PUSH_HOSTS: readonly RegExp[] = [
  /^fcm\.googleapis\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
];
const B64U = /^[A-Za-z0-9_-]+$/;
const safeLink = (l: string | undefined): string | undefined => (l && /^\/[\w\-./#?=&]*$/.test(l) && !l.startsWith("//") ? l : undefined);
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function isPushEndpoint(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > ENDPOINT_MAX) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  return url.protocol === "https:" && !url.username && !url.password && (url.port === "" || url.port === "443") && PUSH_HOSTS.some((h) => h.test(url.hostname));
}

/**
 * Real push notifications: the browser's push service wakes the device even when MAIZ is closed. Each message is
 * encrypted for one browser and signed with this server's own key pair, made on first use and stored encrypted, so
 * there is nothing for anyone to set up. A subscription the push service reports as gone is forgotten.
 */
export class PushService {
  private subs = new Map<string, PushSubscriptionRecord>();
  private keys?: VapidKeys;
  private sink?: Sink;
  readonly stats = { sent: 0, failed: 0, removed: 0 };

  constructor(private readonly o: PushOptions) {}

  useSink(sink: Sink): void {
    this.sink = sink;
    // Keys made before storage was attached are saved now, so subscriptions survive the next restart.
    if (this.keys) sink.connectionSecret(VAPID_STORE_KEY, JSON.stringify(this.keys));
  }

  restoreKeys(secret: string): void {
    try {
      const v: unknown = JSON.parse(secret);
      if (isVapidKeys(v)) this.keys = { publicKey: v.publicKey, privateKey: v.privateKey };
    } catch { /* unreadable: a new pair is made on first use */ }
  }

  restore(s: PushSubscriptionRecord): void {
    if (s.removed) this.subs.delete(s.id); else this.subs.set(s.id, s);
  }

  /** The key the browser subscribes with. Made on first use. */
  publicKey(): string {
    return this.vapid().publicKey;
  }

  private vapid(): VapidKeys {
    if (!this.keys) {
      this.keys = generateVapidKeys();
      this.sink?.connectionSecret(VAPID_STORE_KEY, JSON.stringify(this.keys));
    }
    return this.keys;
  }

  /** Remembers a browser's subscription for this person. Subscribing the same browser again replaces the old entry. */
  subscribe(userId: string, workspaceId: string | undefined, raw: unknown): PushSubscriptionRecord {
    const s = (raw ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    if (!isPushEndpoint(s.endpoint)) throw new PushError("this browser's notification address is not one we can send to");
    const p256dh = s.keys?.p256dh, auth = s.keys?.auth;
    if (typeof p256dh !== "string" || typeof auth !== "string" || !B64U.test(p256dh) || !B64U.test(auth) || Buffer.from(p256dh, "base64url").length !== 65 || Buffer.from(auth, "base64url").length !== 16) {
      throw new PushError("this browser did not send its notification keys");
    }
    const mine = this.of(userId);
    const same = mine.find((x) => x.endpoint === s.endpoint);
    if (!same && mine.length >= MAX_SUBSCRIPTIONS_PER_USER) this.drop(mine.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!);
    const rec: PushSubscriptionRecord = {
      id: same?.id ?? newId("push"), userId, ...(workspaceId ? { workspaceId } : {}), endpoint: s.endpoint, keys: { p256dh, auth }, createdAt: this.o.now().toISOString(),
    };
    this.save(rec);
    return rec;
  }

  /** Forgets one browser. Only the person who subscribed it can remove it. */
  unsubscribe(userId: string, endpoint: unknown): boolean {
    const s = this.of(userId).find((x) => x.endpoint === endpoint);
    if (!s) return false;
    this.drop(s);
    return true;
  }

  count(userId: string): number {
    return this.of(userId).length;
  }

  /** Tells every subscribed browser of everyone in a workspace. Never throws: push is a courtesy on top of the bell. */
  async sendToWorkspace(workspaceId: string, m: PushMessage): Promise<number> {
    return this.sendAll([...this.subs.values()].filter((s) => s.workspaceId === workspaceId), m);
  }

  /** Tells one person's browsers (the platform owner's decisions, or a test from Settings). */
  async sendToUser(userId: string, m: PushMessage): Promise<number> {
    return this.sendAll(this.of(userId), m);
  }

  private of(userId: string): PushSubscriptionRecord[] {
    return [...this.subs.values()].filter((s) => s.userId === userId);
  }

  private async sendAll(targets: PushSubscriptionRecord[], m: PushMessage): Promise<number> {
    if (!targets.length) return 0;
    const link = safeLink(m.link);
    const payload = Buffer.from(JSON.stringify({ title: clip(m.title, 120), ...(m.body ? { body: clip(m.body, 300) } : {}), ...(link ? { link } : {}), ...(m.tag ? { tag: clip(m.tag, 60) } : {}) }), "utf8");
    if (payload.length > MAX_PAYLOAD_BYTES) return 0;
    const results = await Promise.all(targets.map((t) => this.sendOne(t, payload)));
    return results.filter(Boolean).length;
  }

  private async sendOne(s: PushSubscriptionRecord, payload: Buffer): Promise<boolean> {
    // Checked again at send time: a stored address is never trusted more than a typed one.
    if (!isPushEndpoint(s.endpoint)) { this.drop(s); return false; }
    try {
      const res = await (this.o.http ?? fetch)(s.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: {
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(TTL_SECONDS),
          urgency: "normal",
          authorization: vapidAuthorization(s.endpoint, this.vapid(), this.o.subject, this.o.now().getTime()),
        },
        body: new Uint8Array(encryptPayload(s, payload)),
      });
      // 404 and 410 mean the browser unsubscribed or the subscription expired: stop sending to it.
      if (res.status === 404 || res.status === 410) { this.drop(s); return false; }
      if (!res.ok) { this.stats.failed++; return false; }
      this.stats.sent++;
      return true;
    } catch {
      this.stats.failed++;
      return false;
    }
  }

  private drop(s: PushSubscriptionRecord): void {
    this.subs.delete(s.id);
    this.stats.removed++;
    // The keys are blanked in storage: a removed subscription has no reason to keep them.
    this.sink?.promo("push_sub", s.id, { id: s.id, userId: s.userId, removed: true });
  }

  private save(s: PushSubscriptionRecord): void {
    this.subs.set(s.id, s);
    this.sink?.promo("push_sub", s.id, s);
  }
}
