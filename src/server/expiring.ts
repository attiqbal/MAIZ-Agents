/**
 * Remembers keys until they expire, then forgets them, so one-time links can be marked used without the
 * list growing for ever. In memory, per server instance (see docs/RUNBOOK.md: one instance at launch).
 */
export class ExpiringSet {
  private items = new Map<string, number>();
  private addsSinceSweep = 0;

  constructor(private readonly now: () => number = Date.now, private readonly sweepEvery = 1_000) {}

  /** Marks `key` until `expiresAtMs`. A key whose link has already expired need not be kept at all. */
  add(key: string, expiresAtMs: number): void {
    this.items.set(key, expiresAtMs);
    if (++this.addsSinceSweep >= this.sweepEvery) this.sweep();
  }

  has(key: string): boolean {
    const exp = this.items.get(key);
    if (exp === undefined) return false;
    if (exp > this.now()) return true;
    this.items.delete(key);
    return false;
  }

  get size(): number {
    return this.items.size;
  }

  private sweep(): void {
    this.addsSinceSweep = 0;
    const t = this.now();
    for (const [k, exp] of this.items) if (exp <= t) this.items.delete(k);
  }
}

/** Sign-in emails sent per address in the last hour. Old addresses are dropped so the map cannot grow for ever. */
export class SendLog {
  private sends = new Map<string, number[]>();
  private addsSinceSweep = 0;

  constructor(private readonly windowMs = 3_600_000, private readonly sweepEvery = 1_000) {}

  /** Sends to `key` within the window before `nowMs`. */
  recent(key: string, nowMs: number): number[] {
    return (this.sends.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
  }

  record(key: string, nowMs: number): void {
    this.sends.set(key, [...this.recent(key, nowMs), nowMs]);
    if (++this.addsSinceSweep >= this.sweepEvery) {
      this.addsSinceSweep = 0;
      for (const [k, ts] of this.sends) if (!ts.some((t) => nowMs - t < this.windowMs)) this.sends.delete(k);
    }
  }

  /** Forgets everything recorded for `key`. */
  clear(key: string): void {
    this.sends.delete(key);
  }

  get size(): number {
    return this.sends.size;
  }
}
