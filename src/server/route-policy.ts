import type { Permission, Role } from "../modules/identity/index.js";
import type { Platform } from "./platform.js";
import type { Req, Res } from "./app.js";

/**
 * Who may call what, for a signed-in person inside a client's business (docs/TEAMMATES.md).
 *
 * Every request from a signed-in client passes `roleGate` before any route runs. The table below holds one decision
 * per route. A route that CHANGES something and is not in the table is the owner's alone, so a new route is safe by
 * default; `test/role-routes.test.ts` then fails until the route is given a line here, which is where its decision is
 * made on purpose. Reads (GET) not listed are open to everyone in the business; the services still check `task.read`.
 *
 * The services keep their own checks. This table is the one place to read the whole policy, and the place that gives
 * the person a plain reason instead of a bare refusal.
 */

/** What a route needs: one of the identity module's permissions, or "member" for things that are a person's own (their device's alerts, their read marker). */
export type Need = Permission | "member";
export type Method = "GET" | "POST" | "PUT" | "DELETE";
export interface RouteRule { method: Method | "ANY"; path: RegExp; need: Need; why: string }

const OWNER_BILLING = "Only the owner can change the plan, billing, top-ups or codes.";
const OWNER_APPS = "Only the owner can connect or remove apps.";
const OWNER_TOOLS = "Only the owner can connect or change outside AI tools.";
const OWNER_PEOPLE = "Only the owner can change who has access.";
const OWNER_SETTINGS = "Only the owner can change this setting.";
const OWNER_HIRE = "Only the owner can hire or buy from the store.";
const MANAGER_STAFF = "Only the owner or a manager can see or change staff records and the rota.";
const MANAGER_DECIDE = "Only the owner or a manager can approve this.";
const MANAGER_BOOKS = "Only the owner or a manager can put entries into the books.";
const MANAGER_ASK = "Only the owner or a manager can ask MAIZ for a new specialist.";
const VIEW_ONLY = "You have view-only access, so you can look but not change anything.";

const ID = "[^/]+";
const rule = (method: RouteRule["method"], path: string, need: Need, why = VIEW_ONLY): RouteRule => ({ method, path: new RegExp(`^${path}$`), need, why });

export const CLIENT_RULES: readonly RouteRule[] = [
  // ---- who has access (src/server/team-routes.ts) ----
  rule("POST", "/api/team/invites", "workspace.manage", OWNER_PEOPLE),
  rule("POST", `/api/team/invites/${ID}/(resend|cancel)`, "workspace.manage", OWNER_PEOPLE),
  rule("POST", `/api/team/members/${ID}/(role|remove)`, "workspace.manage", OWNER_PEOPLE),

  // ---- the plan, billing, top-ups and codes: the owner's alone ----
  rule("POST", "/api/checkout", "workspace.manage", OWNER_HIRE),
  rule("GET", "/api/orders", "workspace.manage", OWNER_BILLING),
  rule("POST", "/api/billing/portal", "workspace.manage", OWNER_BILLING),
  rule("GET", "/api/billing/lines", "workspace.manage", OWNER_BILLING),
  rule("POST", "/api/billing/(lines/stop|preview)", "workspace.manage", OWNER_BILLING),
  rule("POST", `/api/orders/${ID}/cancel`, "workspace.manage", OWNER_BILLING),
  rule("GET", "/api/coupons", "workspace.manage", OWNER_BILLING),
  rule("POST", "/api/coupons/redeem", "workspace.manage", OWNER_BILLING),
  rule("POST", "/api/energy/auto-reload", "workspace.manage", OWNER_BILLING),

  // ---- hiring: asking MAIZ to design a specialist is a manager's (`employee.hire`); taking one on at a monthly price is the owner's ----
  rule("POST", "/api/specialists", "employee.hire", MANAGER_ASK),
  rule("POST", `/api/specialists/${ID}/hire`, "workspace.manage", OWNER_HIRE),

  // ---- connected apps, chat apps, social accounts and outside AI tools: the owner's alone ----
  rule("POST", `/api/integrations/apps/${ID}/connect`, "workspace.manage", OWNER_APPS),
  rule("GET", `/api/integrations/connections/${ID}/choices`, "workspace.manage", OWNER_APPS),
  rule("POST", `/api/integrations/connections/${ID}/(choose|access)`, "workspace.manage", OWNER_APPS),
  rule("DELETE", `/api/integrations/connections/${ID}`, "workspace.manage", OWNER_APPS),
  rule("GET", "/api/slack/install", "workspace.manage", OWNER_APPS),
  rule("POST", "/api/meta/(connect|choose|whatsapp|delete-data)", "workspace.manage", OWNER_APPS),
  rule("GET", `/api/meta/pending/${ID}`, "workspace.manage", OWNER_APPS),
  rule("DELETE", `/api/meta/connections/${ID}`, "workspace.manage", OWNER_APPS),
  rule("POST", `/api/meta/connections/${ID}/approver`, "workspace.manage", OWNER_APPS),
  rule("POST", "/api/agents", "workspace.manage", OWNER_TOOLS),
  rule("POST", `/api/agents/jobs/${ID}/(approve|refuse)`, "workspace.manage", OWNER_TOOLS),
  rule("POST", `/api/agents/${ID}(/(rotate|pause|resume|remove|test))?`, "workspace.manage", OWNER_TOOLS),

  // ---- how the business is set up ----
  rule("POST", "/api/setup", "workspace.manage", OWNER_SETTINGS),
  rule("POST", "/api/setup/rollback", "workspace.manage", OWNER_SETTINGS),
  rule("POST", "/api/batch/schedule", "workspace.manage", OWNER_SETTINGS),

  // ---- staff records (personal data) and the rota: the owner and managers (`people.manage`) ----
  rule("DELETE", `/api/people/${ID}`, "workspace.manage", "Only the owner can delete a staff record for good."),
  rule("ANY", "/api/people(/.*)?", "people.manage", MANAGER_STAFF),
  rule("POST", "/api/rota/(staff|shifts)", "people.manage", MANAGER_STAFF),
  rule("POST", `/api/rota/staff/${ID}/leave`, "people.manage", MANAGER_STAFF),
  rule("POST", `/api/rota/shifts/${ID}/assign`, "people.manage", MANAGER_STAFF),
  rule("DELETE", `/api/rota/shifts/${ID}`, "people.manage", MANAGER_STAFF),

  // ---- decisions: what goes out and what goes into the books (`approval.decide`) ----
  rule("POST", `/api/meta/posts/${ID}/(approve|reject|cancel)`, "approval.decide", MANAGER_DECIDE),
  rule("POST", "/api/meta/sandbox/whatsapp-reply", "approval.decide", MANAGER_DECIDE),
  rule("POST", "/api/finance/entries", "approval.decide", MANAGER_BOOKS),
  rule("POST", "/api/integrations/post", "approval.decide", MANAGER_BOOKS),
  rule("POST", `/api/overview/calendar/dates(/${ID}(/(done|remove))?)?`, "approval.decide", MANAGER_DECIDE),

  // ---- asking the team for work (`task.create`): everyone except view-only ----
  rule("POST", "/api/ask", "task.create"),
  rule("POST", "/api/ask/stream", "task.create"),
  rule("POST", "/api/warm", "task.create"),
  rule("POST", `/api/conversations/${ID}/clear`, "task.create"),
  rule("POST", "/api/reviews", "task.create"),
  rule("POST", `/api/reviews/${ID}/answer`, "task.create"),
  rule("POST", "/api/queue/run-now", "task.create"),
  rule("POST", `/api/queue/${ID}/cancel`, "task.create"),
  rule("POST", `/api/paid-services/${ID}/render`, "task.create"),
  // Outside services (voice, web search, page reading, stock pictures): work that can spend energy, so not for view-only people.
  rule("POST", "/api/tools/(voice|voice/quote|search|read|stock|stock/keep)", "task.create"),
  rule("POST", `/api/tools/files/${ID}/remove`, "task.create"),
  rule("POST", "/api/mining/run", "task.create"),
  rule("POST", `/api/mining/datasets/${ID}/(share|remove|watch)`, "task.create"),
  rule("POST", "/api/mining/chat/(confirm|decline)", "task.create"),
  rule("POST", "/api/meta/posts", "task.create"),
  rule("POST", `/api/meta/posts/${ID}/results`, "task.create"),
  // A first upload connects the app, which the service keeps for the owner; later uploads and refreshes are work.
  rule("POST", `/api/integrations/apps/${ID}/import`, "task.create"),
  rule("POST", `/api/integrations/connections/${ID}/sync`, "task.create"),

  // ---- a person's own things: this device's alerts and their own "seen" marker. Everyone, view-only included ----
  rule("POST", "/api/push/(subscribe|unsubscribe|test)", "member"),
  rule("POST", "/api/notifications/seen", "member"),
];

/** The lowest role that holds each need, for the words of a refusal. */
const MANAGER_NEEDS: readonly Need[] = ["employee.hire", "approval.decide", "people.manage"];

export function ruleFor(method: string, path: string): RouteRule | undefined {
  return CLIENT_RULES.find((r) => (r.method === "ANY" || r.method === method) && r.path.test(path));
}

/** What a route that changes something needs when nobody has decided otherwise: the owner. */
export const DEFAULT_CHANGE_NEED: Need = "workspace.manage";

function refusal(role: Role | undefined, need: Need, why: string | undefined): string {
  if (role === "viewer" && need !== "task.read" && need !== "member") return VIEW_ONLY;
  if (why && why !== VIEW_ONLY) return why;
  if (need === "workspace.manage") return "Only the owner can do this.";
  if (MANAGER_NEEDS.includes(need)) return "Only the owner or a manager can do this.";
  return "You do not have access to do this.";
}

/**
 * Refuses a request the caller's role does not allow, with a reason in plain words. Returns undefined when the
 * request may go on. The platform owner's pages (`/api/owner/*`) have their own check, and a person with no business
 * yet has nothing here to protect.
 */
export function roleGate(req: Pick<Req, "method" | "path">, userId: string, p: Pick<Platform, "identity">, workspaceId: string | undefined): Res | undefined {
  if (!workspaceId || req.path.startsWith("/api/owner/")) return undefined;
  const found = ruleFor(req.method, req.path);
  const changes = req.method !== "GET" && req.method !== "HEAD";
  if (!found && !changes) return undefined;
  const need = found?.need ?? DEFAULT_CHANGE_NEED;
  const role = p.identity.roleOf(userId, workspaceId);
  const allowed = need === "member" ? role !== undefined : p.identity.can(userId, workspaceId, need);
  if (allowed) return undefined;
  return { status: 403, body: { error: refusal(role, need, found?.why), reason: "role" }, headers: { "cache-control": "no-store" } };
}
