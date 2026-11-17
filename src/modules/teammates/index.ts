import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { AuditLog } from "../audit/index.js";
import type { IdentityService, Role } from "../identity/index.js";

/**
 * Teammates: the owner of a business invites other people into its workspace with limited rights
 * (docs/TEAMMATES.md). The roles and their permissions are the identity module's; this module adds the invite
 * (an emailed link that works once and lasts 7 days), the list of people with their email addresses, and the rule
 * that one email address opens one business.
 */

/** The roles a teammate can be given. Never "owner": a business has one owner, the person who signed up. */
export const TEAM_ROLES = ["admin", "member", "viewer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** The plain words shown for each role, in the product, in emails and in docs/TEAMMATES.md. */
export const ROLE_WORDS: Record<Role, { label: string; can: string }> = {
  owner: { label: "Owner", can: "Everything, including the plan, billing, connected apps and who has access." },
  admin: { label: "Manager", can: "Ask the team for work, see results, approve work that is waiting, and use the staff records and rota. Not billing, connected apps or who has access." },
  member: { label: "Team member", can: "Ask the team for work and see the results." },
  viewer: { label: "View only", can: "See the team's work and results. Cannot change anything." },
};

/** The most people one business can have, the owner and invites still waiting included. */
export const MAX_PEOPLE_PER_WORKSPACE = 10;
export const INVITE_DAYS = 7;
/** Invite emails one business may send in an hour, new and sent again together. */
export const INVITES_PER_WORKSPACE_PER_HOUR = 10;
/** Invite emails one address may be sent in a day, whoever sends them, so the form cannot be used to pester someone. */
export const INVITES_PER_ADDRESS_PER_DAY = 3;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_EMAIL = 200;
const TOKEN = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,100})$/;
/** One answer for every link that cannot be used (wrong, used, cancelled, expired), so nothing can be learnt by trying. */
const BAD_LINK = "This invite link is not valid any more. Ask the person who invited you to send a new one.";

export type InviteStatus = "pending" | "accepted" | "cancelled" | "expired";

export interface Invite {
  id: string;
  workspaceId: string;
  email: string;
  role: TeamRole;
  /** SHA-256 of the secret in the emailed link. The secret itself is never stored. Emptied once the invite is used or cancelled. */
  secretHash: string;
  invitedBy: string;
  createdAt: string;
  lastSentAt: string;
  expiresAt: string;
  status: "pending" | "accepted" | "cancelled";
  acceptedAt?: string;
}

/** One person with access, other than the owner. The role itself lives in the identity module. */
export interface TeamMember {
  workspaceId: string;
  userId: string;
  email: string;
  addedAt: string;
  /** Set when the owner removed them. Kept so storage forgets them. */
  removed?: boolean;
}

export interface InviteView { id: string; email: string; role: TeamRole; roleLabel: string; status: InviteStatus; createdAt: string; lastSentAt: string; expiresAt: string }
export interface PersonView { userId: string; email: string; role: Role; roleLabel: string; you: boolean; addedAt?: string }
export interface TeamOverview {
  businessName: string;
  canManage: boolean;
  you: { email: string; role: Role; roleLabel: string; can: string };
  owner: { email: string };
  /** Only for the owner: everyone with access, the owner first. */
  members?: PersonView[];
  /** Only for the owner: invites still waiting or run out. */
  invites?: InviteView[];
  limit?: number;
  roles?: { role: TeamRole; label: string; can: string }[];
}

export class TeamError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 409 | 429 = 400, readonly reason?: string) {
    super(message);
  }
}

export interface TeamDeps {
  identity: IdentityService;
  audit: AuditLog;
  now: () => Date;
  /** Turns a sign-in email into the user id sessions carry. */
  userIdFor: (email: string) => string;
  /** MAIZ's own platform owners never join a client's business. */
  isPlatformOwner?: (userId: string) => boolean;
  /** Runs when a person is removed, so other modules can let go of them (device alerts). */
  onRemoved?: (workspaceId: string, userId: string) => void;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const sameHash = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
export const cleanEmail = (v: unknown): string | undefined => {
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  return EMAIL.test(e) && e.length <= MAX_EMAIL ? e : undefined;
};
export const isTeamRole = (v: unknown): v is TeamRole => typeof v === "string" && (TEAM_ROLES as readonly string[]).includes(v);

export class TeamService {
  private invites = new Map<string, Invite>();
  private people = new Map<string, TeamMember>(); // key: workspaceId|userId
  private sentByWorkspace = new Map<string, number[]>();
  private sentToAddress = new Map<string, number[]>();
  private sink?: Sink;

  constructor(private readonly d: TeamDeps) {}

  useSink(sink: Sink): void {
    this.sink = sink;
  }

  restore(kind: "team_invite" | "team_member", data: unknown): void {
    const r = data as Partial<Invite & TeamMember> | null;
    if (!r || typeof r.workspaceId !== "string") return;
    if (kind === "team_invite") {
      if (typeof r.id === "string" && cleanEmail(r.email) && isTeamRole(r.role)) this.invites.set(r.id, r as Invite);
    } else if (typeof r.userId === "string" && cleanEmail(r.email)) {
      if (r.removed) this.people.delete(`${r.workspaceId}|${r.userId}`);
      else this.people.set(`${r.workspaceId}|${r.userId}`, r as TeamMember);
    }
  }

  // ------------------------------------------------------------------ the owner's side

  /** Invites a person by email. The secret in the returned token is shown nowhere and stored only as a hash. */
  invite(actorUserId: string, workspaceId: string, input: { email?: unknown; role?: unknown }): { invite: InviteView; token: string } {
    this.d.identity.require(actorUserId, workspaceId, "workspace.manage");
    const email = cleanEmail(input.email);
    if (!email) throw new TeamError("Enter a valid email address.");
    if (!isTeamRole(input.role)) throw new TeamError("Choose what this person can do: Manager, Team member or View only.");
    // Only this business's own list is checked here. Whether the address has an account anywhere else is never looked at.
    if (this.d.identity.roleOf(this.d.userIdFor(email), workspaceId)) throw new TeamError("That person already has access to this business.");
    const waiting = this.open(workspaceId).find((i) => i.email === email);
    if (waiting) throw new TeamError("That address already has an invite waiting. Use “Send again” next to it.");
    if (this.headcount(workspaceId) >= MAX_PEOPLE_PER_WORKSPACE) throw new TeamError(`A business can have up to ${MAX_PEOPLE_PER_WORKSPACE} people, counting invites still waiting. Remove someone or cancel an invite first.`);
    this.countSend(workspaceId, email);
    const at = this.d.now();
    const secret = randomBytes(32).toString("base64url");
    const made: Invite = {
      id: newId("invite"), workspaceId, email, role: input.role, secretHash: sha256(secret), invitedBy: actorUserId,
      createdAt: at.toISOString(), lastSentAt: at.toISOString(), expiresAt: new Date(at.getTime() + INVITE_DAYS * DAY_MS).toISOString(), status: "pending",
    };
    this.save(made);
    this.d.audit.record({ workspaceId, actor: `user:${actorUserId}`, action: "team.invited", target: `invite:${made.id}`, data: { email, role: made.role } });
    return { invite: this.view(made), token: `${made.id}.${secret}` };
  }

  /** Sends an invite again: a new link, the old one stops working, and the 7 days start again. */
  resend(actorUserId: string, workspaceId: string, inviteId: string): { invite: InviteView; token: string } {
    this.d.identity.require(actorUserId, workspaceId, "workspace.manage");
    const i = this.own(workspaceId, inviteId);
    if (i.status !== "pending") throw new TeamError("That invite is no longer waiting.");
    // An invite that ran out gave its place back, so sending it again must find room like a new one.
    if (!this.live(i) && this.headcount(workspaceId) >= MAX_PEOPLE_PER_WORKSPACE) throw new TeamError(`A business can have up to ${MAX_PEOPLE_PER_WORKSPACE} people, counting invites still waiting. Remove someone or cancel an invite first.`);
    this.countSend(workspaceId, i.email);
    const at = this.d.now();
    const secret = randomBytes(32).toString("base64url");
    const next: Invite = { ...i, secretHash: sha256(secret), lastSentAt: at.toISOString(), expiresAt: new Date(at.getTime() + INVITE_DAYS * DAY_MS).toISOString() };
    this.save(next);
    this.d.audit.record({ workspaceId, actor: `user:${actorUserId}`, action: "team.invite_resent", target: `invite:${i.id}`, data: { email: i.email } });
    return { invite: this.view(next), token: `${next.id}.${secret}` };
  }

  cancel(actorUserId: string, workspaceId: string, inviteId: string): void {
    this.d.identity.require(actorUserId, workspaceId, "workspace.manage");
    const i = this.own(workspaceId, inviteId);
    if (i.status !== "pending") throw new TeamError("That invite is no longer waiting.");
    this.save({ ...i, status: "cancelled", secretHash: "" });
    this.d.audit.record({ workspaceId, actor: `user:${actorUserId}`, action: "team.invite_cancelled", target: `invite:${i.id}`, data: { email: i.email } });
  }

  changeRole(actorUserId: string, workspaceId: string, userId: string, role: unknown): void {
    this.d.identity.require(actorUserId, workspaceId, "workspace.manage");
    if (!isTeamRole(role)) throw new TeamError("Choose what this person can do: Manager, Team member or View only.");
    this.person(workspaceId, userId);
    this.d.identity.setRole(actorUserId, workspaceId, userId, role);
  }

  /** Removes a person. Their login stops opening this business on its next request, and their device alerts for it stop. */
  remove(actorUserId: string, workspaceId: string, userId: string): void {
    this.d.identity.require(actorUserId, workspaceId, "workspace.manage");
    const m = this.person(workspaceId, userId);
    this.d.identity.removeMember(actorUserId, workspaceId, userId);
    this.people.delete(`${workspaceId}|${userId}`);
    this.sink?.record(workspaceId, "team_member", userId, { workspaceId, userId, email: m.email, addedAt: m.addedAt, removed: true });
    this.d.onRemoved?.(workspaceId, userId);
  }

  /** What the Settings panel shows. The owner sees everyone; anyone else sees who the owner is and their own role. */
  overview(userId: string, workspaceId: string): TeamOverview {
    this.d.identity.require(userId, workspaceId, "task.read");
    const ws = this.d.identity.workspaceById(workspaceId);
    const role = this.d.identity.roleOf(userId, workspaceId)!;
    const ownerEmail = ws?.ownerEmail ?? "";
    const myEmail = role === "owner" ? ownerEmail : this.people.get(`${workspaceId}|${userId}`)?.email ?? "";
    const base: TeamOverview = { businessName: ws?.name ?? "", canManage: role === "owner", you: { email: myEmail, role, roleLabel: ROLE_WORDS[role].label, can: ROLE_WORDS[role].can }, owner: { email: ownerEmail } };
    if (role !== "owner") return base;
    const ownerId = this.d.identity.ownerOf(workspaceId) ?? userId;
    const others = this.peopleOf(workspaceId).map((m): PersonView => {
      const r = this.d.identity.roleOf(m.userId, workspaceId)!;
      return { userId: m.userId, email: m.email, role: r, roleLabel: ROLE_WORDS[r].label, you: false, addedAt: m.addedAt };
    });
    return {
      ...base,
      members: [{ userId: ownerId, email: ownerEmail, role: "owner", roleLabel: ROLE_WORDS.owner.label, you: ownerId === userId }, ...others],
      invites: this.open(workspaceId).map((i) => this.view(i)),
      limit: MAX_PEOPLE_PER_WORKSPACE,
      roles: TEAM_ROLES.map((r) => ({ role: r, label: ROLE_WORDS[r].label, can: ROLE_WORDS[r].can })),
    };
  }

  // ------------------------------------------------------------------ the invited person's side

  /** What the join page shows for a link. The same refusal for every link that cannot be used. */
  peek(token: unknown): { businessName: string; email: string; role: TeamRole; roleLabel: string; can: string; invitedBy: string; expiresAt: string } {
    const i = this.byToken(token);
    const ws = this.d.identity.workspaceById(i.workspaceId);
    return { businessName: ws?.name ?? "", email: i.email, role: i.role, roleLabel: ROLE_WORDS[i.role].label, can: ROLE_WORDS[i.role].can, invitedBy: ws?.ownerEmail ?? "", expiresAt: i.expiresAt };
  }

  /** The address an emailed link was sent to. Used to decide how its holder must prove who they are. */
  emailOfToken(token: unknown): string {
    return this.byToken(token).email;
  }

  /** Invites waiting for an address that has just proved itself by logging in. */
  waitingFor(email: string): { id: string; businessName: string; role: TeamRole; roleLabel: string; can: string; invitedBy: string }[] {
    const e = cleanEmail(email);
    if (!e) return [];
    return [...this.invites.values()].filter((i) => i.email === e && this.live(i)).map((i) => {
      const ws = this.d.identity.workspaceById(i.workspaceId);
      return { id: i.id, businessName: ws?.name ?? "", role: i.role, roleLabel: ROLE_WORDS[i.role].label, can: ROLE_WORDS[i.role].can, invitedBy: ws?.ownerEmail ?? "" };
    });
  }

  /**
   * Joins the workspace. `provenEmail` is an address the caller has already proved they own: the link itself was
   * emailed to it (a brand-new person choosing a password), or they are logged in with it (password, emailed link,
   * or Google/Microsoft's verified address). It must be the invited address. Works once.
   */
  accept(by: { token: unknown } | { inviteId: unknown }, provenEmail: string): { workspaceId: string; role: TeamRole; userId: string } {
    const email = cleanEmail(provenEmail);
    const i = "token" in by ? this.byToken(by.token) : this.byIdFor(by.inviteId, email);
    if (!email || email !== i.email) throw new TeamError("This invite was sent to a different email address. Log out, then log in with the address the invite was sent to.", 403, "wrong_address");
    const userId = this.d.userIdFor(email);
    if (this.d.isPlatformOwner?.(userId)) throw new TeamError("MAIZ's own accounts cannot join a client's business.", 403, "platform_owner");
    // The person who invited must still be the owner.
    if (!this.d.identity.can(i.invitedBy, i.workspaceId, "workspace.manage")) throw new TeamError(BAD_LINK);
    const already = this.d.identity.workspacesFor(userId);
    if (already.some((w) => w.id === i.workspaceId)) throw new TeamError("You already have access to this business. Log in to open it.", 409, "already_in");
    // One address opens one business: every screen and every saved login works out "your business" from the address alone.
    if (already.length) throw new TeamError("This email address already has its own business on MAIZ Agents, and one address can open one business. Ask to be invited at another email address.", 409, "other_business");
    if (this.headcount(i.workspaceId) > MAX_PEOPLE_PER_WORKSPACE) throw new TeamError("This business already has as many people as it can. Ask the owner to make room.", 409, "full");
    const at = this.d.now().toISOString();
    // Marked used before the membership is made, so a second use of the same link can never add anyone.
    this.save({ ...i, status: "accepted", acceptedAt: at, secretHash: "" });
    this.d.identity.addMember(i.invitedBy, i.workspaceId, userId, i.role);
    const member: TeamMember = { workspaceId: i.workspaceId, userId, email, addedAt: at };
    this.people.set(`${i.workspaceId}|${userId}`, member);
    this.sink?.record(i.workspaceId, "team_member", userId, member);
    this.d.audit.record({ workspaceId: i.workspaceId, actor: `user:${userId}`, action: "team.invite_accepted", target: `invite:${i.id}`, data: { role: i.role } });
    return { workspaceId: i.workspaceId, role: i.role, userId };
  }

  // ------------------------------------------------------------------ inside

  private live(i: Invite): boolean {
    return i.status === "pending" && new Date(i.expiresAt).getTime() > this.d.now().getTime();
  }

  private byToken(token: unknown): Invite {
    const m = typeof token === "string" ? TOKEN.exec(token) : null;
    const i = m ? this.invites.get(m[1]!) : undefined;
    // The hash is compared even for an unknown id, so a wrong id and a wrong secret take the same time.
    const good = sameHash(sha256(m?.[2] ?? ""), i?.secretHash || sha256("no such invite"));
    if (!i || !good || !this.live(i)) throw new TeamError(BAD_LINK);
    return i;
  }

  private byIdFor(inviteId: unknown, email: string | undefined): Invite {
    const i = typeof inviteId === "string" ? this.invites.get(inviteId) : undefined;
    // An invite for someone else looks exactly like one that does not exist.
    if (!i || !email || i.email !== email || !this.live(i)) throw new TeamError(BAD_LINK);
    return i;
  }

  private own(workspaceId: string, inviteId: string): Invite {
    const i = this.invites.get(inviteId);
    if (!i || i.workspaceId !== workspaceId) throw new TeamError("That invite was not found.");
    return i;
  }

  private person(workspaceId: string, userId: string): TeamMember {
    const m = this.people.get(`${workspaceId}|${userId}`);
    const role = this.d.identity.roleOf(userId, workspaceId);
    if (role === "owner") throw new TeamError("The owner's access cannot be changed or removed.");
    // Someone in another business looks exactly like someone who does not exist.
    if (!m || !role) throw new TeamError("That person was not found.");
    return m;
  }

  private peopleOf(workspaceId: string): TeamMember[] {
    return [...this.people.values()].filter((m) => m.workspaceId === workspaceId && this.d.identity.roleOf(m.userId, workspaceId)).sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }

  /** Invites of one business that are still on its list: waiting, or run out and not yet cancelled. */
  private open(workspaceId: string): Invite[] {
    return [...this.invites.values()].filter((i) => i.workspaceId === workspaceId && i.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** The owner, the people with access and the invites that could still be accepted. */
  private headcount(workspaceId: string): number {
    return 1 + this.peopleOf(workspaceId).length + this.open(workspaceId).filter((i) => this.live(i)).length;
  }

  private countSend(workspaceId: string, email: string): void {
    const t = this.d.now().getTime();
    const mine = (this.sentByWorkspace.get(workspaceId) ?? []).filter((x) => t - x < HOUR_MS);
    const theirs = (this.sentToAddress.get(email) ?? []).filter((x) => t - x < DAY_MS);
    if (mine.length >= INVITES_PER_WORKSPACE_PER_HOUR) throw new TeamError("You have sent a lot of invites in the last hour. Please wait a while and try again.", 429, "rate_limit");
    if (theirs.length >= INVITES_PER_ADDRESS_PER_DAY) throw new TeamError("That address has been sent several invites today. Please try again tomorrow.", 429, "rate_limit");
    this.sentByWorkspace.set(workspaceId, [...mine, t]);
    this.sentToAddress.set(email, [...theirs, t]);
    if (this.sentToAddress.size > 20_000) for (const [k, v] of this.sentToAddress) if (!v.some((x) => t - x < DAY_MS)) this.sentToAddress.delete(k);
  }

  private view(i: Invite): InviteView {
    const status: InviteStatus = i.status === "pending" && !this.live(i) ? "expired" : i.status;
    return { id: i.id, email: i.email, role: i.role, roleLabel: ROLE_WORDS[i.role].label, status, createdAt: i.createdAt, lastSentAt: i.lastSentAt, expiresAt: i.expiresAt };
  }

  private save(i: Invite): void {
    this.invites.set(i.id, i);
    this.sink?.record(i.workspaceId, "team_invite", i.id, i);
  }
}
