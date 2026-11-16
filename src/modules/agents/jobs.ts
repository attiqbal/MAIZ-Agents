import type { Sink } from "../../core/persistence.js";
import { IDEMPOTENCY_HOURS, MAX_JOBS_KEPT, type AgentJob } from "./types.js";

const HOUR_MS = 3_600_000;
const FINISHED: readonly AgentJob["status"][] = ["done", "refused", "failed"];
/** Longer than the repeat-request window and than any client day (25 hours when the clocks change). */
const RECENT_HOURS = Math.max(IDEMPOTENCY_HOURS, 25) + 1;

/**
 * The jobs outside tools sent, kept per connection. The platform's tasks cannot be looked up by id, so a job here is
 * the record the tool polls: its status, and the answer once there is one. Records are replaced, never edited in place.
 */
export class JobStore {
  private byId = new Map<string, AgentJob>();
  /** Job ids per connection, oldest first. */
  private byConnection = new Map<string, string[]>();

  constructor(private readonly sink: () => Sink | undefined) {}

  restore(j: AgentJob): void {
    if (j.removed) return;
    if (!this.byId.has(j.id)) this.byConnection.set(j.connectionId, [...(this.byConnection.get(j.connectionId) ?? []), j.id]);
    this.byId.set(j.id, j);
  }

  get(id: string): AgentJob | undefined { return this.byId.get(id); }
  all(): AgentJob[] { return [...this.byId.values()]; }

  /** One connection's jobs, oldest first. */
  of(connectionId: string): AgentJob[] {
    return (this.byConnection.get(connectionId) ?? []).map((id) => this.byId.get(id)!).filter(Boolean);
  }

  /** Stores a new job or the next state of one, and forgets the oldest finished jobs beyond what is kept. */
  save(j: AgentJob): AgentJob {
    const isNew = !this.byId.has(j.id);
    this.byId.set(j.id, j);
    this.sink()?.record(j.workspaceId, "agent_job", j.id, j);
    if (isNew) {
      this.byConnection.set(j.connectionId, [...(this.byConnection.get(j.connectionId) ?? []), j.id]);
      this.trim(j.connectionId, Date.parse(j.createdAt));
    }
    return j;
  }

  /** Forgets every job of a removed connection. */
  forget(connectionId: string): void {
    for (const j of this.of(connectionId)) this.drop(j);
    this.byConnection.delete(connectionId);
  }

  /** The job this connection already sent with the same idempotency key in the last day, if any. */
  sameRequest(connectionId: string, idempotencyKey: string, nowMs: number): AgentJob | undefined {
    return this.of(connectionId).find((j) => j.idempotencyKey === idempotencyKey && nowMs - Date.parse(j.createdAt) < IDEMPOTENCY_HOURS * HOUR_MS);
  }

  /** Jobs this connection sent in the last hour, oldest first. */
  lastHour(connectionId: string, nowMs: number): AgentJob[] {
    return this.of(connectionId).filter((j) => nowMs - Date.parse(j.createdAt) < HOUR_MS);
  }

  /** Energy this connection's jobs used on one of the client's days. */
  usedOn(connectionId: string, day: string): number {
    return this.of(connectionId).reduce((sum, j) => sum + (j.energyDay === day ? j.energyUsed ?? 0 : 0), 0);
  }

  /**
   * Forgets the oldest finished jobs beyond what is kept, but never one from the last day or so: today's energy
   * total, the hourly count and the repeat-request check are all read from these records, so a busy tool must not
   * be able to push its own recent jobs out and win back its limit.
   */
  private trim(connectionId: string, nowMs: number): void {
    const ids = this.byConnection.get(connectionId) ?? [];
    let extra = ids.length - MAX_JOBS_KEPT;
    if (extra <= 0) return;
    const keepAfter = nowMs - RECENT_HOURS * HOUR_MS;
    const kept: string[] = [];
    for (const id of ids) {
      const j = this.byId.get(id);
      if (extra > 0 && j && FINISHED.includes(j.status) && !(Date.parse(j.createdAt) > keepAfter)) { this.drop(j); extra--; } else kept.push(id);
    }
    this.byConnection.set(connectionId, kept);
  }

  private drop(j: AgentJob): void {
    this.byId.delete(j.id);
    // Storage has no delete: the record is replaced by a marker, so the brief and the answer are not kept.
    this.sink()?.record(j.workspaceId, "agent_job", j.id, { id: j.id, workspaceId: j.workspaceId, connectionId: j.connectionId, removed: true });
  }
}
