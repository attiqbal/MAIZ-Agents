import { newId, type Id } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";

export interface AuditEvent {
  readonly id: Id<"audit">;
  readonly workspaceId: string;
  readonly actor: string; // "user:<id>" or "employee:<id>" or "system"
  readonly action: string;
  readonly target?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly at: Date;
}

/** Append-only log. There is deliberately no update or delete method. */
export class AuditLog {
  private events: AuditEvent[] = [];
  private sink?: Sink;

  useSink(sink: Sink): void {
    this.sink = sink;
  }

  /** Put back an event read from storage. */
  restore(e: AuditEvent): void {
    this.events.push(Object.freeze(e));
  }

  record(e: Omit<AuditEvent, "id" | "at">): AuditEvent {
    const event: AuditEvent = Object.freeze({ ...e, id: newId("audit"), at: new Date() });
    this.events.push(event);
    this.sink?.audit(event);
    return event;
  }

  /** Reads are always scoped to one workspace. */
  list(workspaceId: string): readonly AuditEvent[] {
    return this.events.filter((e) => e.workspaceId === workspaceId);
  }
}
