import { BackupError, type BackupKind, type StorageSettings } from "./types.js";

/** Checking what the owner typed about their storage, and the names backups are stored under. */

export const DEFAULT_KEEP = 30;
export const MIN_KEEP = 7;
export const MAX_KEEP = 365;
/** Backups made with "Back up now" are kept apart from the nightly ones, so pressing the button never pushes a night out. */
export const MANUAL_KEEP = 5;

const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,39}$/;
const VISIBLE = /^[\x21-\x7e]+$/;

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max + 1) : "");

/** The storage service's host name from whatever was pasted: https only, a real name, no port, sign-in or path kept. */
export function storageHost(raw: unknown): string {
  const typed = text(raw, 300);
  if (!typed) throw new BackupError("Type the address of your storage. It starts with https://");
  if (/^http:\/\//i.test(typed)) throw new BackupError("The storage address must start with https:// so the backup travels privately.");
  let url: URL;
  try { url = new URL(/^https:\/\//i.test(typed) ? typed : `https://${typed}`); } catch { throw new BackupError("That storage address does not look right. Copy it again from your storage provider."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !HOST.test(host) || /\.(local|internal|localhost|lan|home|corp)$/.test(host)) {
    throw new BackupError("That storage address does not look right. It should look like https://something.r2.cloudflarestorage.com");
  }
  return host;
}

/** The region to sign with when the owner left it empty: read from the address where the provider puts it there. */
export function regionFor(host: string): string {
  const named = /^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(host) ?? /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(host) ?? /^([a-z0-9-]+)\.your-objectstorage\.com$/.exec(host) ?? /^s3\.([a-z0-9-]+)\.wasabisys\.com$/.exec(host);
  if (named) return named[1]!;
  return host.endsWith(".r2.cloudflarestorage.com") ? "auto" : "us-east-1";
}

/**
 * Turns the set-up form into settings, or says in plain words what is wrong. An empty secret keeps the saved one,
 * but only while the address, bucket and key id are unchanged: a saved secret is never sent to a new address.
 */
export function readStorageForm(raw: unknown, saved: StorageSettings | undefined, nowIso: string): StorageSettings {
  const f = (raw ?? {}) as Record<string, unknown>;
  const host = storageHost(f.address);
  const bucket = text(f.bucket, 63).toLowerCase();
  if (!BUCKET.test(bucket)) throw new BackupError("Type the bucket name exactly as your storage provider shows it: small letters, numbers and dashes.");
  const keyId = text(f.keyId, 200);
  if (!keyId || keyId.length > 200 || !VISIBLE.test(keyId)) throw new BackupError("Paste the key id your storage provider gave you.");
  const sameKey = saved && saved.host === host && saved.bucket === bucket && saved.keyId === keyId;
  const typedSecret = text(f.secret, 500);
  const secret = typedSecret || (sameKey ? saved.secret : "");
  if (!secret || secret.length > 500 || !VISIBLE.test(secret)) throw new BackupError("Paste the secret your storage provider gave you with the key id.");
  const typedRegion = text(f.region, 40).toLowerCase();
  if (typedRegion && !REGION.test(typedRegion)) throw new BackupError("That region does not look right. Leave it empty unless your storage provider gives you one.");
  const folder = text(f.folder, 100).replace(/^\/+|\/+$/g, "");
  if (folder && (folder.length > 100 || !FOLDER.test(folder) || folder.includes(".."))) throw new BackupError("The folder can use letters, numbers, dashes and single slashes, for example backups/maiz.");
  const keepRaw = f.keep === undefined || f.keep === null || f.keep === "" ? DEFAULT_KEEP : Number(f.keep);
  if (!Number.isInteger(keepRaw) || keepRaw < MIN_KEEP || keepRaw > MAX_KEEP) throw new BackupError(`Choose how many nightly backups to keep: a whole number from ${MIN_KEEP} to ${MAX_KEEP}.`);
  return { host, bucket, keyId, secret, region: typedRegion || regionFor(host), folder, keep: keepRaw, savedAt: nowIso };
}

// ---- names in the bucket ----
const NAME = /^maiz-(nightly|manual)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.backup$/;
export const NAME_PREFIX = "maiz-";
export const folderPrefix = (folder: string): string => (folder ? `${folder}/` : "");

export function backupName(kind: BackupKind, at: Date): string {
  return `maiz-${kind}-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}.backup`;
}

/** Reads one of our own names back. Anything else in the bucket (other people's files, deploy/backup.sh dumps) is not ours and is left alone. */
export function readBackupName(key: string, folder: string): { kind: BackupKind; at: string } | undefined {
  const prefix = folderPrefix(folder);
  if (!key.startsWith(prefix)) return undefined;
  const m = NAME.exec(key.slice(prefix.length));
  return m ? { kind: m[1] as BackupKind, at: `${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:${m[7]}.000Z` } : undefined;
}
