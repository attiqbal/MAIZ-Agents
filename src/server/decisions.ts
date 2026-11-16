/**
 * Decisions waiting for the platform owner: quality reviews and new specialists. The owner gets one email that
 * says how many are open, with a button to a page listing all of them, not one email per request.
 */
export interface OpenDecision {
  kind: "review" | "specialist" | "promotion";
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
  /** Promotion drafts and campaign plans waiting for the owner (optional so older callers still work). */
  growth?: { items: { id: string; title: string; site: string; createdAt: string }[]; approvals: { id: string; summary: string; createdAt: string }[] };
  promotions?: { drafts: { id: string; title: string; site: string; createdAt: string }[]; plans: { id: string; name: string; site: string; createdAt: string }[] };
}

export function openDecisions(src: DecisionSources, nowMs: number): OpenDecision[] {
  const reviews = src.reviews
    .filter((r) => r.status === "in_review")
    .map((r): OpenDecision => ({ kind: "review", id: r.id, title: r.proposal.title, clientName: r.clientName, ageHours: r.ageHours, link: `/review.html#${r.id}` }));
  const specialists = src.specialists
    .filter((r) => r.status === "in_review")
    .map((r): OpenDecision => ({ kind: "specialist", id: r.id, title: r.role.title, clientName: r.clientName, ageHours: Math.max(0, Math.floor((nowMs - Date.parse(r.submittedAt)) / 3_600_000)), link: `/owner-specialists.html#${r.id}` }));
  const hours = (iso: string) => Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 3_600_000));
  const promos: OpenDecision[] = [
    ...(src.promotions?.drafts ?? []).map((d): OpenDecision => ({ kind: "promotion", id: d.id, title: d.title, clientName: `Promotion draft (${d.site})`, ageHours: hours(d.createdAt), link: `/owner-promoter.html#${d.id}` })),
    ...(src.promotions?.plans ?? []).map((c): OpenDecision => ({ kind: "promotion", id: c.id, title: c.name, clientName: `Campaign plan (${c.site})`, ageHours: hours(c.createdAt), link: `/owner-promoter.html#${c.id}` })),
    ...(src.growth?.items ?? []).map((d): OpenDecision => ({ kind: "promotion", id: d.id, title: d.title, clientName: `Community post (${d.site})`, ageHours: hours(d.createdAt), link: `/owner-growth.html#${d.id}` })),
    ...(src.growth?.approvals ?? []).map((a): OpenDecision => ({ kind: "promotion", id: a.id, title: a.summary, clientName: "Community permission", ageHours: hours(a.createdAt), link: `/owner-growth.html#${a.id}` })),
  ];
  return [...reviews, ...specialists, ...promos].sort((a, b) => b.ageHours - a.ageHours);
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
  /** Sends the hourly reminder that lists what is still waiting. Left out: no reminders. */
  remind?: (count: number) => Promise<void>;
  /** True during the owner's night, when reminders are held back. */
  quiet?: () => boolean;
  /** Fewest milliseconds between two reminders, and between any email and the next reminder. */
  reminderGapMs?: number;
}

export const DIGEST_GAP_MS = 30 * 60_000;
export const REMINDER_GAP_MS = 60 * 60_000;
/** Reminders are held between these local hours (22:00 up to, not including, 07:00). */
export const QUIET_FROM_HOUR = 22;
export const QUIET_UNTIL_HOUR = 7;

/** True between 22:00 and 07:00 in the given time zone. An unknown zone is read as UTC. */
export function inQuietHours(at: Date, timeZone: string): boolean {
  let hour: number;
  try {
    hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(at));
  } catch {
    hour = at.getUTCHours();
  }
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

/**
 * Call `poke()` whenever a decision opens. The first goes out at once; any more inside the gap are folded
 * into a single email when the gap ends, and only if something is still open then.
 */
export class DecisionDigest {
  private lastSent = Number.NEGATIVE_INFINITY;
  private waiting = false;
  /** When the reminder clock started: the first tick that found something waiting. */
  private waitingSince: number | undefined;
  readonly stats = { sent: 0, reminded: 0 };

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

  /**
   * Call once a minute. While anything is still waiting for sign-off, the owner gets one reminder an hour (never at
   * night), each listing what is open. The hour is counted from the last email of either kind, and from the first
   * tick that sees something waiting, so a restart never sends a reminder straight away.
   */
  async tick(): Promise<void> {
    if (!this.o.remind) return;
    const count = this.o.count();
    if (count === 0) { this.waitingSince = undefined; return; }
    const t = this.o.now();
    // An email already sent in this process starts the hour; otherwise this first sighting does.
    this.waitingSince ??= Number.isFinite(this.lastSent) ? this.lastSent : t;
    const gap = this.o.reminderGapMs ?? REMINDER_GAP_MS;
    if (t - Math.max(this.lastSent, this.waitingSince) < gap || this.o.quiet?.()) return;
    this.lastSent = t;
    try {
      await this.o.remind(count);
      this.stats.reminded++;
    } catch (e) {
      console.error("sign-off reminder failed:", e instanceof Error ? e.message : e);
    }
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
