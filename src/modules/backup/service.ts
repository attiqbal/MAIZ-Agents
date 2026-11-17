import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import type { Sink } from "../../core/persistence.js";
import { PermissionError } from "../identity/index.js";
import { assertPublicHost } from "../integrations/connectors/util.js";
import type { DbAdmin } from "./db.js";
import { makeBackup, sweepTemp, testRestore, type JobContext } from "./jobs.js";
import { ProgramMissing, type ProgramRunner } from "./program.js";
import { S3Client } from "./s3.js";
import { ALERT_GAP_MS, NIGHTLY_AT, STALE_AFTER_MS, localClock, nextNightly, nightlyDue, restoreTestDue, safeZone, sayWhen } from "./schedule.js";
import { makeRecoveryKey } from "./seal.js";
import { folderPrefix, readStorageForm } from "./settings.js";
import { sha256Hex } from "./sigv4.js";
import { BackupBusy, BackupError, type BackupKind, type BackupState, type BackupView, type JobKind, type RecoveryKeyRecord, type StorageSettings } from "./types.js";

/** Everything backups store goes through the encrypted connection-secret store under names that start with this. */
export const BACKUP_SECRET_PREFIX = "backup:";
const STORAGE_KEY = `${BACKUP_SECRET_PREFIX}storage`;
const KEYS_KEY = `${BACKUP_SECRET_PREFIX}keys`;
const STATE_KEY = `${BACKUP_SECRET_PREFIX}state`;
/** Recovery keys kept after the owner makes a new one, so the server can still test backups made with them. */
const OLD_KEYS_KEPT = 5;
/** How long "not available on this server" is believed before looking again. */
const RECHECK_UNAVAILABLE_MS = 10 * 60_000;
const NO_DATABASE = "Backups are not available on this server: it keeps its data in memory only, so there is no database to back up.";
const NO_PROGRAMS = "Backups are not available on this server: the database backup programs (pg_dump and pg_restore) are not installed on it.";

export type BackupProblem = "backup_failed" | "stale" | "restore_failed";
export interface BackupAlert { problem: BackupProblem; subject: string; text: string }

export interface BackupOptions {
  isOwner: (userId: string) => boolean;
  now: () => Date;
  /** The owner's time zone: the nightly backup runs at 03:10 there. */
  timezone?: string;
  /** Address of the Backups page, for alerts. */
  pageUrl: string;
  /** Tells the platform owner (email and their devices). */
  alert: (a: BackupAlert) => Promise<void>;
  http?: typeof fetch;
  /** Runs pg_dump and pg_restore. Left out: backups are not available. */
  run?: ProgramRunner;
  /** Throwaway databases for restore tests. Left out: backups are not available. */
  db?: DbAdmin;
  /** The database to back up (DATABASE_URL). Left out: backups are not available. */
  databaseUrl?: string;
  /** Where working files go. Default: the system's temporary directory. */
  tmpDir?: string;
  /** The server's own keys to seal inside each backup (TOKEN_KEY), so one saved recovery key is enough after losing the server. */
  serverKeys?: () => Readonly<Record<string, string>>;
  /** Writes anything still waiting in memory to the database before it is dumped. */
  flush?: () => Promise<void>;
}

interface KeyStore { current?: RecoveryKeyRecord; older: RecoveryKeyRecord[] }
type Availability = { ok: true } | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Off-server backups the app runs by itself: a nightly encrypted dump to the owner's S3-compatible storage, a weekly
 * restore test into a throwaway database, and alerts to the owner when something is wrong. Set up entirely in the
 * browser; see docs/BACKUPS.md.
 */
export class BackupService {
  private storage?: StorageSettings;
  private keys: KeyStore = { older: [] };
  private state: BackupState = { alerts: {} };
  private sink?: Sink;
  private running: JobKind | null = null;
  private availability?: { value: Availability; at: number };
  private swept = false;
  private readonly zone: string;

  constructor(private readonly o: BackupOptions) {
    this.zone = safeZone(o.timezone);
  }

  // ---- storage ----
  useSink(sink: Sink): void {
    this.sink = sink;
    // Anything made before storage was attached is saved now, so it survives the next restart.
    if (this.storage) sink.connectionSecret(STORAGE_KEY, JSON.stringify(this.storage));
    if (this.keys.current) sink.connectionSecret(KEYS_KEY, JSON.stringify(this.keys));
    if (this.state.lastBackup || this.state.lastFailure || this.state.lastRestoreTest) sink.connectionSecret(STATE_KEY, JSON.stringify(this.state));
  }

  /** Puts back one stored value after a restart. Anything unreadable is ignored: the owner sets it up again. */
  restoreSecret(key: string, secret: string): void {
    let v: unknown;
    try { v = JSON.parse(secret); } catch { return; }
    if (!isObject(v)) return;
    if (key === STORAGE_KEY && typeof v.host === "string" && typeof v.bucket === "string" && typeof v.secret === "string") this.storage = v as unknown as StorageSettings;
    else if (key === KEYS_KEY && Array.isArray(v.older)) this.keys = v as unknown as KeyStore;
    else if (key === STATE_KEY && isObject(v.alerts)) this.state = v as unknown as BackupState;
  }

  private saveState(next: BackupState): void {
    this.state = next;
    this.sink?.connectionSecret(STATE_KEY, JSON.stringify(next));
  }

  private owner(userId: string): void {
    if (!this.o.isOwner(userId)) throw new PermissionError("only the MAIZ platform owner can manage backups");
  }

  // ---- can backups run here at all ----
  private async available(): Promise<Availability> {
    const now = this.o.now().getTime();
    const cached = this.availability;
    if (cached && (cached.value.ok || now - cached.at < RECHECK_UNAVAILABLE_MS)) return cached.value;
    const value = await this.probe();
    this.availability = { value, at: now };
    return value;
  }

  private async probe(): Promise<Availability> {
    if (!this.o.databaseUrl || !this.o.db || !this.o.run) return { ok: false, reason: NO_DATABASE };
    try {
      for (const program of ["pg_dump", "pg_restore"]) {
        const out = new PassThrough();
        out.resume();
        const r = await this.o.run(program, ["--version"], { stdout: out, timeoutMs: 10_000 });
        if (r.code !== 0) return { ok: false, reason: NO_PROGRAMS };
      }
      return { ok: true };
    } catch (e) {
      if (!(e instanceof ProgramMissing)) console.error("backup: could not check for pg_dump:", e instanceof Error ? e.name : "error");
      return { ok: false, reason: NO_PROGRAMS };
    }
  }

  // ---- what the page shows ----
  async view(userId: string): Promise<BackupView> {
    this.owner(userId);
    const a = await this.available();
    const s = this.storage;
    const k = this.keys.current;
    return {
      available: a.ok, ...(a.ok ? {} : { unavailable: a.reason }),
      configured: this.configured(),
      ...(s ? { storage: { address: `https://${s.host}`, bucket: s.bucket, region: s.region, folder: s.folder, keyId: s.keyId, keep: s.keep, savedAt: s.savedAt } } : {}),
      ...(k ? { recoveryKey: { id: k.id, createdAt: k.createdAt, saved: !!k.savedAt, olderKeys: this.keys.older.length } } : {}),
      running: this.running,
      ...(this.state.lastBackup ? { lastBackup: this.state.lastBackup } : {}),
      ...(this.state.lastFailure ? { lastFailure: this.state.lastFailure } : {}),
      ...(this.state.lastRestoreTest ? { lastRestoreTest: this.state.lastRestoreTest } : {}),
      ...(a.ok && this.configured() ? { nextBackupAt: nextNightly(this.o.now(), this.zone).toISOString() } : {}),
      fresh: this.health().ok,
      timezone: this.zone,
    };
  }

  /** Set up means: somewhere to put backups, and a key to lock them with. */
  private configured(): boolean {
    return !!this.storage && !!this.keys.current;
  }

  /** For the public health check: false only when backups are set up and the newest good one is too old. */
  health(): { ok: boolean } {
    return { ok: !this.configured() || this.o.now().getTime() - Date.parse(this.freshSince()) <= STALE_AFTER_MS };
  }

  /** The newest good backup, or (when there has never been one) the moment backups were set up. */
  private freshSince(): string {
    const setUp = [this.storage?.savedAt, this.keys.current?.createdAt].filter((x): x is string => !!x).sort().pop();
    return this.state.lastBackup?.at ?? setUp ?? this.o.now().toISOString();
  }

  // ---- set-up ----
  /** Checks what the owner typed, proves the storage takes, lists and removes a file with it, and only then saves it. */
  async saveStorage(userId: string, raw: unknown): Promise<void> {
    this.owner(userId);
    const next = readStorageForm(raw, this.storage, this.o.now().toISOString());
    await this.checkHost(next.host);
    const s3 = this.client(next);
    const probe = `${folderPrefix(next.folder)}maiz-connection-check-${this.o.now().getTime()}.txt`;
    const body = Buffer.from("MAIZ Agents checked that it can write here. This file is safe to delete.\n");
    await s3.put(probe, body, sha256Hex(body));
    await s3.list(probe);
    await s3.remove(probe);
    // A first save is the moment backups were set up; later edits do not restart the 36-hour clock.
    this.storage = { ...next, savedAt: this.storage && this.keys.current ? this.storage.savedAt : next.savedAt };
    this.sink?.connectionSecret(STORAGE_KEY, JSON.stringify(this.storage));
  }

  /** Turns backups off. The recovery keys stay, because backups already in storage still need them. */
  removeStorage(userId: string): void {
    this.owner(userId);
    this.storage = undefined;
    this.sink?.connectionSecret(STORAGE_KEY, "");
  }

  /**
   * Makes the recovery key and hands it back this once. The server keeps a copy (encrypted) so the nightly run can
   * use it; the owner must keep theirs somewhere that is not this server. An older key is kept on the server so
   * backups made with it can still be tested.
   */
  makeRecoveryKey(userId: string, opts: { replace?: boolean } = {}): { recoveryKey: string } {
    this.owner(userId);
    const old = this.keys.current;
    if (old && !opts.replace) throw new BackupError("There is already a recovery key. Use \"Make a new recovery key\" if you want to replace it.");
    const made = makeRecoveryKey();
    this.keys = {
      current: { id: made.id, key: made.bytes.toString("base64"), createdAt: this.o.now().toISOString() },
      older: old ? [old, ...this.keys.older].slice(0, OLD_KEYS_KEPT) : this.keys.older,
    };
    this.sink?.connectionSecret(KEYS_KEY, JSON.stringify(this.keys));
    return { recoveryKey: made.text };
  }

  confirmKeySaved(userId: string): void {
    this.owner(userId);
    const k = this.keys.current;
    if (!k) throw new BackupError("There is no recovery key yet. Make one first.");
    this.keys = { ...this.keys, current: { ...k, savedAt: k.savedAt ?? this.o.now().toISOString() } };
    this.sink?.connectionSecret(KEYS_KEY, JSON.stringify(this.keys));
  }

  // ---- running ----
  /** Starts a backup or a restore test for the owner. Resolves once it has started; `done` resolves when it has finished (it never rejects). */
  async begin(userId: string, what: JobKind): Promise<{ done: Promise<void> }> {
    this.owner(userId);
    const a = await this.available();
    if (!a.ok) throw new BackupError(a.reason);
    if (!this.storage) throw new BackupError("Add your storage details first, so there is somewhere to put the backup.");
    if (!this.keys.current) throw new BackupError("Make your recovery key first. Backups are locked with it.");
    if (this.running) throw new BackupBusy(this.running === "backup" ? "A backup is being made right now. Wait for it to finish." : "A restore test is running right now. Wait for it to finish.");
    return { done: what === "backup" ? this.backup("manual").then(() => undefined) : this.restoreTest().then(() => undefined) };
  }

  private client(s: StorageSettings): S3Client {
    return new S3Client({ host: s.host, bucket: s.bucket, keyId: s.keyId, secret: s.secret, region: s.region }, this.o.http ?? fetch, this.o.now);
  }

  private async checkHost(host: string): Promise<void> {
    try { await assertPublicHost(host, "Your storage"); } catch { throw new BackupError("Your storage could not be reached. Check the address."); }
  }

  private async context(): Promise<{ ctx: JobContext; storage: StorageSettings }> {
    const storage = this.storage;
    if (!storage || !this.o.run || !this.o.db || !this.o.databaseUrl) throw new BackupError("Backups are not set up.");
    await this.checkHost(storage.host);
    return { storage, ctx: { s3: this.client(storage), run: this.o.run, db: this.o.db, databaseUrl: this.o.databaseUrl, tmpRoot: this.o.tmpDir ?? tmpdir(), now: this.o.now } };
  }

  /** Words for the owner, with any secret that slipped into a program's message taken out. */
  private explain(e: unknown, fallback: string): { reason: string; detail?: string } {
    const hide = (text: string): string => {
      let out = text;
      const secrets = [this.storage?.secret, this.o.databaseUrl ? decodeURIComponent(new URL(this.o.databaseUrl).password) : undefined, this.o.databaseUrl];
      for (const s of secrets) if (s) out = out.split(s).join("***");
      return out;
    };
    if (e instanceof ProgramMissing) return { reason: NO_PROGRAMS };
    if (e instanceof BackupError) return { reason: e.message, ...(e.detail ? { detail: hide(e.detail) } : {}) };
    console.error("backup: unexpected error:", e instanceof Error ? e.name : "error");
    return { reason: fallback };
  }

  /** Makes one backup. Returns true when it is safely in storage. Never throws. */
  private async backup(kind: BackupKind): Promise<boolean> {
    this.running = "backup";
    const at = this.o.now().toISOString();
    try {
      const { ctx, storage } = await this.context();
      const key = Buffer.from(this.keys.current!.key, "base64");
      const { pruneProblem, ...made } = await makeBackup(ctx, { kind, key, folder: storage.folder, keep: storage.keep, serverKeys: this.o.serverKeys?.(), flush: this.o.flush });
      const failure = this.state.lastFailure?.what === "backup" ? undefined : this.state.lastFailure;
      this.saveState({ ...this.state, lastBackup: { ...made, ...(pruneProblem ? { note: `Older backups could not be removed from your storage. ${pruneProblem}` } : {}) }, lastFailure: failure });
      return true;
    } catch (e) {
      this.saveState({ ...this.state, lastFailure: { at, what: "backup", ...this.explain(e, "Something unexpected went wrong while making the backup.") } });
      return false;
    } finally {
      this.running = null;
    }
  }

  /** Tests the newest backup. Returns true when it passed. Never throws. */
  private async restoreTest(): Promise<boolean> {
    this.running = "restore_test";
    const at = this.o.now().toISOString();
    try {
      const { ctx, storage } = await this.context();
      const keys = [this.keys.current, ...this.keys.older].filter((k): k is RecoveryKeyRecord => !!k).map((k) => Buffer.from(k.key, "base64"));
      const result = await testRestore(ctx, keys, storage.folder);
      const tidy = result.detail ? { ...result, detail: this.explain(new BackupError(result.problem ?? "", result.detail), "").detail } : result;
      this.recordTest(tidy);
      return result.ok;
    } catch (e) {
      const why = this.explain(e, "Something unexpected went wrong during the restore test.");
      this.recordTest({ at, ok: false, problem: why.reason, ...(why.detail ? { detail: why.detail } : {}) });
      return false;
    } finally {
      this.running = null;
    }
  }

  private recordTest(r: NonNullable<BackupState["lastRestoreTest"]>): void {
    const kept = this.state.lastFailure?.what === "restore_test" ? undefined : this.state.lastFailure;
    const failure = r.ok ? kept : { at: r.at, what: "restore_test" as const, reason: r.problem ?? "The restore test did not pass.", ...(r.detail ? { detail: r.detail } : {}) };
    this.saveState({ ...this.state, lastRestoreTest: r, lastFailure: failure });
  }

  // ---- the timer ----
  /**
   * Call once a minute. Starts the nightly backup or the weekly restore test when one is due (one job at a time), and
   * tells the owner when a nightly backup fails, a restore test fails, or there has been no good backup for 36 hours.
   * Never throws.
   */
  async tick(): Promise<void> {
    try {
      if (!this.swept) {
        this.swept = true;
        await sweepTemp(this.o.tmpDir ?? tmpdir());
      }
      if (!this.configured() || this.running) return;
      const a = await this.available();
      // A manual backup may have started while the check above was waiting.
      if (this.running) return;
      const now = this.o.now();
      if (a.ok && nightlyDue(this.state, now, this.zone)) await this.nightly(now);
      else if (a.ok && restoreTestDue(this.state, now, this.zone)) await this.weeklyTest(now);
      await this.staleCheck(a);
    } catch (e) {
      console.error("backup tick failed:", e instanceof Error ? e.name : "error");
    }
  }

  private async nightly(now: Date): Promise<void> {
    const date = localClock(now, this.zone).date;
    const before = this.state.nightly?.date === date ? this.state.nightly.attempts : 0;
    this.saveState({ ...this.state, nightly: { date, attempts: before + 1, lastAttemptAt: now.toISOString(), done: false } });
    const ok = await this.backup("nightly");
    this.saveState({ ...this.state, nightly: { ...this.state.nightly!, done: ok } });
    if (ok) return;
    await this.alert("backup_failed", "Last night's backup did not work", [
      "The nightly backup of MAIZ Agents did not finish.",
      `What went wrong: ${this.state.lastFailure?.reason ?? "unknown"}`,
      "The site itself is not affected and nothing was lost. The backup is tried again each hour, three times in all.",
      `Open the Backups page to see more, or to press "Back up now": ${this.o.pageUrl}`,
    ]);
  }

  private async weeklyTest(now: Date): Promise<void> {
    this.saveState({ ...this.state, autoRestoreAt: now.toISOString() });
    if (await this.restoreTest()) return;
    await this.alert("restore_failed", "A backup could not be restored in a test", [
      "Each week MAIZ Agents opens the newest backup and loads it into a throwaway copy of the database, to prove it could be restored. This week's test did not pass.",
      `What went wrong: ${this.state.lastRestoreTest?.problem ?? "unknown"}`,
      "The live site and its data were not touched. The test runs again tomorrow.",
      `Open the Backups page to see more: ${this.o.pageUrl}`,
    ]);
  }

  private async staleCheck(a: Availability): Promise<void> {
    if (this.health().ok) return;
    const last = this.state.lastBackup;
    await this.alert("stale", "No backup for 36 hours", [
      last ? `The last good backup of MAIZ Agents was made on ${sayWhen(last.at, this.zone)}. There has not been one since.` : "MAIZ Agents has not made a backup since backups were set up.",
      a.ok ? `What went wrong last time: ${this.state.lastFailure?.reason ?? "no backup has been tried"}` : a.reason,
      `Open the Backups page and press "Back up now": ${this.o.pageUrl}`,
    ]);
  }

  /** Sends an alert unless the same problem was already reported in the last day. */
  private async alert(problem: BackupProblem, subject: string, paragraphs: string[]): Promise<void> {
    const now = this.o.now();
    const last = this.state.alerts[problem];
    if (last && now.getTime() - Date.parse(last) < ALERT_GAP_MS) return;
    this.saveState({ ...this.state, alerts: { ...this.state.alerts, [problem]: now.toISOString() } });
    try {
      await this.o.alert({ problem, subject, text: paragraphs.join("\n\n") });
    } catch (e) {
      console.error("backup alert failed:", e instanceof Error ? e.name : "error");
    }
  }
}

/** The time of night the page tells the owner about. */
export const NIGHTLY_TIME = `${String(NIGHTLY_AT.hour).padStart(2, "0")}:${String(NIGHTLY_AT.minute).padStart(2, "0")}`;
