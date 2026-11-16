/**
 * Outside agents: a client's own AI tool or automation (Claude, ChatGPT, Zapier, Make, n8n, a script) sends jobs to
 * that client's MAIZ employees with a key, inside limits the owner set. Types, limits and errors live here so the
 * service, the webhook sender and the routes agree on them.
 */

import type { AgentExample, AgentProfile } from "./planner.js";

export const AGENT_TOOLS = ["claude", "chatgpt", "zapier", "make", "n8n", "other"] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

/** Every key starts with this, so a leaked one is easy to recognise. */
export const KEY_START = "maiz_live_";
/** How much of a key is kept and shown afterwards ("maiz_live_" plus two characters). */
export const KEY_PREFIX_CHARS = 12;
export const KEY_LIFETIME_DAYS = 365;
/** The owner is told this many days before a key stops working. */
export const KEY_EXPIRY_WARNING_DAYS = 14;
export const MAX_CONNECTIONS_PER_WORKSPACE = 10;
export const NAME_MAX_CHARS = 60;
export const BRIEF_MAX_CHARS = 8_000;
export const DATA_MAX_BYTES = 16 * 1024;
export const REFERENCE_MAX_CHARS = 120;
export const IDEMPOTENCY_KEY_MAX_CHARS = 120;
/** The same idempotency key within this time returns the first job instead of starting another. */
export const IDEMPOTENCY_HOURS = 24;
/** Status checks one key may make a minute, so a polling loop cannot hammer the server. */
export const READS_PER_MINUTE = 120;
/** A job waiting for the owner this long is closed as refused, so nothing waits for ever. */
export const WAITING_EXPIRES_DAYS = 7;
/** A job still "working" after this long was cut off (for example by a restart) and is closed as failed. */
export const STUCK_AFTER_MINUTES = 15;
/** Jobs kept per connection. Beyond this the oldest finished ones are forgotten. */
export const MAX_JOBS_KEPT = 200;
/** Jobs one connection may have waiting for the owner at once, so approvals nobody answers cannot pile up without end. */
export const MAX_WAITING_JOBS = 50;
export const MAX_JOBS_LISTED = 50;
export const OWNER_RECENT_JOBS = 20;

/** Limits on one connection. Percentages are of the team's weekly energy pool. */
export interface AgentLimits {
  /** Most energy this connection may use in one day. */
  dailyPercent: number;
  /** A job expected to use more than this waits for the owner instead of running. */
  perJobPercent: number;
  jobsPerHour: number;
}
/** What a new connection starts with (docs/EXTERNAL-AGENTS.md). */
export const DEFAULT_LIMITS: AgentLimits = { dailyPercent: 10, perJobPercent: 2, jobsPerHour: 60 };
/** The most an owner may set. Nobody, the owner included, can go above these. */
export const MAX_LIMITS: AgentLimits = { dailyPercent: 25, perJobPercent: 5, jobsPerHour: 120 };

/** The customer support employee: the only one a new connection may use unless the owner chooses others. */
export const CUSTOMER_SUPPORT_KEY = "customer-service-reception";
/** Other names an outside tool may use for the same employee. */
export const EMPLOYEE_ALIASES: Readonly<Record<string, string>> = { "customer-support": CUSTOMER_SUPPORT_KEY, "customer-service": CUSTOMER_SUPPORT_KEY };
/** Employees no outside tool may ever use: one runs the account, the other works with the books. */
export const NEVER_ALLOWED: Readonly<Record<string, string>> = {
  "admin-manager": "The Admin manager sets up and runs your team, so an outside tool can never use it.",
  "finance-manager": "The Finance manager works with your books, so an outside tool can never use it.",
};

export interface AgentConnection {
  id: string;
  workspaceId: string;
  name: string;
  tool: AgentTool;
  /** Template keys of the employees this connection may give jobs to. */
  employees: readonly string[];
  /** Every job waits for the owner before it runs. */
  needsApproval: boolean;
  limits: AgentLimits;
  /** Where finished jobs are announced. The signing secret is stored apart from this record, encrypted. */
  webhookUrl?: string;
  /** SHA-256 of the key. The key itself is shown once and never stored. */
  keyHash: string;
  keyPrefix: string;
  keyCreatedAt: string;
  keyExpiresAt: string;
  status: "active" | "paused";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  /** The client's day on which the owner was last told the daily ceiling was reached (told once a day). */
  ceilingNoticeDay?: string;
  /** Set once the owner has been told this key is about to expire. */
  expiryWarned?: boolean;
  /** What the owner told the Admin manager this tool is for, when the connection was planned with it. */
  profile?: AgentProfile;
  /** A removed connection. Kept only so storage forgets the rest. */
  removed?: boolean;
}

export type AgentJobStatus = "queued" | "working" | "waiting_for_owner" | "done" | "refused" | "failed";
export type AgentJobReason =
  | "needs_approval" | "over_job_limit" | "daily_limit" | "no_energy" | "owner_refused" | "approval_expired"
  | "connection_off" | "employee_not_allowed" | "employee_not_found" | "failed" | "interrupted";

export interface AgentJob {
  id: string;
  workspaceId: string;
  connectionId: string;
  /** Template key of the employee asked. */
  employee: string;
  brief: string;
  /** The tool's own data, already serialised and size-checked. Dropped once the job has ended. */
  data?: string;
  /** The tool's own id for this job, echoed back. */
  reference?: string;
  idempotencyKey?: string;
  urgent: boolean;
  status: AgentJobStatus;
  /** Why it is waiting, was refused or failed. */
  reason?: AgentJobReason;
  /** The owner's own words when they refused it. */
  note?: string;
  /** Energy the job was expected to use when it arrived. */
  estimate: number;
  energyUsed?: number;
  /** The client's day the energy was used on, for the daily ceiling. */
  energyDay?: string;
  /** The employee's answer. Present only when the job is done. */
  result?: string;
  taskId?: string;
  decidedBy?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  removed?: boolean;
}

/** What a job looks like to the outside tool that sent it. */
export interface PublicJob {
  id: string;
  employee: string;
  status: AgentJobStatus;
  reason: AgentJobReason | null;
  reference: string | null;
  /** The answer text, or null until the job is done. */
  result: string | null;
  energyUsed: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function publicJob(j: AgentJob): PublicJob {
  return {
    id: j.id, employee: j.employee, status: j.status, reason: j.reason ?? null, reference: j.reference ?? null,
    result: j.status === "done" ? j.result ?? "" : null, energyUsed: j.energyUsed ?? null,
    createdAt: j.createdAt, startedAt: j.startedAt ?? null, finishedAt: j.finishedAt ?? null,
  };
}

/** The energy figures of one connection right now. Limits are percentages of the weekly pool, shown here as energy. */
export interface AgentEnergy { weeklyPool: number; dailyCeiling: number; perJobCap: number; usedToday: number; leftToday: number; resetsAt: string }

/** A connection as its owner sees it. Never the key or its hash. */
export interface ConnectionView {
  id: string;
  name: string;
  tool: AgentTool;
  /** "expired" when the key ran out; the owner replaces the key to bring it back. */
  status: "active" | "paused" | "expired";
  employees: { key: string; title: string }[];
  needsApproval: boolean;
  limits: AgentLimits;
  energy: AgentEnergy;
  jobsThisHour: number;
  /** Jobs waiting for the owner right now. */
  waiting: number;
  webhookUrl: string | null;
  keyPrefix: string;
  keyCreatedAt: string;
  keyExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** The set-up planned with the Admin manager, or null for a connection made by hand. */
  profile: AgentProfile | null;
}

/** A job as the owner sees it: what the tool sees, plus what was asked and by which connection. */
export interface OwnerJob extends PublicJob {
  connectionId: string;
  connectionName: string;
  employeeTitle: string;
  brief: string;
  /** The JSON the tool sent with the job, as text. */
  data: string | null;
  /** The owner's own words when they refused it. */
  note: string | null;
  /** Energy the job was expected to use when it arrived. */
  estimate: number;
}

/** Everything the owner's screen shows. */
export interface AgentOverview {
  connections: ConnectionView[];
  /** Jobs waiting for the owner first, then the most recent others. */
  jobs: OwnerJob[];
  limits: { defaults: AgentLimits; maximums: AgentLimits; weeklyPool: number; maxConnections: number; briefMaxChars: number; dataMaxBytes: number };
  /** Every employee on the team, and whether an outside tool may be given it. */
  allowedEmployees: { key: string; title: string; allowed: boolean; reason?: string }[];
  /** False for a team member who may look but not change anything. */
  canManage: boolean;
}

/** What a key learns about itself. */
export interface AgentSelf {
  connection: { id: string; name: string; tool: AgentTool; keyPrefix: string; keyExpiresAt: string; needsApproval: boolean };
  employees: { key: string; title: string }[];
  limits: { dailyEnergy: number; perJobEnergy: number; jobsPerHour: number };
  today: { energyUsed: number; energyLeft: number; resetsAt: string };
  thisHour: { jobs: number; jobsLeft: number };
  /** Example requests from the set-up the owner agreed, for whoever builds the tool. Empty when there are none. */
  examples: AgentExample[];
}

/** Something the owner or the tool sent is not valid. Answered as 400. */
export class AgentError extends Error {
  constructor(message: string, readonly reason?: string) { super(message); }
}

/** A missing, unknown, expired or paused key. One message for all of them, so nothing is given away. Answered as 401. */
export class AgentAuthError extends Error {
  constructor() { super("This key is not valid. Check it, or ask the account owner for a new one."); }
}

/** A request that is understood but not allowed right now: a limit, an employee outside the list, a job that is not theirs. */
export class AgentRefusal extends Error {
  constructor(readonly status: 402 | 403 | 404 | 409 | 429, message: string, readonly reason: string, readonly details: Readonly<Record<string, unknown>> = {}) { super(message); }
}
