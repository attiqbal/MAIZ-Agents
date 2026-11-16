import { passwordProblem } from "../modules/credentials/index.js";
import { ROLE_WORDS, TeamError } from "../modules/teammates/index.js";
import { brandFrom, teamInviteEmail } from "./email-templates.js";
import { userIdFor } from "./identity.js";
import type { Platform } from "./platform.js";
import type { Req, Res } from "./app.js";

/** What these routes borrow from the app: sessions are issued and read there. */
export interface TeamRouteCtx {
  p: Platform;
  issueSession: (email: string) => string;
  sessionClaims: (req: Req) => Record<string, unknown> | undefined;
  body: () => Record<string, unknown>;
}

const json = (status: number, body: unknown): Res => ({ status, body, headers: { "cache-control": "no-store" } });
const ID = "[\\w-]{1,64}";
const INVITE_ACTION = new RegExp(`^/api/team/invites/(${ID})/(resend|cancel)$`);
const MEMBER_ACTION = new RegExp(`^/api/team/members/(${ID})/(role|remove)$`);
const LOGIN_FIRST = "This email address already has a MAIZ Agents account. Log in with it, then open your invite link again.";

/** A TeamError becomes its own plain-words answer; anything else is the app's to handle. */
function failure(e: unknown): Res {
  if (e instanceof TeamError) return json(e.status, { error: e.message, ...(e.reason ? { reason: e.reason } : {}) });
  throw e;
}

/** The link that goes in the email. The secret rides after the "#", so it never reaches a server log or another site. */
const joinUrl = (p: Platform, token: string): string => `${(p.cfg.appUrl ?? "").replace(/\/$/, "")}/join.html#i=${token}`;

async function sendInvite(p: Platform, workspaceId: string, to: string, role: keyof typeof ROLE_WORDS, token: string): Promise<void> {
  const ws = p.identity.workspaceById(workspaceId);
  const mail = teamInviteEmail({ businessName: ws?.name ?? "A business", invitedBy: ws?.ownerEmail ?? "", roleLabel: ROLE_WORDS[role].label, can: ROLE_WORDS[role].can, url: joinUrl(p, token) }, brandFrom(p.cfg));
  // Best effort: the invite exists whether or not the email goes out, and the owner can send it again.
  await p.email.send({ to, ...mail }).catch((e) => console.error("invite email failed:", e instanceof Error ? e.message : e));
}

/**
 * True when the address is already known here in any way. Such an address must log in to use an invite: a link that
 * lasts 7 days must never be able to set the password of an account that already opens something.
 */
function hasAccount(p: Platform, email: string): boolean {
  const userId = userIdFor(email);
  return p.credentials.has(userId) || p.identity.workspacesFor(userId).length > 0 || p.isPlatformOwner(userId) || !!p.affiliates.dashboardFor(email);
}

/**
 * The invited person's side, before any login: what a link is for, and joining with it.
 * Who may use an invite: only someone who proves they own the invited address.
 * - Logged in (password, emailed link, or Google/Microsoft's verified address): the login's address must be the invited one.
 * - Not logged in and brand new: the link itself was emailed to the address, so its holder may choose a password and join.
 * - Not logged in and the address already has an account: they must log in first; the link never changes a password.
 */
export async function teamPublicRoute(req: Req, c: TeamRouteCtx): Promise<Res | undefined> {
  const { p } = c;
  const { method, path } = req;
  if (method !== "POST" || (path !== "/api/invites/open" && path !== "/api/invites/accept")) return undefined;
  try {
    const b = c.body() ?? {};
    if (path === "/api/invites/open") return json(200, p.team.peek(b.token));

    const claims = c.sessionClaims(req);
    const sessionEmail = typeof claims?.e === "string" ? claims.e : undefined;
    if (sessionEmail) {
      const joined = p.team.accept(b.inviteId !== undefined ? { inviteId: b.inviteId } : { token: b.token }, sessionEmail);
      return json(200, { email: sessionEmail, hasOrganisation: true, role: joined.role });
    }
    // No login: only the emailed link can be used, and only by an address that is new here.
    const email = p.team.emailOfToken(b.token);
    if (hasAccount(p, email)) return json(409, { error: LOGIN_FIRST, reason: "login" });
    const problem = passwordProblem(b.password, email);
    if (problem) return json(400, { error: problem, field: "password" });
    const joined = p.team.accept({ token: b.token }, email);
    await p.credentials.set(joined.userId, String(b.password));
    return json(200, { token: c.issueSession(email), email, hasOrganisation: true, role: joined.role });
  } catch (e) {
    return failure(e);
  }
}

/** The signed-in side: invites waiting for me (needs no business yet), and the owner's "People with access" panel. */
export async function teamRoute(req: Req, userId: string, c: TeamRouteCtx, workspaceId: string | undefined): Promise<Res | undefined> {
  const { p } = c;
  const { method, path } = req;
  if (method === "GET" && path === "/api/invites/mine") {
    const email = c.sessionClaims(req)?.e;
    return json(200, { invites: typeof email === "string" ? p.team.waitingFor(email) : [] });
  }
  if (path !== "/api/team" && !path.startsWith("/api/team/")) return undefined;
  if (!workspaceId) return json(404, { error: "no organisation yet" });
  const all = () => p.team.overview(userId, workspaceId);
  try {
    if (method === "GET" && path === "/api/team") return json(200, all());
    if (method !== "POST") return json(404, { error: "not found" });
    if (path === "/api/team/invites") {
      const { invite, token } = p.team.invite(userId, workspaceId, c.body() ?? {});
      await sendInvite(p, workspaceId, invite.email, invite.role, token);
      // Development only: the link comes back so a tester can join without email. The answer never depends on the address.
      return json(201, { invite, ...all(), ...(p.cfg.allowDevAuth ? { devLink: joinUrl(p, token) } : {}) });
    }
    const inv = INVITE_ACTION.exec(path);
    if (inv) {
      const [, id, action] = inv as unknown as [string, string, string];
      if (action === "cancel") { p.team.cancel(userId, workspaceId, id); return json(200, all()); }
      const { invite, token } = p.team.resend(userId, workspaceId, id);
      await sendInvite(p, workspaceId, invite.email, invite.role, token);
      return json(200, { invite, ...all(), ...(p.cfg.allowDevAuth ? { devLink: joinUrl(p, token) } : {}) });
    }
    const person = MEMBER_ACTION.exec(path);
    if (person) {
      const [, id, action] = person as unknown as [string, string, string];
      if (action === "remove") p.team.remove(userId, workspaceId, id);
      else p.team.changeRole(userId, workspaceId, id, (c.body() ?? {}).role);
      return json(200, all());
    }
    return json(404, { error: "not found" });
  } catch (e) {
    return failure(e);
  }
}
