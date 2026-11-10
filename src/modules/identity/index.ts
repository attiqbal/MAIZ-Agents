import { newId, type Id } from "../../core/ids.js";
import type { AuditLog } from "../audit/index.js";
import type { EventBus } from "../../core/events.js";
import type { Sink } from "../../core/persistence.js";

export type Role = "owner" | "admin" | "member" | "viewer";
export type Permission =
  | "workspace.manage"
  | "employee.hire"
  | "task.create"
  | "task.read"
  | "approval.decide";

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ["workspace.manage", "employee.hire", "task.create", "task.read", "approval.decide"],
  admin: ["employee.hire", "task.create", "task.read", "approval.decide"],
  member: ["task.create", "task.read"],
  viewer: ["task.read"],
};

export interface Workspace {
  id: Id<"workspace">;
  name: string;
  /** Account type. Only "business" exists in Stage 1; "vendor" arrives later. */
  type: "business";
  /** Working language of AI employees. English at launch. */
  language: string;
  baseCurrency: string;
  timeZone: string;
  /** The client's sign-in email, so the platform owner can reach them. */
  ownerEmail?: string;
  /** When the client signed up (ISO). */
  createdAt?: string;
}

export class PermissionError extends Error {}

export class IdentityService {
  private workspaces = new Map<string, Workspace>();
  private memberships = new Map<string, Role>(); // key: workspaceId|userId

  private sink?: Sink;

  constructor(
    private audit: AuditLog,
    private bus: EventBus,
  ) {}

  useSink(sink: Sink): void {
    this.sink = sink;
  }

  restoreWorkspace(w: Workspace): void {
    this.workspaces.set(w.id, w);
  }

  restoreMember(workspaceId: string, userId: string, role: Role): void {
    this.memberships.set(`${workspaceId}|${userId}`, role);
  }

  async createWorkspace(
    ownerUserId: string,
    input: { name: string; baseCurrency?: string; timeZone?: string; language?: string; ownerEmail?: string },
  ): Promise<Workspace> {
    const ws: Workspace = {
      id: newId("workspace"),
      name: input.name,
      type: "business",
      language: input.language ?? "en",
      baseCurrency: input.baseCurrency ?? "USD",
      timeZone: input.timeZone ?? "UTC",
      ...(input.ownerEmail ? { ownerEmail: input.ownerEmail } : {}),
      createdAt: new Date().toISOString(),
    };
    this.workspaces.set(ws.id, ws);
    this.memberships.set(`${ws.id}|${ownerUserId}`, "owner");
    this.sink?.workspace(ws);
    this.sink?.membership(ws.id, ownerUserId, "owner");
    this.audit.record({ workspaceId: ws.id, actor: `user:${ownerUserId}`, action: "workspace.created", target: ws.id });
    await this.bus.publish({ type: "workspace.created", workspaceId: ws.id, payload: { name: ws.name }, at: new Date() });
    return ws;
  }

  addMember(actorUserId: string, workspaceId: string, userId: string, role: Role): void {
    this.require(actorUserId, workspaceId, "workspace.manage");
    this.memberships.set(`${workspaceId}|${userId}`, role);
    this.sink?.membership(workspaceId, userId, role);
    this.audit.record({
      workspaceId,
      actor: `user:${actorUserId}`,
      action: "member.added",
      target: `user:${userId}`,
      data: { role },
    });
  }

  roleOf(userId: string, workspaceId: string): Role | undefined {
    return this.memberships.get(`${workspaceId}|${userId}`);
  }

  can(userId: string, workspaceId: string, permission: Permission): boolean {
    const role = this.roleOf(userId, workspaceId);
    return role !== undefined && ROLE_PERMISSIONS[role].includes(permission);
  }

  /** Throws unless the user holds the permission in that workspace. */
  require(userId: string, workspaceId: string, permission: Permission): void {
    if (!this.can(userId, workspaceId, permission)) {
      throw new PermissionError(`user ${userId} lacks ${permission} in workspace ${workspaceId}`);
    }
  }

  /**
   * One workspace by id, without a membership check. Platform-level code only (MAIZ quality review
   * sees every client); customer-facing code must use workspacesFor.
   */
  workspaceById(workspaceId: string): Workspace | undefined {
    return this.workspaces.get(workspaceId);
  }

  /** Every client workspace. Platform-level code only (the platform owner's clients screen). */
  allWorkspaces(): Workspace[] {
    return [...this.workspaces.values()];
  }

  /** A user only ever sees workspaces they belong to. */
  workspacesFor(userId: string): Workspace[] {
    return [...this.workspaces.values()].filter((w) => this.roleOf(userId, w.id));
  }
}
