import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { Account, JournalEntry } from "../ledger/index.js";
import { MAX_AMOUNT_MINOR } from "../ledger/index.js";
import type { StoredRecord } from "../integrations/service.js";
import type { Order } from "../payments/service.js";

/**
 * Nightly reconciliation: proves, per client, that the books agree with themselves and with the things that feed
 * them. It reads only; it never changes a book. A finding is a question for a person, not a correction.
 * `reconcile` is a pure function so every rule is tested on plain data; the service runs it at each client's
 * local midnight and keeps the latest report per day.
 */
export type Severity = "error" | "warn";
export interface Finding { check: string; severity: Severity; message: string; ref?: string }

export interface ReconciliationReport {
  id: string;
  workspaceId: string;
  /** The client's local date this run belongs to, YYYY-MM-DD. */
  date: string;
  ranAt: string;
  entries: number;
  ok: boolean;
  findings: Finding[];
}

export interface ReconcileInput {
  accounts: readonly Account[];
  entries: readonly JournalEntry[];
  records: readonly StoredRecord[];
  orders: readonly Order[];
  cashAccount?: string;
}

export function reconcile(input: ReconcileInput): Finding[] {
  const out: Finding[] = [];
  const add = (check: string, severity: Severity, message: string, ref?: string) => out.push({ check, severity, message, ...(ref ? { ref } : {}) });
  const accounts = new Set(input.accounts.map((a) => a.code));
  const byId = new Map<string, JournalEntry>(input.entries.map((e) => [e.id, e]));

  let totalDebit = 0;
  let totalCredit = 0;
  for (const e of input.entries) {
    let debit = 0, credit = 0;
    for (const l of e.lines) {
      if (!accounts.has(l.account)) add("entry-lines", "error", `Entry "${e.memo}" uses account ${l.account}, which is not in the chart`, e.id);
      if (!Number.isInteger(l.debit) || !Number.isInteger(l.credit) || l.debit < 0 || l.credit < 0 || l.debit > MAX_AMOUNT_MINOR || l.credit > MAX_AMOUNT_MINOR || (l.debit > 0) === (l.credit > 0)) add("entry-lines", "error", `Entry "${e.memo}" has a line that is not a valid debit or credit`, e.id);
      debit += l.debit; credit += l.credit;
    }
    if (debit !== credit) add("balanced", "error", `Entry "${e.memo}" on ${e.date} does not balance (debits ${debit}, credits ${credit})`, e.id);
    totalDebit += debit; totalCredit += credit;
  }
  if (totalDebit !== totalCredit) add("trial-balance", "error", `The trial balance is out by ${Math.abs(totalDebit - totalCredit)} (debits ${totalDebit}, credits ${totalCredit})`);

  // Reversals must mirror a real entry, once.
  const reversedBy = new Map<string, string[]>();
  for (const e of input.entries) {
    if (!e.reverses) continue;
    const orig = byId.get(e.reverses);
    (reversedBy.get(e.reverses) ?? reversedBy.set(e.reverses, []).get(e.reverses)!).push(e.id);
    if (!orig) { add("reversals", "error", `A reversal points at an entry that does not exist`, e.id); continue; }
    const mirror = (a: JournalEntry, b: JournalEntry) => a.lines.length === b.lines.length && a.lines.every((l) => b.lines.some((m) => m.account === l.account && m.debit === l.credit && m.credit === l.debit));
    if (!mirror(orig, e)) add("reversals", "error", `The reversal of "${orig.memo}" does not mirror the original`, e.id);
  }
  for (const [id, by] of reversedBy) if (by.length > 1) add("reversals", "error", `"${byId.get(id)?.memo ?? id}" was reversed ${by.length} times`, id);

  // The same source document booked twice (and not reversed in between) is a double posting.
  const live = input.entries.filter((e) => !e.reverses && !reversedBy.has(e.id) && e.source);
  const seen = new Map<string, JournalEntry>();
  for (const e of live) {
    const first = seen.get(e.source!);
    if (first) add("double-posting", "error", `"${e.source}" is booked twice ("${first.memo}" and "${e.memo}")`, e.id);
    else seen.set(e.source!, e);
  }

  // App records and the books must agree on what was posted.
  for (const r of input.records) {
    if (r.status !== "posted") continue;
    const entry = r.entryId ? byId.get(r.entryId) : undefined;
    if (!entry) add("app-records", "error", `${r.kind} ${r.date} is marked as booked but its entry is missing`, r.id);
    else if (entry.source !== `app:${r.id}`) add("app-records", "error", `${r.kind} ${r.date} points at an entry from a different source`, r.id);
  }
  const posted = new Set(input.records.filter((r) => r.status === "posted").map((r) => `app:${r.id}`));
  for (const e of input.entries) {
    if (e.source?.startsWith("app:") && !e.reverses && !reversedBy.has(e.id) && !posted.has(e.source)) add("app-records", "warn", `Entry "${e.memo}" came from an app record that is no longer marked as booked`, e.id);
  }

  // Money owed by the platform to the client: a paid order whose purchase never arrived.
  for (const o of input.orders) {
    if (o.status === "paid" && !o.fulfilledAt) add("orders", "error", `A paid order of ${(o.dueTodayMinor / 100).toFixed(2)} has not been delivered`, o.id);
  }

  const cash = input.cashAccount ?? "1000";
  if (accounts.has(cash)) {
    let bal = 0;
    for (const e of input.entries) for (const l of e.lines) if (l.account === cash) bal += l.debit - l.credit;
    if (bal < 0) add("cash", "warn", `The bank account is below zero (${(bal / 100).toFixed(2)}). Check for a missing deposit or a duplicate payment`);
  }
  return out;
}

export interface ReconDeps {
  workspaceIds: () => string[];
  /** The client's local date, YYYY-MM-DD, so each client is checked once after their own midnight. */
  localDate: (workspaceId: string) => string;
  books: (workspaceId: string) => { accounts: Account[]; entries: readonly JournalEntry[] } | undefined;
  records: (workspaceId: string) => StoredRecord[];
  orders: (workspaceId: string) => Order[];
  now: () => Date;
  /** Told once per client and day when a run finds errors. Must not throw. */
  alert?: (workspaceId: string, report: ReconciliationReport) => Promise<void>;
}

export class ReconciliationService {
  /** Latest report per workspace. */
  private latest = new Map<string, ReconciliationReport>();
  private history = new Map<string, ReconciliationReport[]>();
  private sink?: Sink;
  private running = false;

  constructor(private d: ReconDeps) {}

  useSink(sink: Sink): void { this.sink = sink; }
  restore(r: ReconciliationReport): void {
    const prev = this.latest.get(r.workspaceId);
    if (!prev || prev.date <= r.date) this.latest.set(r.workspaceId, r);
  }

  /** Call every minute. Checks each client the first time their local date changes; cheap when nothing is due. */
  async tick(): Promise<ReconciliationReport[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const done: ReconciliationReport[] = [];
      for (const ws of this.d.workspaceIds()) {
        if (this.latest.get(ws)?.date === this.d.localDate(ws)) continue;
        const r = await this.runOne(ws);
        if (r) done.push(r);
      }
      return done;
    } catch (err) {
      console.error("reconciliation failed:", err instanceof Error ? err.message : err);
      return [];
    } finally {
      this.running = false;
    }
  }

  /** Checks one client now (platform owner's "run now", and the nightly run). */
  async runOne(workspaceId: string): Promise<ReconciliationReport | undefined> {
    const books = this.d.books(workspaceId);
    if (!books) return undefined; // books not opened yet: nothing to reconcile
    const findings = reconcile({ accounts: books.accounts, entries: books.entries, records: this.d.records(workspaceId), orders: this.d.orders(workspaceId) });
    const date = this.d.localDate(workspaceId);
    const report: ReconciliationReport = { id: newId("recon"), workspaceId, date, ranAt: this.d.now().toISOString(), entries: books.entries.length, ok: !findings.some((f) => f.severity === "error"), findings };
    const alreadyToldToday = this.latest.get(workspaceId)?.date === date && !this.latest.get(workspaceId)!.ok;
    this.latest.set(workspaceId, report);
    this.history.set(workspaceId, [...(this.history.get(workspaceId) ?? []), report].slice(-30));
    this.sink?.record(workspaceId, "recon", "latest", report);
    if (!report.ok && !alreadyToldToday) await this.d.alert?.(workspaceId, report).catch(() => undefined);
    return report;
  }

  latestFor(workspaceId: string): ReconciliationReport | undefined { return this.latest.get(workspaceId); }
  all(): ReconciliationReport[] { return [...this.latest.values()].sort((a, b) => Number(a.ok) - Number(b.ok) || b.ranAt.localeCompare(a.ranAt)); }
}
