import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { IdentityService } from "../identity/index.js";
import { cleanLine, lessonsFromEdit, normal } from "./derive.js";

export { lessonsFromEdit } from "./derive.js";

/**
 * What each business has taught its team, kept per business and walled by workspace like every other record.
 *
 * Two small things are kept, never long histories:
 *  - lessons: short preferences learned from a thumbs up or down, a "redo", a note, or an edit to an answer;
 *  - profile facts: how the business works, its tools, recurring jobs and tone, from signup, the website, connected
 *    apps and the work itself.
 * Both are shown to the client, who can edit or delete any of it. A short block of them is added to each employee's
 * instructions, so outputs adapt. Nothing here calls an AI model: it is rules over small text, so it costs no energy.
 */
export class LearningError extends Error {}

export type FeedbackKind = "up" | "down" | "redo" | "edit";
export type LessonSource = "note" | "edit" | "redo" | "rating" | "you";
export type FactKind = "tone" | "how" | "tool" | "recurring" | "about";
export type FactSource = "signup" | "website" | "connection" | "activity" | "you";

export interface Lesson { id: string; text: string; /** An employee template key, or "all". */ scope: string; source: LessonSource; count: number; at: string }
export interface ProfileFact { id: string; kind: FactKind; text: string; source: FactSource; at: string; edited?: boolean }
export interface FeedbackEvent { id: string; at: string; employeeId: string; templateKey: string; turnId?: string; kind: FeedbackKind }
export interface Learned {
  workspaceId: string;
  lessons: Lesson[];
  facts: ProfileFact[];
  /** Counts by kind plus the latest few events. Not the answers themselves. */
  events: FeedbackEvent[];
  /** Facts the client deleted, so the same thing is not learned again. Normalised text. */
  dismissed: string[];
  updatedAt: string;
}

export const MAX_LESSONS = 12;
export const MAX_FACTS = 30;
export const MAX_EVENTS = 40;
const MAX_DISMISSED = 100;
/** Hard cap on what is added to one employee's instructions. */
export const CONTEXT_MAX_CHARS = 1_400;
const FACT_KINDS: readonly FactKind[] = ["tone", "how", "tool", "recurring", "about"];
/** The signals that count towards the totals. Older ones fall away; the totals are over the latest window. */
const SCOPE_ALL = "all";

export interface FeedbackInput {
  employeeId: string;
  templateKey: string;
  kind: FeedbackKind;
  turnId?: string;
  note?: unknown;
  before?: string;
  after?: string;
}

const empty = (workspaceId: string, at: string): Learned => ({ workspaceId, lessons: [], facts: [], events: [], dismissed: [], updatedAt: at });

export class LearningService {
  private byWorkspace = new Map<string, Learned>();
  private sink?: Sink;

  constructor(private identity: IdentityService, private now: () => Date = () => new Date()) {}

  useSink(sink: Sink): void { this.sink = sink; }
  restore(l: Learned): void { this.byWorkspace.set(l.workspaceId, l); }

  private get(ws: string): Learned { return this.byWorkspace.get(ws) ?? empty(ws, this.now().toISOString()); }
  private save(next: Learned): Learned {
    const saved = { ...next, updatedAt: this.now().toISOString() };
    this.byWorkspace.set(saved.workspaceId, saved);
    this.sink?.record(saved.workspaceId, "learning", saved.workspaceId, saved);
    return saved;
  }

  // ---------- feedback ----------

  /** A thumbs up or down, a redo, or an edit, with an optional note. Returns what was learned (possibly nothing). */
  feedback(userId: string, ws: string, input: FeedbackInput): { learned: string[] } {
    this.identity.require(userId, ws, "task.create");
    if (!["up", "down", "redo", "edit"].includes(input.kind)) throw new LearningError("that is not a kind of feedback");
    const at = this.now().toISOString();
    const note = typeof input.note === "string" ? cleanLine(input.note) : "";
    const learned: string[] = [];
    let cur = this.get(ws);
    const add = (text: string, source: LessonSource): void => {
      const r = this.withLesson(cur, text, input.templateKey, source, at);
      cur = r.next;
      if (r.isNew) learned.push(text);
    };
    if (input.kind === "edit") for (const t of lessonsFromEdit(String(input.before ?? ""), String(input.after ?? ""))) add(t, "edit");
    if (note) add(note, input.kind === "redo" ? "redo" : input.kind === "edit" ? "edit" : "note");
    const ev: FeedbackEvent = { id: newId("fb"), at, employeeId: input.employeeId, templateKey: input.templateKey, kind: input.kind, ...(input.turnId ? { turnId: input.turnId } : {}) };
    this.save({ ...cur, events: [...cur.events, ev].slice(-MAX_EVENTS) });
    return { learned };
  }

  private withLesson(cur: Learned, text: string, scope: string, source: LessonSource, at: string): { next: Learned; isNew: boolean } {
    const key = normal(text);
    if (!key) return { next: cur, isNew: false };
    const hit = cur.lessons.find((l) => normal(l.text) === key && l.scope === scope);
    if (hit) return { next: { ...cur, lessons: cur.lessons.map((l) => (l === hit ? { ...l, count: l.count + 1, at } : l)) }, isNew: false };
    const lesson: Lesson = { id: newId("lesson"), text, scope, source, count: 1, at };
    // Over the cap, the least repeated and oldest preference goes first: a small memory that keeps what keeps coming up.
    const all = [...cur.lessons, lesson];
    const kept = all.length > MAX_LESSONS ? [...all].sort((a, b) => b.count - a.count || b.at.localeCompare(a.at)).slice(0, MAX_LESSONS) : all;
    return { next: { ...cur, lessons: kept }, isNew: kept.includes(lesson) };
  }

  /** A preference the client types in themselves. Applies to everyone on the team. */
  addLesson(userId: string, ws: string, text: unknown): Lesson {
    this.identity.require(userId, ws, "task.create");
    const t = typeof text === "string" ? cleanLine(text) : "";
    if (t.length < 3) throw new LearningError("say what you would like, in a few words");
    const r = this.withLesson(this.get(ws), t, SCOPE_ALL, "you", this.now().toISOString());
    const saved = this.save(r.next);
    return saved.lessons.find((l) => normal(l.text) === normal(t))!;
  }

  deleteLesson(userId: string, ws: string, id: string): void {
    this.identity.require(userId, ws, "task.create");
    const cur = this.get(ws);
    if (!cur.lessons.some((l) => l.id === id)) throw new LearningError("that preference was not found");
    this.save({ ...cur, lessons: cur.lessons.filter((l) => l.id !== id) });
  }

  // ---------- the business profile ----------

  /** The client adds or changes a fact. Their own words always win over what was learned. */
  setFact(userId: string, ws: string, input: { id?: unknown; kind?: unknown; text?: unknown }): ProfileFact {
    this.identity.require(userId, ws, "task.create");
    const text = typeof input.text === "string" ? cleanLine(input.text, 240) : "";
    if (text.length < 3) throw new LearningError("say it in a few words");
    const cur = this.get(ws);
    const at = this.now().toISOString();
    if (typeof input.id === "string") {
      const hit = cur.facts.find((f) => f.id === input.id);
      if (!hit) throw new LearningError("that line was not found");
      const next: ProfileFact = { ...hit, text, at, edited: true, source: "you" };
      this.save({ ...cur, facts: cur.facts.map((f) => (f === hit ? next : f)) });
      return next;
    }
    const kind = FACT_KINDS.find((k) => k === input.kind);
    if (!kind) throw new LearningError("pick what kind of line this is");
    if (cur.facts.length >= MAX_FACTS) throw new LearningError(`a profile keeps at most ${MAX_FACTS} lines. Delete one first`);
    const fact: ProfileFact = { id: newId("fact"), kind, text, source: "you", at };
    this.save({ ...cur, facts: [...cur.facts, fact] });
    return fact;
  }

  deleteFact(userId: string, ws: string, id: string): void {
    this.identity.require(userId, ws, "task.create");
    const cur = this.get(ws);
    const hit = cur.facts.find((f) => f.id === id);
    if (!hit) throw new LearningError("that line was not found");
    // A deleted line that was learned (not typed) is remembered as unwanted, so it does not come back.
    const dismissed = hit.source === "you" ? cur.dismissed : [...cur.dismissed, normal(hit.text)].slice(-MAX_DISMISSED);
    this.save({ ...cur, facts: cur.facts.filter((f) => f.id !== id), dismissed });
  }

  /**
   * Platform-level (no user check): facts found from signup answers, the website, connected apps or repeated work.
   * Skips what is already known or was deleted, and never touches a line the client typed or edited.
   */
  learnFacts(ws: string, found: readonly { kind: FactKind; text: string; source: FactSource }[]): number {
    let cur = this.get(ws);
    const at = this.now().toISOString();
    let added = 0;
    for (const f of found) {
      const text = cleanLine(f.text, 240);
      const key = normal(text);
      if (!key || cur.dismissed.includes(key) || cur.facts.some((x) => normal(x.text) === key)) continue;
      if (cur.facts.length >= MAX_FACTS) break;
      cur = { ...cur, facts: [...cur.facts, { id: newId("fact"), kind: f.kind, text, source: f.source, at }] };
      added++;
    }
    if (added) this.save(cur);
    return added;
  }

  // ---------- reading it back ----------

  /** Everything the client can see, and change. */
  view(userId: string, ws: string) {
    this.identity.require(userId, ws, "task.read");
    const cur = this.get(ws);
    const totals = { up: 0, down: 0, redo: 0, edit: 0 };
    for (const e of cur.events) totals[e.kind]++;
    return { lessons: cur.lessons, facts: cur.facts, totals, window: MAX_EVENTS };
  }

  /** Deletes everything learned about one business: preferences, profile lines and feedback. */
  forgetAll(userId: string, ws: string): void {
    this.identity.require(userId, ws, "task.create");
    this.save(empty(ws, this.now().toISOString()));
  }

  /** Removes every record of a business that is leaving. Platform-level. */
  purge(ws: string): void {
    if (this.byWorkspace.delete(ws)) this.sink?.record(ws, "learning", ws, { workspaceId: ws, lessons: [], facts: [], events: [], dismissed: [], updatedAt: this.now().toISOString() });
  }

  /**
   * The short block added to one employee's instructions. Preferences for that employee (and for everyone) come first,
   * then the business profile. Capped in size, so it adds a little to each request and never grows with time.
   */
  contextFor(ws: string, templateKey: string): string | undefined {
    const cur = this.byWorkspace.get(ws);
    if (!cur) return undefined;
    const lessons = cur.lessons.filter((l) => l.scope === SCOPE_ALL || l.scope === templateKey).sort((a, b) => b.count - a.count || b.at.localeCompare(a.at));
    const lines: string[] = [];
    if (lessons.length) lines.push("What this client has taught you from their feedback and edits. Follow it unless they ask for something different:", ...lessons.map((l) => `- ${l.text}`));
    if (cur.facts.length) lines.push("What you know about how this business works:", ...cur.facts.map((f) => `- ${f.kind}: ${f.text}`));
    if (!lines.length) return undefined;
    const text = lines.join("\n");
    return text.length > CONTEXT_MAX_CHARS ? `${text.slice(0, CONTEXT_MAX_CHARS - 1)}…` : text;
  }
}
