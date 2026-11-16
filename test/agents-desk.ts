import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { AgentService, CUSTOMER_SUPPORT_KEY } from "../src/modules/agents/index.js";
import { setHostResolver } from "../src/modules/integrations/connectors/util.js";
import type { Sink } from "../src/core/persistence.js";
import type { TaskResult } from "../src/modules/workforce/index.js";

/** Shared by the outside-agent tests: a real platform (people, employees, energy) with the model work stubbed out. */
export const PUBLIC_IP = "93.184.216.34";
export const PRIVATE_IP = "10.0.0.5";
/** No test touches real DNS: names with "inside" point into a private network, everything else is public. */
export const dns = { lookup: async (host: string): Promise<string[]> => (host.includes("inside") ? [PRIVATE_IP] : [PUBLIC_IP]) };
export function useFakeDns(): void {
  setHostResolver((host) => dns.lookup(host));
}

export interface SentHook { url: string; headers: Record<string, string>; body: string; redirect?: string; hasTimeout: boolean }

/** A sink that remembers what was stored, so a test can read it back or restore from it. */
export function recordingSink() {
  const records: { workspaceId: string; kind: string; id: string; data: any }[] = [];
  const secrets: { key: string; secret: string }[] = [];
  const sink = new Proxy({}, {
    get: (_t, k) => (k === "record" ? (workspaceId: string, kind: string, id: string, data: unknown) => { records.push({ workspaceId, kind, id, data: JSON.parse(JSON.stringify(data)) }); }
      : k === "connectionSecret" ? (key: string, secret: string) => { secrets.push({ key, secret }); }
      : () => undefined),
  }) as unknown as Sink;
  /** The latest stored version of each record, as storage would hand it back. */
  const latest = () => [...new Map(records.map((r) => [`${r.kind}|${r.id}`, r])).values()];
  return { sink, records, secrets, latest };
}

export async function desk(o: { sink?: Sink } = {}) {
  const clock = { d: new Date("2026-11-16T09:00:00Z") };
  const p = createPlatform({ sessionSecret: "s3", allowDevAuth: true, email: new MemoryEmailSender(), now: () => clock.d });
  /** What the stubbed employee does with each job. */
  const work = { energy: 40, status: "ready_for_review" as TaskResult["status"], fail: false, slow: false, active: 0, mostAtOnce: 0, calls: [] as { userId: string; workspaceId: string; employeeId: string; brief: string; opts: unknown }[] };
  const bell: { ws: string; title: string; body: string }[] = [];
  const sent: SentHook[] = [];
  const web = { status: 200, down: false };
  const http = (async (url: string, init: { headers: Record<string, string>; body: string; redirect?: string; signal?: AbortSignal }) => {
    sent.push({ url: String(url), headers: init.headers, body: init.body, redirect: init.redirect, hasTimeout: init.signal instanceof AbortSignal });
    if (web.down) throw new Error("connection refused");
    return new Response("{}", { status: web.status });
  }) as unknown as typeof fetch;
  const make = (sink?: Sink) => {
    const agents = new AgentService({
      identity: p.identity, audit: p.audit, energy: p.energy, now: () => clock.d, http,
      notify: (ws, n) => { bell.push({ ws, ...n }); },
      workforce: {
        team: (u, ws) => p.workforce.team(u, ws),
        templateFor: (k, ws) => p.workforce.templateFor(k, ws),
        assign: async (userId, workspaceId, employeeId, brief, opts) => {
          work.calls.push({ userId, workspaceId, employeeId, brief, opts });
          if (work.slow) {
            work.mostAtOnce = Math.max(work.mostAtOnce, ++work.active);
            await new Promise((r) => setTimeout(r, 2));
            work.active--;
          }
          if (work.fail) throw new Error("model down");
          const base = { id: `task_${work.calls.length}`, workspaceId, employeeId, brief, status: work.status };
          return (work.status === "ready_for_review" ? { ...base, deliverable: "Dear customer, your order is on its way.", energyUsed: work.energy } : work.status === "no_energy" ? { ...base, reason: "weekly_pool_used" } : base) as TaskResult;
        },
      },
    });
    if (sink) agents.useSink(sink);
    return agents;
  };
  const agents = make(o.sink);
  /** A client with a small team. Customer support is an add-on, so it is only there when asked for. */
  const business = async (owner: string, name: string, extra: string[] = [CUSTOMER_SUPPORT_KEY]) => {
    const ws = await p.identity.createWorkspace(owner, { name });
    for (const key of ["marketing-manager", "finance-manager", "admin-manager", ...extra]) await p.workforce.hire(owner, ws.id, key);
    return ws.id as string;
  };
  const owner = "u_ann";
  const ws = await business(owner, "Kestrel Coffee");
  /** Makes a connection and returns its id, key and signing secret. */
  const connect = async (input: Record<string, unknown> = {}, as = owner, workspaceId = ws) => {
    const made = await agents.create(as, workspaceId, { name: "Helpdesk bot", tool: "zapier", ...input });
    return { id: made.connection.id, key: made.key, signingSecret: made.signingSecret, view: made.connection };
  };
  /** Sends a job and lets it run, as the route does after replying. */
  const send = async (key: string, input: Record<string, unknown> = {}) => {
    const { job } = agents.submit(key, { employee: "customer-support", brief: "Where is order 4471?", ...input });
    return job.status === "queued" ? agents.run(job.id) : job;
  };
  return { p, agents, make, clock, work, bell, sent, web, ws, owner, business, connect, send };
}
