import { createHmac, timingSafeEqual } from "node:crypto";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService } from "../identity/index.js";
import type { WorkforceService, TaskResult } from "../workforce/index.js";

/**
 * Chat apps are plug-ins. Core only knows ChatChannel and ChannelRouter;
 * Slack is included free, Teams is a paid extra, others (Telegram, WhatsApp)
 * can be added later without touching employees.
 */
export type ChannelKind = "slack" | "teams";

/** A message from any chat app, in one shape. */
export interface InboundMessage {
  channel: ChannelKind;
  /** The customer's workspace in that app (Slack team_id, Teams tenant id). */
  externalWorkspace: string;
  externalUser: string;
  /** Where to answer (Slack channel id or DM id). */
  conversation: string;
  text: string;
  /** Unique id used to ignore duplicate deliveries. */
  eventId: string;
}

export interface ChatChannel {
  readonly kind: ChannelKind;
  send(externalWorkspace: string, conversation: string, text: string): Promise<void>;
}

export interface Connection {
  workspaceId: string;
  channel: ChannelKind;
  externalWorkspace: string;
  /** Employee that answers when the message does not name one. */
  defaultEmployeeId: string;
}

/** Which chat apps each plan may connect. Slack is free for everyone; Teams is a paid add-on. */
export function channelAllowed(channel: ChannelKind, addOns: readonly string[]): boolean {
  return channel === "slack" || addOns.includes(channel);
}

export class ChannelError extends Error {}

export class ChannelRouter {
  private connections = new Map<string, Connection>();
  private links = new Map<string, string>(); // `${channel}:${externalWorkspace}:${externalUser}` -> platform user id
  private seen = new Set<string>();
  private channels = new Map<ChannelKind, ChatChannel>();
  private sink?: Sink;

  useSink(sink: Sink): void {
    this.sink = sink;
  }

  restoreConnection(c: Connection): void {
    this.connections.set(`${c.channel}:${c.externalWorkspace}`, c);
  }

  restoreLink(key: string, userId: string): void {
    this.links.set(key, userId);
  }

  constructor(
    private identity: IdentityService,
    private workforce: WorkforceService,
    private audit: AuditLog,
  ) {}

  register(channel: ChatChannel): void {
    this.channels.set(channel.kind, channel);
  }

  /** An owner connects a customer's chat workspace. Teams is refused unless the add-on is on. */
  connect(userId: string, conn: Connection, addOns: readonly string[]): void {
    this.identity.require(userId, conn.workspaceId, "workspace.manage");
    if (!channelAllowed(conn.channel, addOns)) throw new ChannelError(`${conn.channel} is a paid add-on`);
    const key = `${conn.channel}:${conn.externalWorkspace}`;
    const existing = this.connections.get(key);
    if (existing && existing.workspaceId !== conn.workspaceId) throw new ChannelError("already connected to another organisation");
    this.connections.set(key, { ...conn });
    this.sink?.connection({ ...conn });
    this.audit.record({ workspaceId: conn.workspaceId, actor: `user:${userId}`, action: "channel.connected", data: { channel: conn.channel } });
  }

  /** Links a chat-app person to a signed-in platform user. Only that user can do it for themselves. */
  linkUser(userId: string, workspaceId: string, channel: ChannelKind, externalWorkspace: string, externalUser: string): void {
    this.identity.require(userId, workspaceId, "task.read");
    const conn = this.connections.get(`${channel}:${externalWorkspace}`);
    if (!conn || conn.workspaceId !== workspaceId) throw new ChannelError("not connected");
    this.links.set(`${channel}:${externalWorkspace}:${externalUser}`, userId);
    this.sink?.link(workspaceId, `${channel}:${externalWorkspace}:${externalUser}`, userId);
  }

  /** Handle one inbound message: find the organisation, the person, the employee, do the work, reply. */
  async handle(msg: InboundMessage): Promise<"ignored" | "duplicate" | "unlinked" | "replied"> {
    const chat = this.channels.get(msg.channel);
    const conn = this.connections.get(`${msg.channel}:${msg.externalWorkspace}`);
    if (!chat || !conn) return "ignored";
    const dedupe = `${msg.channel}:${msg.eventId}`;
    if (this.seen.has(dedupe)) return "duplicate";
    this.seen.add(dedupe);

    const userId = this.links.get(`${msg.channel}:${msg.externalWorkspace}:${msg.externalUser}`);
    if (!userId) {
      // An unknown person gets no work done and sees nothing of the organisation.
      await chat.send(msg.externalWorkspace, msg.conversation, "Please link your MAIZ agents account first so I know who you are.");
      return "unlinked";
    }
    const { employeeId, brief } = this.pickEmployee(userId, conn, msg.text);
    let reply: string;
    try {
      const task = await this.workforce.assign(userId, conn.workspaceId, employeeId, brief);
      reply = describe(task);
    } catch {
      reply = "Sorry, you don't have permission to do that.";
    }
    await chat.send(msg.externalWorkspace, msg.conversation, reply);
    return "replied";
  }

  /** True when the organisation has this chat app connected. */
  isConnected(workspaceId: string, channel: ChannelKind): boolean {
    return [...this.connections.values()].some((c) => c.workspaceId === workspaceId && c.channel === channel);
  }

  /**
   * Sends a direct message from the platform to one linked person (for example the Admin
   * manager writing to the owner). Returns false when the chat app is not connected or the
   * person has not linked their chat account yet, so the caller can try again later.
   */
  async sendToUser(workspaceId: string, channel: ChannelKind, userId: string, text: string): Promise<boolean> {
    const chat = this.channels.get(channel);
    if (!chat) return false;
    for (const [key, linked] of this.links) {
      if (linked !== userId) continue;
      const [kind, externalWorkspace, externalUser] = key.split(":") as [ChannelKind, string, string];
      if (kind !== channel || this.connections.get(`${kind}:${externalWorkspace}`)?.workspaceId !== workspaceId) continue;
      // Slack accepts a user id as the channel and posts in the app's direct messages.
      await chat.send(externalWorkspace, externalUser, text);
      return true;
    }
    return false;
  }

  /** "finance: how much runway do we have?" goes to the Finance manager; otherwise the default employee. */
  private pickEmployee(userId: string, conn: Connection, text: string) {
    const m = /^\s*(finance|marketing|consultant|hr|compliance|admin)\s*[:,-]\s*(.+)$/is.exec(text);
    if (m) {
      const key = { finance: "finance-manager", marketing: "marketing-manager", consultant: "business-consultant", hr: "hr-manager", compliance: "compliance-manager", admin: "admin-manager" }[m[1]!.toLowerCase() as "finance"];
      const emp = this.workforce.team(userId, conn.workspaceId).find((e) => e.templateKey === key);
      if (emp) return { employeeId: emp.id as string, brief: m[2]!.trim() };
    }
    return { employeeId: conn.defaultEmployeeId, brief: text.trim() };
  }
}

function describe(task: TaskResult): string {
  switch (task.status) {
    case "ready_for_review":
      return task.deliverable ?? "";
    case "no_energy":
      return task.reason === "trial_ended"
        ? "Your free trial has ended. Choose a plan to keep your team working."
        : "I've used up my energy for today. I'll be back tomorrow, or you can add overtime.";
    default:
      return "Sorry, I couldn't finish that. Please try again.";
  }
}

// ---------- Slack ----------

/** Checks Slack's request signature. Rejects bad signatures and anything older than 5 minutes (replay). */
export function verifySlackSignature(signingSecret: string, timestamp: string, rawBody: string, signature: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > 300) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class SlackChannel implements ChatChannel {
  readonly kind = "slack" as const;
  constructor(
    private tokenFor: (externalWorkspace: string) => string,
    private http: typeof fetch = fetch,
  ) {}

  async send(externalWorkspace: string, conversation: string, text: string): Promise<void> {
    const res = await this.http("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.tokenFor(externalWorkspace)}` },
      body: JSON.stringify({ channel: conversation, text }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!body.ok) throw new ChannelError(`slack: ${body.error ?? "send failed"}`);
  }
}

export type SlackWebhookResult = { status: number; body?: unknown };

/**
 * Entry point for Slack's Events API. The web server passes the raw body and headers.
 * Always answers quickly; the caller does the slow work after replying 200.
 */
export function parseSlackEvent(
  signingSecret: string,
  headers: { timestamp: string; signature: string },
  rawBody: string,
  nowSeconds?: number,
): { result: SlackWebhookResult; message?: InboundMessage } {
  if (!verifySlackSignature(signingSecret, headers.timestamp, rawBody, headers.signature, nowSeconds)) return { result: { status: 401 } };
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { result: { status: 400 } };
  }
  if (payload.type === "url_verification") return { result: { status: 200, body: { challenge: payload.challenge } } };
  const ev = payload.event;
  // Only real people's messages: skip bots (including ourselves), edits and other subtypes.
  if (payload.type !== "event_callback" || !ev || ev.bot_id || ev.subtype || !ev.text || !ev.user) return { result: { status: 200 } };
  if (ev.type !== "message" && ev.type !== "app_mention") return { result: { status: 200 } };
  // In channels only react when mentioned; direct messages always count.
  if (ev.type === "message" && ev.channel_type !== "im") return { result: { status: 200 } };
  return {
    result: { status: 200 },
    message: {
      channel: "slack",
      externalWorkspace: payload.team_id,
      externalUser: ev.user,
      conversation: ev.channel,
      text: String(ev.text).replace(/<@[A-Z0-9]+>/g, "").trim(),
      eventId: payload.event_id,
    },
  };
}
