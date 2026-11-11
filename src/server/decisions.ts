/**
 * Decisions waiting for the platform owner: quality reviews and new specialists. The owner gets one email that
 * says how many are open, with a button to a page listing all of them, not one email per request.
 */
export interface OpenDecision {
  kind: "review" | "specialist";
  id: string;
  title: string;
  clientName: string;
  ageHours: number;
  /** Page that opens this decision, for example /review.html#id. */
  link: string;
}

export interface DecisionSources {
  reviews: { id: string; status: string; clientName: string; ageHours: number; proposal: { title: string } }[];
  specialists: { id: string; status: string; clientName: string; submittedAt: string; role: { title: string } }[];
}

export function openDecisions(src: DecisionSources, nowMs: number): OpenDecision[] {
  const reviews = src.reviews
    .filter((r) => r.status === "in_review")
    .map((r): OpenDecision => ({ kind: "review", id: r.id, title: r.proposal.title, clientName: r.clientName, ageHours: r.ageHours, link: `/review.html#${r.id}` }));
  const specialists = src.specialists
    .filter((r) => r.status === "in_review")
    .map((r): OpenDecision => ({ kind: "specialist", id: r.id, title: r.role.title, clientName: r.clientName, ageHours: Math.max(0, Math.floor((nowMs - Date.parse(r.submittedAt)) / 3_600_000)), link: `/owner-specialists.html#${r.id}` }));
  return [...reviews, ...specialists].sort((a, b) => b.ageHours - a.ageHours);
}

export interface DigestOptions {
  /** How many decisions are open now. */
  count: () => number;
  /** Sends the one email. */
  send: (count: number) => Promise<void>;
  now: () => number;
  /** Fewest milliseconds between two emails. */
  gapMs?: number;
  /** Runs `fn` after `ms`. Tests pass their own. */
  later?: (fn: () => void, ms: number) => void;
}

export const DIGEST_GAP_MS = 30 * 60_000;

/**
 * Call `poke()` whenever a decision opens. The first goes out at once; any more inside the gap are folded
 * into a single email when the gap ends, and only if something is still open then.
 */
export class DecisionDigest {
  private lastSent = Number.NEGATIVE_INFINITY;
  private waiting = false;
  readonly stats = { sent: 0 };

  constructor(private readonly o: DigestOptions) {}

  poke(): void {
    const gap = this.o.gapMs ?? DIGEST_GAP_MS;
    const wait = this.lastSent + gap - this.o.now();
    if (wait <= 0) { void this.fire(); return; }
    if (this.waiting) return;
    this.waiting = true;
    const later = this.o.later ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
    later(() => { this.waiting = false; void this.fire(); }, wait);
  }

  private async fire(): Promise<void> {
    const count = this.o.count();
    if (count === 0) return;
    this.lastSent = this.o.now();
    try {
      await this.o.send(count);
      this.stats.sent++;
    } catch (e) {
      console.error("decision email failed:", e instanceof Error ? e.message : e);
    }
  }
}
