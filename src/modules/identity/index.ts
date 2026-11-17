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
  | "approval.decide"
  /** Read and change the client's staff records (HR manager desk). Personal data: owner and admins only. */
  | "people.manage";

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ["workspace.manage", "employee.hire", "task.create", "task.read", "approval.decide", "people.manage"],
  admin: ["employee.hire", "task.create", "task.read", "approval.decide", "people.manage"],
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
    // A workspace has one owner, the person who signed up. Nobody is ever added as another, and the owner's own role is never overwritten.
    if (role === "owner" || this.roleOf(userId, workspaceId) === "owner") throw new PermissionError("a workspace has one owner, and that cannot be changed here");
    this.memberships.set(`${workspaceId}|${userId}`, role);
    this.sink?.membership(workspaceId, userId, role);
    this.sink?.record(workspaceId, "member_gone", userId, { workspaceId, userId, removed: false });
    this.audit.record({
      workspaceId,
      actor: `user:${actorUserId}`,
      action: "member.added",
      target: `user:${userId}`,
      data: { role },
    });
  }

  /** Changes what a teammate may do. The owner's role cannot be changed, and nobody can be made an owner. */
  setRole(actorUserId: string, workspaceId: string, userId: string, role: Exclude<Role, "owner">): void {
    this.require(actorUserId, workspaceId, "workspace.manage");
    const from = this.roleOf(userId, workspaceId);
    if (!from || from === "owner" || (role as Role) === "owner" || !ROLE_PERMISSIONS[role]) throw new PermissionError("that person's role cannot be changed");
    if (from === role) return;
    this.memberships.set(`${workspaceId}|${userId}`, role);
    this.sink?.membership(workspaceId, userId, role);
    this.audit.record({ workspaceId, actor: `user:${actorUserId}`, action: "member.role_changed", target: `user:${userId}`, data: { from, to: role } });
  }

  /**
   * Takes a teammate out of the workspace. Every request works out the caller's workspace and role afresh, so their
   * existing login opens nothing of this workspace from the next request on. The owner cannot be removed.
   */
  removeMember(actorUserId: string, workspaceId: string, userId: string): void {
    this.require(actorUserId, workspaceId, "workspace.manage");
    const role = this.roleOf(userId, workspaceId);
    if (!role || role === "owner") throw new PermissionError("that person cannot be removed");
    this.memberships.delete(`${workspaceId}|${userId}`);
    // The stored membership row cannot be deleted by the app's database role, so the removal is its own record and wins at start-up.
    this.sink?.record(workspaceId, "member_gone", userId, { workspaceId, userId, removed: true });
    this.audit.record({ workspaceId, actor: `user:${actorUserId}`, action: "member.removed", target: `user:${userId}`, data: { role } });
  }

  /** Put back a removal read from storage (after the memberships themselves). */
  restoreRemoval(r: { workspaceId?: unknown; userId?: unknown; removed?: unknown }): void {
    if (r?.removed !== true || typeof r.workspaceId !== "string" || typeof r.userId !== "string") return;
    if (this.roleOf(r.userId, r.workspaceId) !== "owner") this.memberships.delete(`${r.workspaceId}|${r.userId}`);
  }

  /** The person who signed up. Platform-level and team code only. */
  ownerOf(workspaceId: string): string | undefined {
    for (const [key, role] of this.memberships) if (role === "owner" && key.startsWith(`${workspaceId}|`)) return key.slice(workspaceId.length + 1);
    return undefined;
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
