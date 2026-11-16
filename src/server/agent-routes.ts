import { AgentAuthError, AgentError, AgentRefusal, publicJob } from "../modules/agents/index.js";
import type { Platform } from "./platform.js";
import type { Req, Res } from "./app.js";

const json = (status: number, body: unknown, headers?: Record<string, string>): Res => ({ status, body, ...(headers ? { headers } : {}) });
const PUBLIC_BASE = "/api/agent/v1";
const ID = "[\\w-]{1,64}";
const PUBLIC_JOB = new RegExp(`^${PUBLIC_BASE}/jobs/(${ID})$`);
const OWNER_JOB = new RegExp(`^/api/agents/jobs/(${ID})/(approve|refuse)$`);
const OWNER_CONNECTION = new RegExp(`^/api/agents/(${ID})(?:/(rotate|pause|resume|remove|test))?$`);

/** The one error shape of both APIs: `{ error, reason? }`, plus whatever helps the caller act (when to retry, the job). */
function failure(e: unknown): Res {
  if (e instanceof AgentAuthError) return json(401, { error: e.message, reason: "invalid_key" }, { "www-authenticate": "Bearer" });
  if (e instanceof AgentRefusal) {
    const retry = e.details.retryAfterSeconds;
    return json(e.status, { error: e.message, reason: e.reason, ...e.details }, typeof retry === "number" ? { "retry-after": String(retry) } : undefined);
  }
  if (e instanceof AgentError) return json(400, { error: e.message, ...(e.reason ? { reason: e.reason } : {}) });
  throw e;
}

/**
 * The public API a client's own AI tool or automation calls: `/api/agent/v1/*`. There is no session here. Every call
 * carries the connection's key (`Authorization: Bearer maiz_live_...`) and can only ever see that connection's own
 * workspace, employees and jobs. A job is accepted with 202 and runs after the reply; the tool polls for the answer or
 * is told by webhook.
 */
export async function agentPublicRoute(req: Req, p: Platform, body: () => Record<string, unknown>): Promise<Res | undefined> {
  const { method, path } = req;
  if (!path.startsWith(`${PUBLIC_BASE}/`)) return undefined;
  const header = req.headers["authorization"];
  const key = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  try {
    if (method === "GET" && path === `${PUBLIC_BASE}/me`) return json(200, p.agents.me(key));
    if (method === "GET" && path === `${PUBLIC_BASE}/employees`) return json(200, { employees: p.agents.employees(key) });
    if (method === "GET" && path === `${PUBLIC_BASE}/jobs`) {
      const limit = Number(req.query.get("limit") ?? "");
      const reference = req.query.get("reference")?.slice(0, 200) || undefined;
      return json(200, { jobs: p.agents.recent(key, Number.isInteger(limit) ? limit : undefined, reference) });
    }
    if (method === "POST" && path === `${PUBLIC_BASE}/jobs`) {
      // Checked before the body is read, so a caller without a key learns nothing about what a job looks like.
      p.agents.verify(key);
      const b = body();
      const idempotencyKey = req.headers["idempotency-key"];
      const { job, replayed } = p.agents.submit(key, idempotencyKey && b.idempotencyKey === undefined ? { ...b, idempotencyKey } : b);
      if (replayed) return json(200, { job: publicJob(job), replayed: true });
      // The reply goes out first. The employee's work (a model call) happens after it.
      return { ...json(202, { job: publicJob(job) }), after: async () => { if (job.status === "queued") await p.agents.run(job.id); else await p.agents.deliverWebhooks(); } };
    }
    const one = PUBLIC_JOB.exec(path);
    if (method === "GET" && one) return json(200, { job: p.agents.job(key, one[1]!) });
    return json(404, { error: "not found", reason: "not_found" });
  } catch (e) {
    const res = failure(e);
    // A refused job is still announced to the tool's webhook, after the reply.
    return res.status === 402 ? { ...res, after: async () => { await p.agents.deliverWebhooks(); } } : res;
  }
}

/**
 * The owner's side, for the signed-in client: `/api/agents*`. Anyone on the team may look; every change needs
 * `workspace.manage` (checked in the service), so only the owner can switch a connection on, change its limits,
 * replace its key or approve its jobs.
 */
export async function agentOwnerRoute(req: Req, userId: string, p: Platform, workspaceId: string, body: () => Record<string, unknown>): Promise<Res | undefined> {
  const { method, path } = req;
  if (path !== "/api/agents" && !path.startsWith("/api/agents/")) return undefined;
  const a = p.agents;
  try {
    if (method === "GET" && path === "/api/agents") return json(200, a.overview(userId, workspaceId));
    if (method === "POST" && path === "/api/agents") return json(201, await a.create(userId, workspaceId, body()));
    // The Admin manager's planning interview: the questions, and a proposal from the answers. Proposes only (matched before a connection id).
    if (method === "GET" && path === "/api/agents/plan") return json(200, a.planQuestions(userId, workspaceId));
    if (method === "POST" && path === "/api/agents/plan") return json(200, { proposal: a.plan(userId, workspaceId, body()) });
    const decide = OWNER_JOB.exec(path);
    if (method === "POST" && decide) {
      const [, jobId, action] = decide as unknown as [string, string, string];
      if (action === "refuse") return { ...json(200, { job: a.refuse(userId, workspaceId, jobId, body().reason) }), after: async () => { await a.deliverWebhooks(); } };
      // Approved: the owner's reply goes out first, then the employee does the work.
      return { ...json(200, { job: a.approve(userId, workspaceId, jobId) }), after: async () => { await a.run(jobId); } };
    }
    const conn = OWNER_CONNECTION.exec(path);
    if (method === "POST" && conn) {
      const [, id, action] = conn as unknown as [string, string, string | undefined];
      if (!action) return json(200, { connection: await a.update(userId, workspaceId, id, body()) });
      if (action === "rotate") return json(200, a.rotate(userId, workspaceId, id, body().signingSecret === true));
      if (action === "pause") return json(200, { connection: a.pause(userId, workspaceId, id) });
      if (action === "resume") return json(200, { connection: a.resume(userId, workspaceId, id) });
      if (action === "test") return json(200, await a.testWebhook(userId, workspaceId, id));
      a.remove(userId, workspaceId, id);
      return json(200, { removed: true });
    }
    return json(404, { error: "not found" });
  } catch (e) {
    return failure(e);
  }
}
