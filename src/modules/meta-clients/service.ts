import { randomBytes, randomInt } from "node:crypto";
import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import { PermissionError, type Permission } from "../identity/index.js";
import { MetaRejected, MetaUncertain, publishProblems } from "../meta/index.js";
import { META_PERMISSIONS, permissionsFor } from "./permissions.js";
import { MetaThrottled, MetaTokenInvalid, type MetaProvider } from "./provider.js";
import { parseSignedRequest } from "./signed-request.js";
import {
  DEFAULT_LIMITS, LIMIT_CEILING, MetaClientError,
  type AccountInsights, type ClientLimits, type DeletionRecord, type FoundAsset, type MetaConnection, type MetaKind, type MetaPost, type MetaSecret, type PermissionStatus, type ReviewState,
} from "./types.js";

export interface MetaClientOptions {
  provider: MetaProvider;
  /** Needed to read Meta's signed deauthorize / deletion calls. Without it those endpoints refuse everything. */
  appSecret?: string;
  /** Pre-approved WhatsApp template (one body variable) used for the first message of a conversation. */
  template: { name: string; language: string };
  /** Where a client can see the status of a deletion request (shown to Meta, then to the person). */
  deletionStatusUrl: (code: string) => string;
  access: { can(userId: string, workspaceId: string, p: Permission): boolean };
  audit?: AuditLog;
  now?: () => Date;
}

const WINDOW_MS = 24 * 3600_000;
const PENDING_MS = 15 * 60_000;
const MAX_TEXT = 6000;
const MAX_ATTEMPTS = 5;
const INSIGHT_CACHE_MS = 15 * 60_000;
const HEALTH_EVERY_MS = 12 * 3600_000;
const EXPIRY_WARN_MS = 7 * 86_400_000;
const MAX_SCHEDULE_DAYS = 30;

interface Pending { workspaceId: string; userId: string; kind: MetaKind; metaUserId: string; scopes: string[]; assets: FoundAsset[]; exp: number }

export const maskNumber = (n: string | undefined): string | undefined => (n ? `••••${n.slice(-4)}` : undefined);
/** Digits only, 8 to 15 of them. */
export const cleanNumber = (v: unknown): string | undefined => {
  const d = String(v ?? "").replace(/[\s()+.-]/g, "");
  return /^\d{8,15}$/.test(d) ? d : undefined;
};

/** What the client sees of a connection: never a token, never the full approver number. */
export function connectionView(c: MetaConnection) {
  const { metaUserId: _m, approverNumber, ...rest } = c;
  return { ...rest, approverNumber: maskNumber(approverNumber) };
}

export class MetaClientService {
  private conns = new Map<string, MetaConnection>();
  private secrets = new Map<string, MetaSecret>();
  private posts = new Map<string, MetaPost>();
  private limits = new Map<string, ClientLimits>();
  private reviews = new Map<string, PermissionStatus>();
  private deletions = new Map<string, DeletionRecord>();
  private pending = new Map<string, Pending>();
  private confirmCodes = new Map<string, { code: string; exp: number }>();
  private seenMessages: string[] = [];
  private busy = new Set<string>();
  private insightCache = new Map<string, AccountInsights>();
  private lastHealth = 0;
  private sink?: Sink;

  constructor(private readonly opts: MetaClientOptions) {}

  get mode() { return this.opts.provider.mode; }
  private now(): Date { return this.opts.now?.() ?? new Date(); }
  useSink(sink: Sink): void { this.sink = sink; }

  // ------------------------------------------------------------------ storage
  restore(kind: string, data: any): void {
    if (data?.deleted) return;
    if (kind === "meta_conn") this.conns.set(data.id, data);
    else if (kind === "meta_post") this.posts.set(data.id, data);
    else if (kind === "meta_limits") this.limits.set(data.workspaceId, data.limits);
  }
  restorePlatform(kind: string, data: any): void {
    if (kind === "meta_review") this.reviews.set(data.key, data);
    else if (kind === "meta_deletion") this.deletions.set(data.code, data);
  }
  restoreSecret(connectionId: string, secret: string): void {
    try { this.secrets.set(connectionId.replace(/^meta:/, ""), JSON.parse(secret)); } catch { /* an unreadable secret means reconnecting */ }
  }
  private saveConn(c: MetaConnection): MetaConnection { this.conns.set(c.id, c); this.sink?.record(c.workspaceId, "meta_conn", c.id, c); return c; }
  private savePost(p: MetaPost): MetaPost { this.posts.set(p.id, p); this.sink?.record(p.workspaceId, "meta_post", p.id, p); return p; }
  private saveSecret(c: MetaConnection, s: MetaSecret | undefined): void {
    if (s) this.secrets.set(c.id, s); else this.secrets.delete(c.id);
    this.sink?.integrationSecret(c.workspaceId, `meta:${c.id}`, s ? JSON.stringify(s) : "");
  }
  private log(workspaceId: string, actor: string, action: string, target: string): void { this.opts.audit?.record({ workspaceId, actor, action, target }); }

  private need(userId: string, ws: string, p: Permission): void {
    if (!this.opts.access.can(userId, ws, p)) throw new PermissionError("you do not have permission to do that for this business");
  }

  // ------------------------------------------------------------------ connect
  list(userId: string, ws: string) {
    this.need(userId, ws, "task.read");
    return [...this.conns.values()].filter((c) => c.workspaceId === ws && c.status !== "disconnected").map(connectionView);
  }

  /** What each connection type will ask for, in plain words, for the screen before the Meta window opens. */
  explain(kind: MetaKind): { key: string; plain: string }[] {
    return permissionsFor(kind).map((p) => ({ key: p.key, plain: p.plain }));
  }

  authorizeUrl(userId: string, ws: string, kind: MetaKind, state: string, redirectUri: string): string {
    this.need(userId, ws, "approval.decide");
    return this.opts.provider.authorizeUrl(kind, state, redirectUri);
  }

  /** The login came back with a code. Find what the person can choose; nothing is connected until they choose. */
  async completeLogin(userId: string, ws: string, kind: MetaKind, code: string, redirectUri: string) {
    this.need(userId, ws, "approval.decide");
    let found;
    try { found = await this.opts.provider.exchange(kind, code, redirectUri); }
    catch (e) { throw new MetaClientError(e instanceof Error && !(e instanceof MetaRejected) ? "That login could not be completed. Please try again." : (e as Error).message); }
    const granted = new Set(found.scopes);
    const missing = permissionsFor(kind).filter((p) => !granted.has(p.key) && this.mode === "live").map((p) => ({ key: p.key, plain: p.plain }));
    const id = randomBytes(18).toString("hex");
    this.sweepPending();
    this.pending.set(id, { workspaceId: ws, userId, kind, metaUserId: found.metaUserId, scopes: found.scopes, assets: found.assets, exp: this.now().getTime() + PENDING_MS });
    return { pendingId: id, choices: found.assets.map((a, i) => ({ index: i, name: a.name, handle: a.handle })), missing, simulated: this.mode === "sandbox" };
  }

  /** The person picked one of the accounts. Now (and only now) it is connected and its token stored. */
  async choose(userId: string, ws: string, pendingId: string, index: number): Promise<ReturnType<typeof connectionView>> {
    this.need(userId, ws, "approval.decide");
    const p = this.pending.get(pendingId);
    if (!p || p.exp < this.now().getTime() || p.workspaceId !== ws || p.userId !== userId) throw new MetaClientError("That choice has expired. Start the connection again.");
    const a = p.assets[index];
    if (!a) throw new MetaClientError("Choose one of the accounts shown.");
    this.pending.delete(pendingId);
    const c = this.attach(userId, ws, a, p.metaUserId, p.scopes);
    return connectionView(c);
  }

  private attach(userId: string, ws: string, a: FoundAsset, metaUserId: string, scopes: string[]): MetaConnection {
    // One connection per kind per business: choosing again replaces the old one (and its stored token).
    for (const old of this.conns.values()) if (old.workspaceId === ws && old.kind === a.kind && old.status !== "disconnected") this.dropConnection(old, "replaced");
    const c: MetaConnection = {
      id: newId("meta-connection"), workspaceId: ws, kind: a.kind, externalId: a.externalId, name: a.name, handle: a.handle, scopes, status: "connected", mode: this.mode,
      metaUserId, connectedBy: userId, connectedAt: this.now().toISOString(), expiresAt: a.expiresAt, pageId: a.pageId, wabaId: a.wabaId, phoneNumberId: a.phoneNumberId, displayNumber: a.displayNumber,
    };
    this.saveSecret(c, { accessToken: a.accessToken, expiresAt: a.expiresAt });
    this.saveConn(c);
    this.log(ws, `user:${userId}`, `meta.${a.kind}.connected`, c.id);
    return c;
  }

  /** WhatsApp Embedded Signup finished in the browser; its code and ids come here. */
  async connectWhatsApp(userId: string, ws: string, input: { code: string; wabaId: string; phoneNumberId: string; approverNumber: unknown }) {
    this.need(userId, ws, "approval.decide");
    const approver = cleanNumber(input.approverNumber);
    if (!approver) throw new MetaClientError("Enter your own mobile number with the country code, for example +44 7700 900123.");
    const idOk = this.mode === "sandbox" ? /^[\w-]{5,40}$/ : /^\d{5,25}$/;
    if (!idOk.test(input.wabaId) || !idOk.test(input.phoneNumberId)) throw new MetaClientError("WhatsApp did not report which number was connected. Try again.");
    let asset: FoundAsset;
    try { asset = await this.opts.provider.exchangeWhatsApp(input.code, input.wabaId, input.phoneNumberId); }
    catch (e) { throw new MetaClientError(e instanceof MetaRejected ? e.message : "WhatsApp could not be connected. Please try again."); }
    const c = this.attach(userId, ws, asset, "", permissionsFor("whatsapp").map((p) => p.key));
    const next = this.saveConn({ ...c, approverNumber: approver, approverConfirmed: false });
    await this.sendConfirmCode(next);
    return connectionView(this.conns.get(next.id)!);
  }

  async setApprover(userId: string, ws: string, connectionId: string, number: unknown) {
    this.need(userId, ws, "approval.decide");
    const c = this.ownConn(ws, connectionId);
    if (c.kind !== "whatsapp") throw new MetaClientError("Only a WhatsApp connection has an approver number.");
    const n = cleanNumber(number);
    if (!n) throw new MetaClientError("Enter your own mobile number with the country code, for example +44 7700 900123.");
    const next = this.saveConn({ ...c, approverNumber: n, approverConfirmed: false });
    await this.sendConfirmCode(next);
    return connectionView(next);
  }

  private async sendConfirmCode(c: MetaConnection): Promise<void> {
    const code = String(randomInt(100000, 1000000));
    this.confirmCodes.set(c.id, { code, exp: this.now().getTime() + 30 * 60_000 });
    await this.whatsappTo(c, `MAIZ Agents: to let this number approve your posts, reply CONFIRM ${code}. If this was not you, ignore this message.`);
  }

  private ownConn(ws: string, id: string): MetaConnection {
    const c = this.conns.get(id);
    if (!c || c.workspaceId !== ws || c.status === "disconnected") throw new MetaClientError("That connection was not found.");
    return c;
  }

  private dropConnection(c: MetaConnection, why: string): void {
    this.saveConn({ ...c, status: "disconnected", lastError: why });
    this.saveSecret(c, undefined);
    for (const p of this.posts.values()) {
      if (p.connectionId === c.id && ["awaiting_approval", "approved", "retry_wait"].includes(p.status)) this.savePost({ ...p, status: "cancelled", error: "The account was disconnected before this was posted." });
    }
    this.confirmCodes.delete(c.id);
  }

  async disconnect(userId: string, ws: string, connectionId: string): Promise<void> {
    this.need(userId, ws, "approval.decide");
    const c = this.ownConn(ws, connectionId);
    const s = this.secrets.get(c.id);
    if (s) await this.opts.provider.revoke(c, s).catch(() => undefined);
    this.dropConnection(c, "disconnected by the owner");
    this.log(ws, `user:${userId}`, `meta.${c.kind}.disconnected`, c.id);
  }

  /** The client asks us to forget everything we hold from Meta for their business. */
  async deleteMyMetaData(userId: string, ws: string): Promise<DeletionRecord> {
    this.need(userId, ws, "approval.decide");
    for (const c of [...this.conns.values()].filter((x) => x.workspaceId === ws && x.status !== "disconnected")) {
      const s = this.secrets.get(c.id);
      if (s) await this.opts.provider.revoke(c, s).catch(() => undefined);
    }
    const rec = this.eraseWhere((c) => c.workspaceId === ws, "client", ws);
    this.log(ws, `user:${userId}`, "meta.data_deleted", rec.code);
    return rec;
  }

  // -------------------------------------------------------- Meta's own callbacks
  /** Deauthorize: the person removed MAIZ in their Facebook settings. Stop using their tokens at once. */
  handleDeauthorize(signedRequest: unknown): boolean {
    const data = this.opts.appSecret ? parseSignedRequest(signedRequest, this.opts.appSecret) : undefined;
    if (!data) return false;
    for (const c of [...this.conns.values()]) if (c.metaUserId === data.user_id && c.status !== "disconnected") { this.dropConnection(c, "removed from Facebook settings"); this.log(c.workspaceId, "meta", "meta.deauthorized", c.id); }
    return true;
  }

  /** Data deletion: erase everything for that Meta user and give Meta a code and a page where they can check. */
  handleDeletion(signedRequest: unknown): { url: string; confirmation_code: string } | undefined {
    const data = this.opts.appSecret ? parseSignedRequest(signedRequest, this.opts.appSecret) : undefined;
    if (!data) return undefined;
    const rec = this.eraseWhere((c) => c.metaUserId === data.user_id, "meta_callback");
    return { url: this.opts.deletionStatusUrl(rec.code), confirmation_code: rec.code };
  }

  private eraseWhere(match: (c: MetaConnection) => boolean, via: DeletionRecord["via"], workspaceId?: string): DeletionRecord {
    const gone = [...this.conns.values()].filter(match);
    const ids = new Set(gone.map((c) => c.id));
    let posts = 0;
    for (const p of [...this.posts.values()]) if (ids.has(p.connectionId)) { this.posts.delete(p.id); this.sink?.record(p.workspaceId, "meta_post", p.id, { id: p.id, workspaceId: p.workspaceId, deleted: true }); posts++; }
    for (const c of gone) {
      this.saveSecret(c, undefined);
      this.conns.delete(c.id);
      this.insightCache.delete(c.id);
      // Overwritten with an empty tombstone so the stored copy no longer holds the name, ids or number.
      this.sink?.record(c.workspaceId, "meta_conn", c.id, { id: c.id, workspaceId: c.workspaceId, deleted: true });
    }
    const rec: DeletionRecord = { code: randomBytes(9).toString("hex"), at: this.now().toISOString(), via, removed: { connections: gone.length, posts }, ...(workspaceId ? { workspaceId } : {}) };
    this.deletions.set(rec.code, rec);
    this.sink?.promo("meta_deletion", rec.code, rec);
    return rec;
  }

  /** Public: the page Meta links to. Says only whether the request is done and how much was removed. */
  deletionStatus(code: unknown): { found: boolean; completedAt?: string; removed?: { connections: number; posts: number } } {
    const r = typeof code === "string" ? this.deletions.get(code) : undefined;
    return r ? { found: true, completedAt: r.at, removed: r.removed } : { found: false };
  }

  // -------------------------------------------------------------------- limits
  limitsFor(ws: string): ClientLimits { return this.limits.get(ws) ?? DEFAULT_LIMITS; }

  setLimits(ownerId: string, ws: string, raw: Partial<Record<keyof ClientLimits, unknown>>, isOwner: (u: string) => boolean): ClientLimits {
    if (!isOwner(ownerId)) throw new PermissionError("only the platform owner can change a client's limits");
    const cur = this.limitsFor(ws);
    const next = { ...cur };
    for (const k of Object.keys(DEFAULT_LIMITS) as (keyof ClientLimits)[]) {
      if (raw[k] === undefined) continue;
      const v = Number(raw[k]);
      if (!Number.isInteger(v) || v < 0 || v > LIMIT_CEILING[k]) throw new MetaClientError(`${k} must be a whole number from 0 to ${LIMIT_CEILING[k]}`);
      next[k] = v;
    }
    this.limits.set(ws, next);
    this.sink?.record(ws, "meta_limits", "main", { workspaceId: ws, limits: next });
    return next;
  }

  private usage(ws: string, connectionId: string): { today: number; month: number } {
    const n = this.now();
    const day = n.toISOString().slice(0, 10), month = n.toISOString().slice(0, 7);
    let today = 0, m = 0;
    for (const p of this.posts.values()) {
      if (p.connectionId !== connectionId || p.workspaceId !== ws || !p.postedAt) continue;
      if (p.postedAt.startsWith(month)) m++;
      if (p.postedAt.startsWith(day)) today++;
    }
    return { today, month: m };
  }

  /** Why one more post cannot go out now, or undefined. Counts posts already published plus those queued for the same day. */
  private capProblem(ws: string, connectionId: string, queuedAhead = 0): string | undefined {
    const lim = this.limitsFor(ws), u = this.usage(ws, connectionId);
    if (u.today + queuedAhead >= lim.postsPerDay) return `the daily limit of ${lim.postsPerDay} posts for this account is used up (it resets at midnight UTC)`;
    if (u.month + queuedAhead >= lim.postsPerMonth) return `the monthly limit of ${lim.postsPerMonth} posts for this account is used up`;
    return undefined;
  }

  // --------------------------------------------------------------------- posts
  listPosts(userId: string, ws: string): MetaPost[] {
    this.need(userId, ws, "task.read");
    return [...this.posts.values()].filter((p) => p.workspaceId === ws).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  }

  async draft(userId: string, ws: string, raw: { connectionId?: unknown; text?: unknown; imageUrl?: unknown; linkUrl?: unknown; scheduledFor?: unknown }): Promise<MetaPost> {
    this.need(userId, ws, "task.create");
    const c = this.ownConn(ws, String(raw.connectionId ?? ""));
    if (c.kind === "whatsapp") throw new MetaClientError("Posts go to a Facebook Page or an Instagram account.");
    if (c.status !== "connected") throw new MetaClientError("This account needs to be reconnected before it can post.");
    const text = String(raw.text ?? "").trim().slice(0, MAX_TEXT);
    const imageUrl = raw.imageUrl ? String(raw.imageUrl).trim() : undefined;
    const linkUrl = raw.linkUrl ? String(raw.linkUrl).trim() : undefined;
    const problems = publishProblems({ target: c.kind, message: text, imageUrl, linkUrl }, this.now());
    if (problems.length) throw new MetaClientError(`This post cannot be sent yet: ${problems.join("; ")}.`);
    let scheduledFor: string | undefined;
    if (raw.scheduledFor) {
      const t = new Date(String(raw.scheduledFor));
      const ahead = t.getTime() - this.now().getTime();
      if (!Number.isFinite(ahead) || ahead < 60_000) throw new MetaClientError("Pick a time at least a minute from now.");
      if (ahead > MAX_SCHEDULE_DAYS * 86_400_000) throw new MetaClientError(`Pick a time within ${MAX_SCHEDULE_DAYS} days.`);
      scheduledFor = t.toISOString();
    }
    const waiting = [...this.posts.values()].filter((p) => p.workspaceId === ws && p.status === "awaiting_approval").length;
    if (waiting >= this.limitsFor(ws).maxWaiting) throw new MetaClientError(`You already have ${waiting} posts waiting for approval. Approve or skip some first.`);
    const post: MetaPost = {
      id: newId("meta-post"), workspaceId: ws, connectionId: c.id, kind: c.kind, text, imageUrl, linkUrl, code: shortCode(), status: "awaiting_approval",
      createdAt: this.now().toISOString(), createdBy: userId, scheduledFor, attempts: 0,
    };
    this.savePost(post);
    void this.notifyApprover(ws, post);
    return post;
  }

  /** The approval gate. Only a person (dashboard) or the confirmed WhatsApp approver gets through it. */
  async decide(userId: string | undefined, ws: string, postId: string, verdict: "approve" | "reject", via: "dashboard" | "whatsapp" = "dashboard"): Promise<MetaPost> {
    if (via === "dashboard") this.need(userId ?? "", ws, "approval.decide");
    const p = this.posts.get(postId);
    if (!p || p.workspaceId !== ws) throw new MetaClientError("That post was not found.");
    if (p.status !== "awaiting_approval") throw new MetaClientError("That post has already been decided.");
    const who = via === "whatsapp" ? "whatsapp-approver" : userId!;
    if (verdict === "reject") {
      this.log(ws, who, "meta.post.rejected", p.id);
      return this.savePost({ ...p, status: "rejected", decidedBy: who, decidedVia: via, decidedAt: this.now().toISOString() });
    }
    const c = this.conns.get(p.connectionId);
    if (!c || c.status !== "connected") throw new MetaClientError("The account is not connected any more. Reconnect it first.");
    const queuedAhead = [...this.posts.values()].filter((x) => x.connectionId === p.connectionId && ["approved", "publishing", "retry_wait"].includes(x.status) && (!x.scheduledFor || x.scheduledFor.slice(0, 10) === (p.scheduledFor ?? this.now().toISOString()).slice(0, 10))).length;
    const cap = this.capProblem(ws, p.connectionId, queuedAhead);
    if (cap) throw new MetaClientError(`Not approved: ${cap}.`);
    this.log(ws, who, "meta.post.approved", p.id);
    const approved = this.savePost({ ...p, status: "approved", decidedBy: who, decidedVia: via, decidedAt: this.now().toISOString() });
    if (!approved.scheduledFor) await this.publish(approved.id);
    return this.posts.get(approved.id)!;
  }

  /** Publishes one approved post if it is due. Safe to call twice: a post is only ever in flight once. */
  async publish(postId: string): Promise<void> {
    const p = this.posts.get(postId);
    if (!p || !["approved", "retry_wait"].includes(p.status) || this.busy.has(postId)) return;
    const now = this.now();
    if ((p.scheduledFor && new Date(p.scheduledFor) > now) || (p.retryAt && new Date(p.retryAt) > now)) return;
    const c = this.conns.get(p.connectionId);
    const s = c && this.secrets.get(c.id);
    if (!c || !s || c.status !== "connected") { this.savePost({ ...p, status: "failed", error: "The account is not connected, so this was not posted." }); return; }
    if (c.pausedUntil && new Date(c.pausedUntil) > now) { this.savePost({ ...p, status: "retry_wait", retryAt: c.pausedUntil }); return; }
    const cap = this.capProblem(p.workspaceId, c.id);
    if (cap) { this.savePost({ ...p, status: "retry_wait", retryAt: nextUtcMidnight(now), error: `Waiting: ${cap}.` }); return; }
    this.busy.add(postId);
    try {
      const ing = this.savePost({ ...p, status: "publishing", attempts: p.attempts + 1 });
      try {
        const out = await this.opts.provider.publish(c, s, { target: c.kind as "facebook" | "instagram", message: p.text, imageUrl: p.imageUrl, linkUrl: p.linkUrl });
        this.savePost({ ...ing, status: "posted", postedAt: this.now().toISOString(), externalId: out.id, url: out.url, simulated: out.simulated, error: undefined, retryAt: undefined });
        this.log(p.workspaceId, "system", "meta.post.published", p.id);
      } catch (e) {
        this.afterFailure(ing, c, e);
      }
    } finally { this.busy.delete(postId); }
  }

  private afterFailure(p: MetaPost, c: MetaConnection, e: unknown): void {
    if (e instanceof MetaThrottled) {
      const until = new Date(this.now().getTime() + e.retryAfterMs * 2 ** Math.max(0, p.attempts - 1)).toISOString();
      this.saveConn({ ...c, pausedUntil: until, lastError: "Meta asked us to slow down" });
      if (p.attempts >= MAX_ATTEMPTS) this.savePost({ ...p, status: "failed", error: "Meta kept asking us to slow down, so this was not posted. Try again later." });
      else this.savePost({ ...p, status: "retry_wait", retryAt: until, error: "Meta asked us to slow down. It will be tried again automatically." });
    } else if (e instanceof MetaTokenInvalid) {
      this.saveConn({ ...c, status: "needs_reconnect", lastError: "Facebook says the permission was withdrawn" });
      this.savePost({ ...p, status: "failed", error: "Your connection needs renewing. Reconnect the account, then send this post again." });
    } else if (e instanceof MetaUncertain) {
      // It may have gone out. Never retry automatically: that could post twice.
      this.savePost({ ...p, status: "failed", error: `${e.message}` });
    } else this.savePost({ ...p, status: "failed", error: e instanceof MetaRejected ? e.message : "The post could not be sent." });
  }

  async cancel(userId: string, ws: string, postId: string): Promise<MetaPost> {
    this.need(userId, ws, "approval.decide");
    const p = this.posts.get(postId);
    if (!p || p.workspaceId !== ws) throw new MetaClientError("That post was not found.");
    if (!["awaiting_approval", "approved", "retry_wait"].includes(p.status)) throw new MetaClientError("That post can no longer be cancelled.");
    return this.savePost({ ...p, status: "cancelled" });
  }

  async refreshResults(userId: string, ws: string, postId: string): Promise<MetaPost> {
    this.need(userId, ws, "task.read");
    const p = this.posts.get(postId);
    if (!p || p.workspaceId !== ws || p.status !== "posted" || !p.externalId) throw new MetaClientError("Results are available once a post is published.");
    const c = this.conns.get(p.connectionId), s = c && this.secrets.get(c.id);
    if (!c || !s || c.status !== "connected") throw new MetaClientError("Reconnect the account to read results.");
    try { return this.savePost({ ...p, results: await this.opts.provider.results(c, s, p.externalId, this.now()) }); }
    catch (e) { throw this.readFailure(c, e); }
  }

  async insights(userId: string, ws: string) {
    this.need(userId, ws, "task.read");
    const out: { connectionId: string; kind: MetaKind; name: string; insights?: AccountInsights; error?: string }[] = [];
    for (const c of [...this.conns.values()].filter((x) => x.workspaceId === ws && x.status === "connected" && x.kind !== "whatsapp")) {
      const cached = this.insightCache.get(c.id), s = this.secrets.get(c.id);
      if (cached && this.now().getTime() - Date.parse(cached.fetchedAt) < INSIGHT_CACHE_MS) { out.push({ connectionId: c.id, kind: c.kind, name: c.name, insights: cached }); continue; }
      try {
        const i = await this.opts.provider.insights(c, s!, this.now());
        this.insightCache.set(c.id, i);
        out.push({ connectionId: c.id, kind: c.kind, name: c.name, insights: i });
      } catch (e) { out.push({ connectionId: c.id, kind: c.kind, name: c.name, error: this.readFailure(c, e).message }); }
    }
    return out;
  }

  private readFailure(c: MetaConnection, e: unknown): Error {
    if (e instanceof MetaTokenInvalid) { this.saveConn({ ...c, status: "needs_reconnect", lastError: "Facebook says the permission was withdrawn" }); return new MetaClientError("Your connection needs renewing. Reconnect the account."); }
    if (e instanceof MetaThrottled) return new MetaClientError("Meta is limiting requests right now. Try again in a few minutes.");
    return new MetaClientError(e instanceof MetaRejected ? e.message : "Results could not be read just now.");
  }

  // ------------------------------------------------------------------ WhatsApp
  private async whatsappTo(c: MetaConnection, text: string): Promise<void> {
    const s = this.secrets.get(c.id);
    if (!s || !c.approverNumber) return;
    const inWindow = c.lastInboundAt && this.now().getTime() - Date.parse(c.lastInboundAt) < WINDOW_MS;
    try {
      await this.opts.provider.sendWhatsApp(c, s, c.approverNumber, inWindow ? { text } : { template: this.opts.template, body: text });
    } catch (e) {
      this.saveConn({ ...(this.conns.get(c.id) ?? c), lastError: e instanceof MetaTokenInvalid ? "WhatsApp needs reconnecting" : "A WhatsApp message could not be sent" });
    }
  }

  /** Tells the owner's confirmed WhatsApp number that something is waiting. Never throws. */
  async notifyApprover(ws: string, post: MetaPost): Promise<void> {
    const wa = [...this.conns.values()].find((c) => c.workspaceId === ws && c.kind === "whatsapp" && c.status === "connected" && c.approverConfirmed);
    if (!wa) return;
    const where = post.kind === "facebook" ? "Facebook" : "Instagram";
    await this.whatsappTo(wa, `A ${where} post is waiting for you:\n"${post.text.slice(0, 300)}"\nReply YES ${post.code} to post it or NO ${post.code} to skip it.`);
  }

  /** Meta's webhook body. Returns how many messages were from an approver. Only a confirmed approver number is ever obeyed. */
  async handleWhatsApp(payload: unknown): Promise<number> {
    let handled = 0;
    for (const entry of Array.isArray((payload as any)?.entry) ? (payload as any).entry : []) for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = ch?.value;
      const phoneId = String(v?.metadata?.phone_number_id ?? "");
      const c = [...this.conns.values()].find((x) => x.kind === "whatsapp" && x.status === "connected" && x.phoneNumberId === phoneId);
      if (!c) continue;
      for (const m of Array.isArray(v?.messages) ? v.messages : []) {
        if (typeof m?.id !== "string" || typeof m?.from !== "string" || this.seenMessages.includes(m.id)) continue;
        this.seenMessages.push(m.id);
        if (this.seenMessages.length > 500) this.seenMessages.shift();
        if (m.from.replace(/\D/g, "") !== c.approverNumber) continue;
        handled++;
        const live = this.saveConn({ ...(this.conns.get(c.id) ?? c), lastInboundAt: this.now().toISOString() });
        const text = m.type === "text" && typeof m.text?.body === "string" ? m.text.body.slice(0, 200) : "";
        await this.reply(live, text).catch(() => undefined);
      }
    }
    return handled;
  }

  private async reply(c: MetaConnection, text: string): Promise<void> {
    const t = text.trim().toLowerCase();
    const confirm = /^confirm\s+(\d{6})$/.exec(t);
    if (confirm) {
      const want = this.confirmCodes.get(c.id);
      if (!want || want.exp < this.now().getTime() || want.code !== confirm[1]) return this.whatsappTo(c, "That code is not right or has expired. Ask for a new one in MAIZ.");
      this.confirmCodes.delete(c.id);
      const live = this.saveConn({ ...c, approverConfirmed: true });
      this.log(c.workspaceId, "whatsapp-approver", "meta.whatsapp.approver_confirmed", c.id);
      return this.whatsappTo(live, "Thanks, this number can now approve your posts. You will hear from me when one is waiting.");
    }
    if (!c.approverConfirmed) return;
    const waiting = [...this.posts.values()].filter((p) => p.workspaceId === c.workspaceId && p.status === "awaiting_approval");
    const m = /^(yes|approve|y|ok|post it|no|skip|reject|n)(?:\s+([a-z0-9]{4}))?\b/.exec(t);
    if (!m) return this.whatsappTo(c, waiting.length ? `You have ${waiting.length} post${waiting.length === 1 ? "" : "s"} waiting. Reply YES or NO with the code in my message, for example YES ${waiting[0]!.code}.` : "Nothing is waiting for you right now.");
    const verdict = /^(yes|approve|y|ok|post it)$/.test(m[1]!) ? "approve" : "reject";
    const target = m[2] ? waiting.find((p) => p.code.toLowerCase() === m[2]) : waiting.length === 1 ? waiting[0] : undefined;
    if (!target) return this.whatsappTo(c, waiting.length ? `Which one? Reply ${verdict === "approve" ? "YES" : "NO"} and the code, for example ${verdict === "approve" ? "YES" : "NO"} ${waiting[0]!.code}.` : "Nothing is waiting for you right now.");
    try {
      const done = await this.decide(undefined, c.workspaceId, target.id, verdict, "whatsapp");
      await this.whatsappTo(c, done.status === "rejected" ? "Skipped. I will not post it." : done.status === "posted" ? `Posted: ${done.url}` : done.scheduledFor ? `Approved. It will go out at ${done.scheduledFor.slice(0, 16).replace("T", " ")} UTC.` : "Approved. It is being posted.");
    } catch (e) { await this.whatsappTo(c, e instanceof MetaClientError ? e.message : "That did not work. Please use the MAIZ dashboard."); }
  }

  // --------------------------------------------------------------- maintenance
  /** Called every minute: publishes what is due, and twice a day checks that every saved token still works. */
  async maintenance(): Promise<void> {
    for (const p of [...this.posts.values()]) if (["approved", "retry_wait"].includes(p.status)) await this.publish(p.id);
    const now = this.now().getTime();
    if (now - this.lastHealth < HEALTH_EVERY_MS) return;
    this.lastHealth = now;
    for (const c of [...this.conns.values()].filter((x) => x.status === "connected")) {
      const s = this.secrets.get(c.id);
      if (!s) continue;
      try {
        const r = await this.opts.provider.inspect(s);
        const iso = this.now().toISOString();
        if (!r.valid) this.saveConn({ ...c, status: "needs_reconnect", lastCheckedAt: iso, lastError: "The permission is no longer valid" });
        else this.saveConn({ ...c, lastCheckedAt: iso, expiresAt: r.expiresAt ?? c.expiresAt, lastError: r.expiresAt && Date.parse(r.expiresAt) - now < EXPIRY_WARN_MS ? "Needs renewing soon" : undefined });
      } catch { /* Meta unreachable: try again at the next check, do not mark anyone as disconnected */ }
    }
  }

  // ------------------------------------------------------------- sandbox helpers
  /** Sandbox only: the payload Meta would send if the approver replied with `text`. */
  sandboxApproverPayload(userId: string, ws: string, connectionId: string, text: string): unknown | undefined {
    if (this.mode !== "sandbox") return undefined;
    this.need(userId, ws, "approval.decide");
    const c = this.conns.get(connectionId);
    if (!c || c.workspaceId !== ws || c.kind !== "whatsapp" || !c.approverNumber) return undefined;
    return { entry: [{ changes: [{ value: { metadata: { phone_number_id: c.phoneNumberId }, messages: [{ id: `sandbox-msg-${randomBytes(6).toString("hex")}`, from: c.approverNumber, type: "text", text: { body: text } }] } }] }] };
  }
  sandboxOutbox(userId: string, ws: string): { at: string; text: string; template?: string }[] {
    this.need(userId, ws, "task.read");
    const p = this.opts.provider as unknown as { outbox?: { to: string; at: string; text: string; template?: string }[] };
    const numbers = new Set([...this.conns.values()].filter((c) => c.workspaceId === ws && c.approverNumber).map((c) => c.approverNumber));
    return (p.outbox ?? []).filter((m) => numbers.has(m.to)).slice(-30).map(({ at, text, template }) => ({ at, text, template }));
  }

  // ---------------------------------------------------------------- owner view
  private sweepPending(): void { const n = this.now().getTime(); for (const [k, v] of this.pending) if (v.exp < n) this.pending.delete(k); }

  permissionStatuses(): (PermissionStatus & { plain: string; kinds: MetaKind[] })[] {
    return META_PERMISSIONS.map((p) => ({ key: p.key, plain: p.plain, kinds: p.kinds, state: this.reviews.get(p.key)?.state ?? "not_submitted", note: this.reviews.get(p.key)?.note, updatedAt: this.reviews.get(p.key)?.updatedAt ?? "" }));
  }

  setPermissionStatus(ownerId: string, key: unknown, state: unknown, note: unknown, isOwner: (u: string) => boolean): PermissionStatus {
    if (!isOwner(ownerId)) throw new PermissionError("only the platform owner can record Meta's decisions");
    if (!META_PERMISSIONS.some((p) => p.key === key)) throw new MetaClientError("unknown permission");
    if (!["not_submitted", "in_review", "approved", "rejected"].includes(String(state))) throw new MetaClientError("state must be not_submitted, in_review, approved or rejected");
    const rec: PermissionStatus = { key: String(key), state: state as ReviewState, note: note ? String(note).slice(0, 500) : undefined, updatedAt: this.now().toISOString() };
    this.reviews.set(rec.key, rec);
    this.sink?.promo("meta_review", rec.key, rec);
    return rec;
  }

  /** Counts for the owner's status page. No names, no tokens. */
  overview(ownerId: string, isOwner: (u: string) => boolean) {
    if (!isOwner(ownerId)) throw new PermissionError("only the platform owner can see this");
    const all = [...this.conns.values()].filter((c) => c.status !== "disconnected");
    const byKind = (k: MetaKind) => ({ connected: all.filter((c) => c.kind === k && c.status === "connected").length, needsReconnect: all.filter((c) => c.kind === k && c.status === "needs_reconnect").length });
    const posts = [...this.posts.values()];
    return {
      mode: this.mode,
      businesses: new Set(all.map((c) => c.workspaceId)).size,
      connections: { facebook: byKind("facebook"), instagram: byKind("instagram"), whatsapp: byKind("whatsapp") },
      posts: { waiting: posts.filter((p) => p.status === "awaiting_approval").length, posted: posts.filter((p) => p.status === "posted").length, failed: posts.filter((p) => p.status === "failed").length, retrying: posts.filter((p) => p.status === "retry_wait").length },
      deletions: this.deletions.size,
      permissions: this.permissionStatuses(),
    };
  }
}

const shortCode = (): string => {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 4 }, () => a[randomInt(a.length)]).join("").toUpperCase();
};
const nextUtcMidnight = (d: Date): string => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5)).toISOString();
