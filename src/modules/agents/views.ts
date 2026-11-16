import type { WorkforceService } from "../workforce/index.js";
import type { RosterEntry } from "./connections.js";
import { employeeKey } from "./keys.js";
import { NEVER_ALLOWED, publicJob, type AgentConnection, type AgentEnergy, type AgentJob, type ConnectionView, type OwnerJob } from "./types.js";

const CAPABILITIES_SHOWN = 6;

/**
 * A workspace's employees, one per kind, read as the given member (so the usual permission check applies). Each
 * says whether an outside tool may be given it: the Admin manager and the Finance manager never may.
 */
export function rosterOf(workforce: Pick<WorkforceService, "team" | "templateFor">, asUserId: string, workspaceId: string): RosterEntry[] {
  const seen = new Map<string, RosterEntry>();
  for (const e of workforce.team(asUserId, workspaceId)) {
    const key = employeeKey(e.templateKey);
    if (seen.has(key)) continue;
    const t = workforce.templateFor(e.templateKey, workspaceId);
    const reason = NEVER_ALLOWED[key] ?? (t?.kind === "manager" ? NEVER_ALLOWED["admin-manager"] : undefined);
    seen.set(key, { key, employeeId: e.id, title: t?.title ?? e.name, summary: t?.summary ?? "", canDo: (t?.capabilities ?? []).slice(0, CAPABILITIES_SHOWN), allowed: !reason, ...(reason ? { reason } : {}) });
  }
  return [...seen.values()];
}

/** What the owner sees of a connection. The key hash and anything else secret are left out here, in one place. */
export function connectionView(c: AgentConnection, roster: readonly RosterEntry[], now: { ms: number; energy: AgentEnergy; jobsThisHour: number; waiting: number }): ConnectionView {
  return {
    id: c.id, name: c.name, tool: c.tool,
    status: c.status === "paused" ? "paused" : Date.parse(c.keyExpiresAt) <= now.ms ? "expired" : "active",
    employees: c.employees.map((key) => ({ key, title: roster.find((e) => e.key === key)?.title ?? key })),
    needsApproval: c.needsApproval, limits: c.limits, energy: now.energy, jobsThisHour: now.jobsThisHour, waiting: now.waiting,
    webhookUrl: c.webhookUrl ?? null, keyPrefix: c.keyPrefix, keyCreatedAt: c.keyCreatedAt, keyExpiresAt: c.keyExpiresAt,
    createdAt: c.createdAt, updatedAt: c.updatedAt, lastUsedAt: c.lastUsedAt ?? null,
  };
}

export function ownerJobView(j: AgentJob, roster: readonly RosterEntry[], connectionName: string): OwnerJob {
  return {
    ...publicJob(j), connectionId: j.connectionId, connectionName, employeeTitle: roster.find((e) => e.key === j.employee)?.title ?? j.employee,
    brief: j.brief, data: j.data ?? null, note: j.note ?? null, estimate: j.estimate,
  };
}
