/** A problem the owner can read: every message is plain words, safe to show on the Backups page and in an alert. */
export class BackupError extends Error {
  /** A short technical line for whoever helps the owner (never a secret). */
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.detail = detail;
  }
}

/** Raised when another backup or restore test is still going. */
export class BackupBusy extends BackupError {}

export type BackupKind = "nightly" | "manual";
export type JobKind = "backup" | "restore_test";

/** Where backups are kept, as the owner typed it. The secret never leaves the server again. */
export interface StorageSettings {
  /** Host name of the storage service, always reached over https. */
  host: string;
  bucket: string;
  keyId: string;
  secret: string;
  region: string;
  /** Folder inside the bucket, without slashes at either end. Empty for the top of the bucket. */
  folder: string;
  /** How many nightly backups to keep. */
  keep: number;
  savedAt: string;
}

export interface RecoveryKeyRecord {
  /** Eight characters that name the key without revealing it; written into every backup made with it. */
  id: string;
  /** The key itself, base64. */
  key: string;
  createdAt: string;
  /** When the owner said they had saved it somewhere else. */
  savedAt?: string;
}

export interface BackupRecord {
  at: string;
  bytes: number;
  name: string;
  kind: BackupKind;
  keyId: string;
  /** Something worth knowing about a backup that was made all the same (old ones could not be removed). */
  note?: string;
}

export interface FailureRecord {
  at: string;
  what: JobKind;
  /** Plain words. */
  reason: string;
  detail?: string;
}

/** Rows found in one copy of the database. */
export interface TableCounts {
  clients: number;
  records: number;
  migrations: number;
}

export interface RestoreTestRecord {
  at: string;
  ok: boolean;
  /** The backup that was tested. */
  backupName?: string;
  backupAt?: string;
  bytes?: number;
  clients?: number;
  records?: number;
  /** Plain words, when it did not pass. */
  problem?: string;
  detail?: string;
}

/** Everything remembered between restarts that is not a secret in itself (it is stored encrypted all the same). */
export interface BackupState {
  lastBackup?: BackupRecord;
  lastFailure?: FailureRecord;
  lastRestoreTest?: RestoreTestRecord;
  /** The owner's local date of the last nightly run, and how many tries it has had. */
  nightly?: { date: string; attempts: number; lastAttemptAt: string; done: boolean };
  /** When a restore test was last started automatically. */
  autoRestoreAt?: string;
  /** When each kind of alert was last sent, so the same problem is not reported twice in a day. */
  alerts: Record<string, string>;
}

/** What the Backups page is told. Nothing here is secret. */
export interface BackupView {
  available: boolean;
  /** Plain words when backups cannot run on this server. */
  unavailable?: string;
  configured: boolean;
  storage?: { address: string; bucket: string; region: string; folder: string; keyId: string; keep: number; savedAt: string };
  recoveryKey?: { id: string; createdAt: string; saved: boolean; olderKeys: number };
  running: JobKind | null;
  lastBackup?: BackupRecord;
  lastFailure?: FailureRecord;
  lastRestoreTest?: RestoreTestRecord;
  nextBackupAt?: string;
  /** False when backups are set up and the newest one is too old. */
  fresh: boolean;
  timezone: string;
}
