import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { IdentityService } from "../identity/index.js";

/** Notices kept per client. Older ones drop off. */
export const MAX_NOTICES = 50;

export type NoticeKind = "batch_done" | "review" | "specialist" | "answer_ready" | "info";

export interface Notice {
  id: string;
  kind: NoticeKind;
  title: string;
  body?: string;
  /** Where in the app to go, for example "/app.html#work". Always a path on this site. */
  link?: string;
  at: string;
}

interface Box { workspaceId: string; notices: Notice[]; /** Per person: the time they last opened the bell. */ seen: Record<string, string> }

const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
/** Only paths on this site, so a notice can never send someone elsewhere. */
const safeLink = (l: string | undefined): string | undefined => (l && /^\/[\w\-./#?=&]*$/.test(l) && !l.startsWith("//") ? l : undefined);

/**
 * The bell: a short list of things that happened while the client was away (a batch finished, a review passed),
 * with a read marker per person. One notice per event: a batch of 40 tasks is one notice, not 40.
 */
export class NotificationService {
  private boxes = new Map<string, Box>();
  private sink?: Sink;

  constructor(private identity: IdentityService, private now: () => Date = () => new Date()) {}

  useSink(sink: Sink): void { this.sink = sink; }

  restore(b: Box): void { this.boxes.set(b.workspaceId, b); }

  /** Platform-level: something happened for this client. */
  add(workspaceId: string, n: { kind: NoticeKind; title: string; body?: string; link?: string }): Notice {
    const notice: Notice = { id: newId("notice"), kind: n.kind, title: clip(n.title, 120), ...(n.body ? { body: clip(n.body, 400) } : {}), ...(safeLink(n.link) ? { link: safeLink(n.link) } : {}), at: this.now().toISOString() };
    const box = this.box(workspaceId);
    this.save({ ...box, notices: [notice, ...box.notices].slice(0, MAX_NOTICES) });
    return notice;
  }

  /** Newest first, each marked unread or read for this person. */
  list(userId: string, workspaceId: string): { notices: (Notice & { unread: boolean })[]; unread: number } {
    this.identity.require(userId, workspaceId, "task.read");
    const box = this.box(workspaceId);
    const seen = box.seen[userId] ?? "";
    const notices = box.notices.map((n) => ({ ...n, unread: n.at > seen }));
    return { notices, unread: notices.filter((n) => n.unread).length };
  }

  /** The person opened the bell: everything so far counts as read for them. */
  markSeen(userId: string, workspaceId: string): void {
    this.identity.require(userId, workspaceId, "task.read");
    const box = this.box(workspaceId);
    this.save({ ...box, seen: { ...box.seen, [userId]: this.now().toISOString() } });
  }

  private box(workspaceId: string): Box { return this.boxes.get(workspaceId) ?? { workspaceId, notices: [], seen: {} }; }

  private save(b: Box): void {
    this.boxes.set(b.workspaceId, b);
    this.sink?.record(b.workspaceId, "notices", "bell", b);
  }
}
