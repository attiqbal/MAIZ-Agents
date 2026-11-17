import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, makeToken, userIdFor, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { CLIENT_RULES, ruleFor, type Need } from "../src/server/route-policy.js";
import type { Role } from "../src/modules/identity/index.js";

/**
 * Who may call what. One line per route that a signed-in client can reach, with the lowest role that may use it.
 *
 * Adding a route? Three things keep this file honest, and each fails until the route has a decision:
 *  1. a line in CLIENT_RULES (src/server/route-policy.ts) when the route changes something or is not for everyone;
 *  2. the same route in CHANGES below, with the lowest role that may call it, so it is really called as each role;
 *  3. a read (GET) that is open to everyone in the business goes in READS; a route that needs no business goes in OUTSIDE.
 */

const SECRET = "s3";
const ROLES: readonly Role[] = ["owner", "admin", "member", "viewer"];
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
/** The lowest role that holds each need. Written out here, not read from the identity module, so a change there shows up as a failure. */
const LOWEST: Record<Need, Role> = { "workspace.manage": "owner", "employee.hire": "admin", "approval.decide": "admin", "people.manage": "admin", "task.create": "member", "task.read": "viewer", member: "viewer" };

type Row = readonly [method: "GET" | "POST" | "PUT" | "DELETE", path: string, lowest: Role, body?: unknown];

/** Every route that changes something, or that only some roles may read. `:emp` is a real employee, `:id` a made-up id. */
const CHANGES: readonly Row[] = [
  // who has access
  ["POST", "/api/team/invites", "owner", { email: "nobody", role: "viewer" }],
  ["POST", "/api/team/invites/:id/resend", "owner"],
  ["POST", "/api/team/invites/:id/cancel", "owner"],
  ["POST", "/api/team/members/:id/role", "owner", { role: "viewer" }],
  ["POST", "/api/team/members/:id/remove", "owner"],
  // the plan, billing, top-ups and codes
  ["POST", "/api/checkout", "owner", { lines: [] }],
  ["GET", "/api/orders", "owner"],
  ["POST", "/api/billing/portal", "owner"],
  ["POST", "/api/orders/:id/cancel", "owner"],
  ["GET", "/api/coupons", "owner"],
  ["POST", "/api/coupons/redeem", "owner", { code: "NOT-A-CODE" }],
  ["POST", "/api/energy/auto-reload", "owner", { enabled: false, packGbp: 5, monthlyCapGbp: 25 }],
  // hiring
  ["POST", "/api/specialists", "admin", {}],
  ["POST", "/api/specialists/:id/hire", "owner"],
  // connected apps, chat apps, social accounts, outside AI tools
  ["POST", "/api/integrations/apps/nope/connect", "owner"],
  ["GET", "/api/integrations/connections/:id/choices", "owner"],
  ["POST", "/api/integrations/connections/:id/choose", "owner", { id: "x" }],
  ["POST", "/api/integrations/connections/:id/access", "owner", { employees: [] }],
  ["DELETE", "/api/integrations/connections/:id", "owner"],
  ["GET", "/api/slack/install", "owner"],
  ["POST", "/api/meta/connect", "owner", { kind: "nope" }],
  ["POST", "/api/meta/choose", "owner", { pendingId: "x", index: 0 }],
  ["POST", "/api/meta/whatsapp", "owner", {}],
  ["POST", "/api/meta/delete-data", "owner"],
  ["GET", "/api/meta/pending/0123456789abcdef0123", "owner"],
  ["DELETE", "/api/meta/connections/:id", "owner"],
  ["POST", "/api/meta/connections/:id/approver", "owner", { number: "x" }],
  ["POST", "/api/agents", "owner", {}],
  ["POST", "/api/agents/jobs/:id/approve", "owner"],
  ["POST", "/api/agents/jobs/:id/refuse", "owner"],
  ["POST", "/api/agents/:id", "owner", {}],
  ["POST", "/api/agents/:id/rotate", "owner"],
  ["POST", "/api/agents/:id/pause", "owner"],
  ["POST", "/api/agents/:id/resume", "owner"],
  ["POST", "/api/agents/:id/remove", "owner"],
  ["POST", "/api/agents/:id/test", "owner"],
  // how the business is set up
  ["POST", "/api/setup", "owner", {}],
  ["POST", "/api/setup/rollback", "owner"],
  ["POST", "/api/batch/schedule", "owner", {}],
  // staff records and the rota
  ["GET", "/api/people", "admin"],
  ["POST", "/api/people", "admin", {}],
  ["POST", "/api/people/settings", "admin", {}],
  ["GET", "/api/people/:id", "admin"],
  ["POST", "/api/people/:id", "admin", {}],
  ["DELETE", "/api/people/:id", "owner"],
  ["DELETE", "/api/people/:id/form-link", "admin"],
  ["POST", "/api/people/:id/form-link", "admin"],
  ["POST", "/api/people/:id/documents/passport", "admin", {}],
  ["POST", "/api/people/:id/checklist/contract", "admin", {}],
  ["POST", "/api/people/:id/leave", "admin", {}],
  ["POST", "/api/people/:id/leave/:id/decide", "admin", { approve: true }],
  ["POST", "/api/people/:id/reviews", "admin", {}],
  ["POST", "/api/people/:id/reviews/:id/done", "admin", {}],
  ["POST", "/api/people/:id/leaving", "admin", {}],
  ["POST", "/api/people/:id/profile", "admin", {}],
  ["POST", "/api/rota/staff", "admin", {}],
  ["POST", "/api/rota/staff/:id/leave", "admin"],
  ["POST", "/api/rota/shifts", "admin", {}],
  ["POST", "/api/rota/shifts/:id/assign", "admin", {}],
  ["DELETE", "/api/rota/shifts/:id", "admin"],
  // decisions: what goes out, and what goes into the books
  ["POST", "/api/meta/posts/:id/approve", "admin"],
  ["POST", "/api/meta/posts/:id/reject", "admin"],
  ["POST", "/api/meta/posts/:id/cancel", "admin"],
  ["POST", "/api/meta/sandbox/whatsapp-reply", "admin", { text: "yes" }],
  ["POST", "/api/finance/entries", "admin", { date: "", memo: "", lines: [] }],
  ["POST", "/api/integrations/post", "admin"],
  // asking the team for work
  ["POST", "/api/ask", "member", {}],
  ["POST", "/api/ask/stream", "member", {}],
  ["POST", "/api/warm", "member"],
  ["POST", "/api/conversations/:emp/clear", "member"],
  ["POST", "/api/reviews", "member", {}],
  ["POST", "/api/reviews/:id/answer", "member", {}],
  ["POST", "/api/queue/run-now", "member"],
  ["POST", "/api/queue/:id/cancel", "member"],
  ["POST", "/api/paid-services/nope/render", "member", {}],
  ["POST", "/api/mining/run", "member", {}],
  ["POST", "/api/mining/datasets/:id/share", "member", { employees: [] }],
  ["POST", "/api/mining/datasets/:id/remove", "member"],
  ["POST", "/api/meta/posts", "member", {}],
  ["POST", "/api/meta/posts/:id/results", "member"],
  ["POST", "/api/integrations/apps/nope/import", "member", { csv: "a,b" }],
  ["POST", "/api/integrations/connections/:id/sync", "member"],
  // a person's own things
  ["POST", "/api/push/subscribe", "viewer", {}],
  ["POST", "/api/push/unsubscribe", "viewer", {}],
  ["POST", "/api/push/test", "viewer"],
  ["POST", "/api/notifications/seen", "viewer"],
];

/** Reads open to everyone in the business, view-only included. */
const READS: readonly string[] = [
  "/api/team", "/api/org", "/api/dashboard", "/api/energy", "/api/setup", "/api/notifications", "/api/suggestions", "/api/queue", "/api/batch/schedule",
  "/api/finance/summary", "/api/rota/week", "/api/specialists", "/api/reviews", "/api/conversations/:emp", "/api/paid-services", "/api/paid-services/uses/:id",
  "/api/push", "/api/mining", "/api/mining/datasets/:id", "/api/agents", "/api/integrations", "/api/integrations/activity", "/api/integrations/growth",
  "/api/meta", "/api/meta/posts", "/api/meta/insights", "/api/meta/sandbox/outbox",
];

/** Routes with no business behind them: public pages and calls proved by a signature, a key or a one-time link, the person's own account, and MAIZ's own owner pages. */
const OUTSIDE: readonly RegExp[] = [
  /^\/api\/owner(\/|$)/, /^\/api\/agent\/v1(\/|$)/, /^\/api\/auth\//, /^\/api\/signin\//, /^\/api\/signup(\/read-site)?$/, /^\/api\/staff-form\/(open|save)$/,
  /^\/api\/(health|store|me)$/, /^\/api\/health\/backups$/, /^\/api\/cart\/quote$/, /^\/api\/coupons\/check$/, /^\/api\/promoter\/unsubscribe$/, /^\/api\/affiliate\/me$/,
  /^\/api\/payments\/webhook$/, /^\/api\/whatsapp\/webhook$/, /^\/api\/slack\/(events|callback)$/, /^\/api\/integrations\/(callback|hooks\/[^/]+\/[^/]+)$/,
  /^\/api\/meta\/(callback|webhook|deauthorize|data-deletion|deletion-status)$/, /^\/api\/invites\/(open|accept|mine)$/,
];

function setup() {
  const now = new Date("2026-11-16T10:00:00Z");
  const platform = createPlatform({ sessionSecret: SECRET, allowDevAuth: false, email: new MemoryEmailSender(), appUrl: "https://app.test", now: () => now, slack: { clientId: "c", clientSecret: "s", signingSecret: "g", redirectUri: "https://app.test/api/slack/callback" } });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, token?: string) =>
    handle({ method, path, query: new URLSearchParams(), headers: token ? { authorization: `Bearer ${token}` } : {}, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const sessionFor = async (email: string): Promise<string> => {
    const link = makeToken(SECRET, { k: "magic", e: email, n: `n-${email}` }, 900, now.getTime());
    return ((await call("POST", "/api/signin/verify", { token: link })).body as { token: string }).token;
  };
  return { platform, call, sessionFor };
}

/** One business with a person in each role, each with their own login. */
async function business() {
  const s = setup();
  const owner = await s.sessionFor("owner@kestrel.co");
  const made = await s.call("POST", "/api/signup", { businessName: "Kestrel Coffee", country: "GB" }, owner);
  expect(made.status).toBe(201);
  const ws = (made.body as { workspaceId: string }).workspaceId;
  const tokens: Record<Role, string> = { owner, admin: "", member: "", viewer: "" };
  for (const role of ["admin", "member", "viewer"] as const) {
    const email = `${role}@kestrel.co`;
    const { token } = s.platform.team.invite(userIdFor("owner@kestrel.co"), ws, { email, role });
    s.platform.team.accept({ token }, email);
    tokens[role] = await s.sessionFor(email);
  }
  const emp = ((await s.call("GET", "/api/org", undefined, owner)).body as { team: { id: string }[] }).team[0]!.id;
  const fill = (path: string) => path.replaceAll(":emp", emp).replaceAll(":id", "x1");
  return { ...s, ws, tokens, fill };
}

describe("roles: every route that changes something, called as each role", () => {
  it.each(CHANGES.map((r) => [`${r[0]} ${r[1]}`, r] as const))("%s", async (_name, [method, path, lowest, body]) => {
    const b = await business();
    for (const role of ROLES) {
      const res = await b.call(method, b.fill(path), method === "GET" || method === "DELETE" ? undefined : body ?? {}, b.tokens[role]);
      const label = `${role} ${method} ${path} -> ${res.status} ${JSON.stringify(res.body ?? "")}`;
      if (RANK[role] >= RANK[lowest]) {
        // Allowed: the route ran. It may still say the made-up id or empty form is wrong, but never "not for you".
        expect([401, 403, 500], label).not.toContain(res.status);
      } else {
        expect(res.status, label).toBe(403);
        expect((res.body as { reason?: string }).reason, label).toBe("role");
        expect((res.body as { error: string }).error, label).toMatch(/^(Only the owner|You have view-only access)/);
      }
    }
  });

  it("a view-only person can change nothing at all", async () => {
    const b = await business();
    const changed: string[] = [];
    for (const [method, path, lowest, body] of CHANGES) {
      if (method === "GET" || lowest === "viewer") continue;
      const res = await b.call(method, b.fill(path), method === "DELETE" ? undefined : body ?? {}, b.tokens.viewer);
      if (res.status !== 403) changed.push(`${method} ${path} -> ${res.status}`);
    }
    expect(changed).toEqual([]);
  });

  it("everyone in the business can read what is open to all", async () => {
    const b = await business();
    for (const path of READS) {
      for (const role of ROLES) {
        const res = await b.call("GET", b.fill(path), undefined, b.tokens[role]);
        expect([401, 403, 500], `${role} GET ${path} -> ${res.status}`).not.toContain(res.status);
      }
    }
  });
});

describe("roles: no route without a decision", () => {
  it("the table here and the server's rules agree, line for line", () => {
    for (const [method, path, lowest] of CHANGES) {
      const rule = ruleFor(method, path.replaceAll(":emp", "x1").replaceAll(":id", "x1"));
      expect(rule, `${method} ${path} has no line in CLIENT_RULES`).toBeDefined();
      expect(LOWEST[rule!.need], `${method} ${path}`).toBe(lowest);
    }
    const unused = CLIENT_RULES.filter((r) => !CHANGES.some(([method, path]) => (r.method === "ANY" || r.method === method) && r.path.test(path.replaceAll(":emp", "x1").replaceAll(":id", "x1"))));
    expect(unused.map((r) => `${r.method} ${r.path.source}`)).toEqual([]);
    for (const path of READS) expect(ruleFor("GET", path.replaceAll(":emp", "x1").replaceAll(":id", "x1")), `GET ${path} is listed as open to all but has a rule`).toBeUndefined();
  });

  it("a route that changes something and has no line is the owner's alone", async () => {
    const b = await business();
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await b.call(method, "/api/brand-new/thing", {}, b.tokens.owner)).status).toBe(404);
      for (const role of ["admin", "member", "viewer"] as const) {
        expect(await b.call(method, "/api/brand-new/thing", {}, b.tokens[role])).toMatchObject({ status: 403, body: { reason: "role" } });
      }
    }
  });

  it("every route written in the server's route files has a decision", () => {
    const dir = join(import.meta.dirname, "../src/server");
    const files = readdirSync(dir).filter((f) => /^(app|password-auth|[\w-]+-routes)\.ts$/.test(f));
    expect(files).toEqual(expect.arrayContaining(["app.ts", "team-routes.ts", "push-routes.ts", "mining-routes.ts", "agent-routes.ts", "meta-routes.ts"]));
    const known = (path: string): boolean =>
      OUTSIDE.some((re) => re.test(path))
      || CLIENT_RULES.some((r) => r.path.test(path))
      || READS.some((r) => new RegExp(`^${r.replace(/:\w+/g, "[^/]+")}$`).test(path));
    const undecided = new Set<string>();
    for (const f of files) {
      for (const path of routesIn(readFileSync(join(dir, f), "utf8"))) if (!known(path)) undecided.add(`${path} (${f})`);
    }
    expect([...undecided], "Give each of these a line in CLIENT_RULES, READS or OUTSIDE").toEqual([]);
  });

  it("finds routes however they are written", () => {
    const src = [
      'if (method === "POST" && path === "/api/one/thing") x();',
      "const a = /^\\/api\\/two\\/([\\w-]{1,64})\\/(approve|refuse)$/.exec(path);",
      "const b = new RegExp(`^/api/three/(${ID})(?:/(sync|access))?$`);",
      'if (path.startsWith("/api/four/")) y();',
    ].join("\n");
    expect(routesIn(src).sort()).toEqual(["/api/one/thing", "/api/three/x1", "/api/three/x1/access", "/api/three/x1/sync", "/api/two/x1/approve", "/api/two/x1/refuse"]);
  });
});

/** Every `/api/...` path a route file tests for, as example paths: a pattern's choices are all written out, and an id becomes "x1". */
function routesIn(source: string): string[] {
  const found: string[] = [];
  // Plain and template strings: "/api/x", `^/api/x/${id}/y$`
  for (const m of source.matchAll(/["'`](\^?\/api\/[^"'`\s]*)["'`]/g)) found.push(m[1]!);
  // Regular expressions: /^\/api\/x\/([\w-]{1,64})\/y$/
  for (const m of source.matchAll(/\/(\^\\\/api(?:\\.|[^/\\\n])*)\//g)) found.push(m[1]!.replace(/\\\//g, "/"));
  const paths = new Set<string>();
  for (const raw of found) {
    if (raw.endsWith("*")) continue; // "/api/agents*" in a comment names a family of routes, it is not one
    const pattern = raw.replace(/^\^/, "").replace(/\$$/, "").replace(/\$\{[^}]*\}/g, "x1");
    // A string ending in "/" is a prefix test (startsWith), not a route.
    for (const p of expand(pattern)) if (!p.endsWith("/")) paths.add(p);
  }
  return [...paths];
}

/** Writes out a route pattern's choices: "(a|b)" gives both, "(?:/x)?" gives with and without, anything else in brackets is an id. */
function expand(pattern: string): string[] {
  const open = pattern.indexOf("(");
  if (open < 0) return [pattern.replace(/\[[^\]]*\](\{[^}]*\}|[+*?])?/g, "x1")];
  let depth = 0, close = open;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === "\\") { i++; continue; }
    if (pattern[i] === "(") depth++;
    if (pattern[i] === ")" && --depth === 0) { close = i; break; }
  }
  const inner = pattern.slice(open + 1, close).replace(/^\?:/, "");
  const optional = pattern[close + 1] === "?";
  const rest = pattern.slice(close + (optional ? 2 : 1));
  const words = inner.split("|");
  const options = /^[\w-]+(\|[\w-]+)*$/.test(inner) && inner !== "x1" ? words : inner.includes("(") || inner.startsWith("/") ? expand(inner) : ["x1"];
  const out: string[] = [];
  for (const head of expand(pattern.slice(0, open))) for (const tail of expand(rest)) {
    for (const o of options) out.push(head + o + tail);
    if (optional) out.push(head + tail);
  }
  return out;
}
