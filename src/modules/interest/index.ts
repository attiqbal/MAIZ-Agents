import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";

/** One person who asked to hear when MAIZ Agents opens. Platform level: no workspace exists yet. */
export interface InterestRecord {
  id: string;
  email: string;
  name: string;
  business: string;
  need: string;
  /** The page they registered from (a short path such as /pricing.html), for the owner's own counting. */
  source: string;
  createdAt: string;
  updatedAt: string;
  /** Set when they asked to be taken off the list. Kept (without the free text) so they are not added again by accident. */
  removed?: boolean;
}

export class InterestError extends Error {}

const NAME_MAX = 100;
const BUSINESS_MAX = 150;
const NEED_MAX = 1000;
const EMAIL_MAX = 254;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

/** The "register your interest" list. Same email twice updates the one entry, so nobody is counted or emailed twice. */
export class InterestService {
  private byEmail = new Map<string, InterestRecord>();
  private sink?: Sink;
  constructor(private readonly now: () => Date = () => new Date()) {}

  useSink(sink: Sink): void { this.sink = sink; }

  restore(r: InterestRecord): void { this.byEmail.set(r.email, r); }

  /** Validates and stores. `fresh` is false when this address was already on the list (so no second thank-you email). */
  register(input: Record<string, unknown>): { record: InterestRecord; fresh: boolean } {
    const email = clean(input.email, EMAIL_MAX).toLowerCase();
    if (!EMAIL.test(email)) throw new InterestError("Please enter a valid email address.");
    const name = clean(input.name, NAME_MAX);
    if (!name) throw new InterestError("Please tell us your name.");
    const at = this.now().toISOString();
    const before = this.byEmail.get(email);
    const record: InterestRecord = {
      id: before?.id ?? newId("int"),
      email,
      name,
      business: clean(input.business, BUSINESS_MAX),
      need: clean(input.need, NEED_MAX),
      source: /^\/[\w\-./]{0,80}$/.test(clean(input.source, 90)) ? clean(input.source, 90) : "/",
      createdAt: before?.createdAt ?? at,
      updatedAt: at,
    };
    this.byEmail.set(email, record);
    this.sink?.promo("interest", record.id, record);
    return { record, fresh: !before || !!before.removed };
  }

  /** Takes someone off the list on their request: the free text is wiped, and the address is kept so they are not re-added by a stale form. */
  remove(email: string): boolean {
    const r = this.byEmail.get(email.trim().toLowerCase());
    if (!r || r.removed) return false;
    const gone: InterestRecord = { ...r, name: "", business: "", need: "", removed: true, updatedAt: this.now().toISOString() };
    this.byEmail.set(gone.email, gone);
    this.sink?.promo("interest", gone.id, gone);
    return true;
  }

  /** Newest first, for the owner. */
  list(): InterestRecord[] {
    return [...this.byEmail.values()].filter((r) => !r.removed).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
