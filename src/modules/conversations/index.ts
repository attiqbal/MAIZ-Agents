import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { IdentityService } from "../identity/index.js";
import type { ChatMessage } from "../model-gateway/types.js";

/** Turns kept per employee. Older ones drop off, so a thread never grows without limit. */
export const MAX_TURNS = 60;
const MAX_STORED_CHARS = 8_000;
/** Follow-ups see only the latest few answered exchanges, trimmed, so they stay cheap. */
const HISTORY_EXCHANGES = 3;
const HISTORY_CHARS_EACH = 1_500;

export type TurnStatus = "answered" | "queued" | "failed" | "no_energy";

export interface Turn {
  id: string;
  role: "you" | "employee";
  text: string;
  at: string;
  /** Employee turns only. */
  status?: TurnStatus;
  /** A second model checked this answer. */
  checked?: boolean;
  /** Queued turns: the batch job that will fill in the answer, and when it runs. */
  jobId?: string;
  runsAt?: string;
}

export interface Conversation { workspaceId: string; employeeId: string; turns: Turn[]; updatedAt: string }

export interface Reply { text: string; status: TurnStatus; checked?: boolean; jobId?: string; runsAt?: string }

const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/**
 * What each client said to each employee and what came back, kept per employee so a follow-up has context and
 * answers are still there tomorrow. Stored in the same records as tasks, and walled by workspace like them.
 */
export class ConversationService {
  private byEmployee = new Map<string, Conversation>();
  private sink?: Sink;

  constructor(private identity: IdentityService, private now: () => Date = () => new Date()) {}

  useSink(sink: Sink): void { this.sink = sink; }

  restore(c: Conversation): void { this.byEmployee.set(c.employeeId, c); }

  private mine(workspaceId: string, employeeId: string): Conversation | undefined {
    const c = this.byEmployee.get(employeeId);
    return c && c.workspaceId === workspaceId ? c : undefined;
  }

  /** The whole thread with one employee, oldest first. */
  thread(userId: string, workspaceId: string, employeeId: string): Turn[] {
    this.identity.require(userId, workspaceId, "task.read");
    return this.mine(workspaceId, employeeId)?.turns ?? [];
  }

  /** Earlier answered exchanges, as chat messages for the model. Failed, queued and refused turns are left out. */
  history(userId: string, workspaceId: string, employeeId: string): ChatMessage[] {
    const turns = this.thread(userId, workspaceId, employeeId);
    const pairs: ChatMessage[][] = [];
    for (let i = 0; i + 1 < turns.length; i++) {
      const [ask, reply] = [turns[i]!, turns[i + 1]!];
      if (ask.role === "you" && reply.role === "employee" && reply.status === "answered") {
        pairs.push([{ role: "user", content: clip(ask.text, HISTORY_CHARS_EACH) }, { role: "assistant", content: clip(reply.text, HISTORY_CHARS_EACH) }]);
      }
    }
    return pairs.slice(-HISTORY_EXCHANGES).flat();
  }

  /** Adds what the client asked and what came back. Returns the employee's turn. */
  record(userId: string, workspaceId: string, employeeId: string, asked: string, reply: Reply): Turn {
    this.identity.require(userId, workspaceId, "task.create");
    const at = this.now().toISOString();
    const you: Turn = { id: newId("turn"), role: "you", text: clip(asked, MAX_STORED_CHARS), at };
    const employee: Turn = {
      id: newId("turn"), role: "employee", text: clip(reply.text, MAX_STORED_CHARS), at, status: reply.status,
      ...(reply.checked ? { checked: true } : {}), ...(reply.jobId ? { jobId: reply.jobId } : {}), ...(reply.runsAt ? { runsAt: reply.runsAt } : {}),
    };
    const before = this.mine(workspaceId, employeeId)?.turns ?? [];
    this.save({ workspaceId, employeeId, turns: [...before, you, employee].slice(-MAX_TURNS), updatedAt: at });
    return employee;
  }

  /** A batch finished a queued question: the answer lands in the thread where the question was asked. Platform-level. */
  fileQueued(workspaceId: string, employeeId: string, jobId: string, answer: string): boolean {
    const c = this.mine(workspaceId, employeeId);
    const hit = c?.turns.find((t) => t.role === "employee" && t.jobId === jobId && t.status === "queued");
    if (!c || !hit) return false;
    const at = this.now().toISOString();
    const { runsAt: _runsAt, ...rest } = hit;
    this.save({ ...c, updatedAt: at, turns: c.turns.map((t) => (t === hit ? { ...rest, text: clip(answer, MAX_STORED_CHARS), status: "answered" as const, at } : t)) });
    return true;
  }

  /** A queued question that could not be finished. Platform-level. */
  failQueued(workspaceId: string, employeeId: string, jobId: string): boolean {
    const c = this.mine(workspaceId, employeeId);
    const hit = c?.turns.find((t) => t.role === "employee" && t.jobId === jobId && t.status === "queued");
    if (!c || !hit) return false;
    const { runsAt: _runsAt, ...rest } = hit;
    this.save({ ...c, updatedAt: this.now().toISOString(), turns: c.turns.map((t) => (t === hit ? { ...rest, text: "This could not be finished and nothing was charged. Ask again when you are ready.", status: "failed" as const } : t)) });
    return true;
  }

  /** Starts the thread over. Deletes it: nothing about it is kept. */
  clear(userId: string, workspaceId: string, employeeId: string): void {
    this.identity.require(userId, workspaceId, "task.create");
    if (!this.mine(workspaceId, employeeId)) return;
    this.save({ workspaceId, employeeId, turns: [], updatedAt: this.now().toISOString() });
  }

  private save(c: Conversation): void {
    this.byEmployee.set(c.employeeId, c);
    this.sink?.record(c.workspaceId, "conversation", c.employeeId, c);
  }
}
