import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";
import { cleanLimits, cleanName, cleanTool, employeeKey, hashKey, looksLikeKey, newKey, newSigningSecret, sameHash } from "./keys.js";
import {
  AgentError, AgentRefusal, CUSTOMER_SUPPORT_KEY, DEFAULT_LIMITS, KEY_LIFETIME_DAYS, MAX_CONNECTIONS_PER_WORKSPACE, NEVER_ALLOWED,
  type AgentConnection,
} from "./types.js";
import { assertWebhookUrl } from "./webhooks.js";

const DAY_MS = 86_400_000;
const MAX_EMPLOYEES_LISTED = 20;
/** The name a connection's signing secret is stored under, with the platform's other encrypted secrets. */
export const AGENT_SECRET_PREFIX = "agent:whsec:";
/** The member a connection's jobs run as: never a person, never the owner. */
export const principalOf = (connectionId: string): string => `agent:${connectionId}`;

/** One employee of a workspace, as an outside tool may (or may not) use it. */
export interface RosterEntry {
  key: string;
  employeeId: string;
  title: string;
  summary: string;
  canDo: readonly string[];
  allowed: boolean;
  /** Why it can never be allowed. */
  reason?: string;
}

export interface BookDeps {
  identity: Pick<IdentityService, "require" | "addMember">;
  audit: Pick<AuditLog, "record">;
  /** The workspace's employees, read as the given member. */
  roster: (asUserId: string, workspaceId: string) => RosterEntry[];
  now: () => Date;
  sink: () => Sink | undefined;
}

export interface Issued { connection: AgentConnection; key: string; signingSecret?: string }

/**
 * A client's connections and their keys. Only the owner (workspace.manage) can make, change, pause or remove one.
 * A key is shown once: what is kept is its SHA-256 and its first characters. Records are replaced, never edited in place.
 */
export class ConnectionBook {
  private byId = new Map<string, AgentConnection>();
  /** Key hash to connection id, so a call is matched without reading every connection. */
  private byHash = new Map<string, string>();
  private secrets = new Map<string, string>();

  constructor(private readonly d: BookDeps) {}

  restore(c: AgentConnection): void {
    const old = this.byId.get(c.id);
    if (old) this.byHash.delete(old.keyHash);
    if (c.removed) { this.byId.delete(c.id); return; }
    this.byId.set(c.id, c);
    this.byHash.set(c.keyHash, c.id);
  }

  restoreSecret(storeKey: string, secret: string): void {
    const id = storeKey.slice(AGENT_SECRET_PREFIX.length);
    if (secret) this.secrets.set(id, secret); else this.secrets.delete(id);
  }

  get(id: string): AgentConnection | undefined { return this.byId.get(id); }
  secretOf(id: string): string | undefined { return this.secrets.get(id); }
  all(): AgentConnection[] { return [...this.byId.values()]; }

  list(workspaceId: string): AgentConnection[] {
    return this.all().filter((c) => c.workspaceId === workspaceId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** A connection of this workspace. One from another workspace looks exactly like one that does not exist. */
  own(workspaceId: string, id: string): AgentConnection {
    const c = this.byId.get(id);
    if (!c || c.workspaceId !== workspaceId) throw new AgentRefusal(404, "That connection was not found.", "not_found");
    return c;
  }

  /** The live connection a key belongs to. Undefined for an unknown, expired or paused key: the caller says the same thing for all. */
  byKey(key: unknown): AgentConnection | undefined {
    if (!looksLikeKey(key)) return undefined;
    const hash = hashKey(key);
    const c = this.byId.get(this.byHash.get(hash) ?? "");
    if (!c || !sameHash(c.keyHash, hash)) return undefined;
    if (c.status !== "active" || Date.parse(c.keyExpiresAt) <= this.d.now().getTime()) return undefined;
    return c;
  }

  async create(userId: string, workspaceId: string, raw: unknown): Promise<Issued> {
    this.d.identity.require(userId, workspaceId, "workspace.manage");
    const b = asObject(raw);
    if (this.list(workspaceId).length >= MAX_CONNECTIONS_PER_WORKSPACE) throw new AgentError(`You can have up to ${MAX_CONNECTIONS_PER_WORKSPACE} connections. Remove one you no longer use first.`, "too_many_connections");
    const name = cleanName(b.name);
    const employees = this.chooseEmployees(userId, workspaceId, b.employees);
    const limits = cleanLimits(b.limits, DEFAULT_LIMITS);
    const webhookUrl = b.webhookUrl ? (await assertWebhookUrl(b.webhookUrl)).toString() : undefined;
    const issued = newKey();
    const at = this.d.now();
    const connection: AgentConnection = {
      id: newId("agent_conn"), workspaceId, name, tool: cleanTool(b.tool), employees, needsApproval: b.needsApproval === true, limits,
      ...(webhookUrl ? { webhookUrl } : {}),
      keyHash: issued.hash, keyPrefix: issued.prefix, keyCreatedAt: at.toISOString(), keyExpiresAt: this.expiry(at),
      status: "active", createdBy: userId, createdAt: at.toISOString(), updatedAt: at.toISOString(),
    };
    // Jobs run as this member, never as the owner: it may create and read tasks and nothing else.
    this.d.identity.addMember(userId, workspaceId, principalOf(connection.id), "member");
    const signingSecret = newSigningSecret();
    this.saveSecret(connection.id, signingSecret);
    this.save(connection);
    this.d.audit.record({ workspaceId, actor: `user:${userId}`, action: "agent.created", target: connection.id, data: { name, tool: connection.tool, employees, needsApproval: connection.needsApproval, limits, webhook: !!webhookUrl } });
    return { connection, key: issued.key, signingSecret };
  }

  /** Changes the name, employees, approval rule, limits or webhook address. Anything left out stays as it is. */
  async update(userId: string, workspaceId: string, id: string, raw: unknown): Promise<AgentConnection> {
    this.d.identity.require(userId, workspaceId, "workspace.manage");
    const c = this.own(workspaceId, id);
    const b = asObject(raw);
    const clearWebhook = b.webhookUrl === null || b.webhookUrl === "";
    const webhookUrl = b.webhookUrl && !clearWebhook ? (await assertWebhookUrl(b.webhookUrl)).toString() : undefined;
    const { webhookUrl: oldUrl, ...rest } = c;
    const keptUrl = clearWebhook ? undefined : webhookUrl ?? oldUrl;
    const next: AgentConnection = {
      ...rest,
      name: b.name === undefined ? c.name : cleanName(b.name),
      tool: b.tool === undefined ? c.tool : cleanTool(b.tool),
      employees: b.employees === undefined ? c.employees : this.chooseEmployees(userId, workspaceId, b.employees),
      needsApproval: typeof b.needsApproval === "boolean" ? b.needsApproval : c.needsApproval,
      limits: cleanLimits(b.limits, c.limits),
      ...(keptUrl ? { webhookUrl: keptUrl } : {}),
      updatedAt: this.d.now().toISOString(),
    };
    this.save(next);
    this.d.audit.record({ workspaceId, actor: `user:${userId}`, action: "agent.updated", target: id, data: { name: next.name, employees: next.employees, needsApproval: next.needsApproval, limits: next.limits, webhook: !!next.webhookUrl } });
    return next;
  }

  /** A new key. The old one stops working at once. With `withSecret` the webhook signing secret is replaced too. */
  rotate(userId: string, workspaceId: string, id: string, withSecret = false): Issued {
    this.d.identity.require(userId, workspaceId, "workspace.manage");
    const c = this.own(workspaceId, id);
    const issued = newKey();
    const at = this.d.now();
    const next: AgentConnection = { ...c, keyHash: issued.hash, keyPrefix: issued.prefix, keyCreatedAt: at.toISOString(), keyExpiresAt: this.expiry(at), expiryWarned: false, updatedAt: at.toISOString() };
    this.save(next);
    const signingSecret = withSecret ? newSigningSecret() : undefined;
    if (signingSecret) this.saveSecret(id, signingSecret);
    this.d.audit.record({ workspaceId, actor: `user:${userId}`, action: "agent.key_replaced", target: id, data: { name: c.name, signingSecret: withSecret } });
    return { connection: next, key: issued.key, ...(signingSecret ? { signingSecret } : {}) };
  }

  /** Pause rejects every call at once and keeps the history; resume lets the same key work again. */
  setStatus(userId: string, workspaceId: string, id: string, status: "active" | "paused"): AgentConnection {
    this.d.identity.require(userId, workspaceId, "workspace.manage");
    const c = this.own(workspaceId, id);
    if (c.status === status) return c;
    const next: AgentConnection = { ...c, status, updatedAt: this.d.now().toISOString() };
    this.save(next);
    this.d.audit.record({ workspaceId, actor: `user:${userId}`, action: status === "paused" ? "agent.paused" : "agent.resumed", target: id, data: { name: c.name } });
    return next;
  }

  /** Removes the connection, its key and its signing secret for good. */
  remove(userId: string, workspaceId: string, id: string): AgentConnection {
    this.d.identity.require(userId, workspaceId, "workspace.manage");
    const c = this.own(workspaceId, id);
    this.byId.delete(id);
    this.byHash.delete(c.keyHash);
    this.secrets.delete(id);
    // Storage has no delete: the record is replaced by a marker that keeps nothing but the ids.
    this.d.sink()?.record(workspaceId, "agent_conn", id, { id, workspaceId, removed: true });
    this.d.sink()?.connectionSecret(`${AGENT_SECRET_PREFIX}${id}`, "");
    this.d.audit.record({ workspaceId, actor: `user:${userId}`, action: "agent.removed", target: id, data: { name: c.name } });
    return c;
  }

  /** Notes something the service learned (last use, a notice sent) without touching anything the owner set. */
  note(id: string, patch: Partial<Pick<AgentConnection, "lastUsedAt" | "ceilingNoticeDay" | "expiryWarned">>): void {
    const c = this.byId.get(id);
    if (c) this.save({ ...c, ...patch });
  }

  /**
   * The employees a connection may use. Left out: customer support, if the client has that employee. The Admin manager
   * and Finance manager are refused whatever the owner asks, and every employee must be one the client really has.
   */
  private chooseEmployees(userId: string, workspaceId: string, raw: unknown): string[] {
    const roster = this.d.roster(userId, workspaceId);
    if (raw === undefined || raw === null) {
      if (roster.some((e) => e.key === CUSTOMER_SUPPORT_KEY)) return [CUSTOMER_SUPPORT_KEY];
      throw new AgentError("Choose which of your employees this tool may give jobs to.", "choose_employees");
    }
    if (!Array.isArray(raw) || !raw.length || raw.length > MAX_EMPLOYEES_LISTED || raw.some((k) => typeof k !== "string")) throw new AgentError("Choose at least one of your employees.", "choose_employees");
    const keys = [...new Set((raw as string[]).map(employeeKey))];
    for (const key of keys) {
      const entry = roster.find((e) => e.key === key);
      const never = NEVER_ALLOWED[key] ?? (entry && !entry.allowed ? entry.reason : undefined);
      if (never) throw new AgentError(never, "employee_never_allowed");
      if (!entry) throw new AgentError("One of those employees is not on your team. Choose from the employees you have.", "employee_not_found");
    }
    return keys;
  }

  private expiry(from: Date): string {
    return new Date(from.getTime() + KEY_LIFETIME_DAYS * DAY_MS).toISOString();
  }

  private save(c: AgentConnection): void {
    const old = this.byId.get(c.id);
    if (old && old.keyHash !== c.keyHash) this.byHash.delete(old.keyHash);
    this.byId.set(c.id, c);
    this.byHash.set(c.keyHash, c.id);
    this.d.sink()?.record(c.workspaceId, "agent_conn", c.id, c);
  }

  private saveSecret(id: string, secret: string): void {
    this.secrets.set(id, secret);
    this.d.sink()?.connectionSecret(`${AGENT_SECRET_PREFIX}${id}`, secret);
  }
}

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AgentError("Send the details as a JSON object.", "invalid_request");
  return raw as Record<string, unknown>;
}
