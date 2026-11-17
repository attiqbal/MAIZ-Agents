import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BackupError, type BackupKind } from "./types.js";

/**
 * The backup file and the recovery key that opens it.
 *
 * File layout (version 1):
 *   "MAIZBKP1"                      8 bytes
 *   header length                   4 bytes, big-endian
 *   header                          JSON: when it was made, which key, the salt and nonce
 *   the database dump               AES-256-GCM; the key is HKDF-SHA256(recovery key, salt)
 *   authentication tag              16 bytes
 * The first three parts are authenticated too, so nothing in the file can be changed without the opener noticing.
 * `scripts/open-backup.ts` opens a file with nothing but this module and the recovery key.
 */
const MAGIC = Buffer.from("MAIZBKP1");
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 16_384;
export const KEY_BYTES = 32;
const DATA_INFO = "maiz-backup/data/v1";
const KEYS_INFO = "maiz-backup/server-keys/v1";

export interface BackupHeader {
  v: 1;
  app: "maiz-agents";
  format: "pg_dump-custom";
  madeAt: string;
  kind: BackupKind;
  keyId: string;
  salt: string;
  iv: string;
  /** The server's own keys (TOKEN_KEY), sealed with the recovery key. */
  keys?: string;
}
export interface OpenedBackup extends BackupHeader { serverKeys?: Record<string, string> }
export interface SealMeta { madeAt: string; kind: BackupKind; serverKeys?: Readonly<Record<string, string>> }
export interface Sealed { bytes: number; sha256: string; header: BackupHeader }

// ---- the recovery key as text: Crockford base32 (no I, L, O or U), 52 characters of key and 3 of check ----
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_CHARS = 52;
const CHECK_CHARS = 3;
const TEXT_CHARS = KEY_CHARS + CHECK_CHARS;

function toBase32(bytes: Uint8Array, chars: number): string {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  bits = bits.padEnd(chars * 5, "0");
  let out = "";
  for (let i = 0; i < chars; i++) out += ALPHABET[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  return out;
}
const checkOf = (bytes: Uint8Array): string => toBase32(createHash("sha256").update("maiz-backup/key-check").update(bytes).digest(), CHECK_CHARS);

/** Eight characters that name a key without revealing anything about it. */
export const keyIdOf = (bytes: Uint8Array): string => createHash("sha256").update("maiz-backup/key-id").update(bytes).digest("hex").slice(0, 8);

export function recoveryKeyText(bytes: Uint8Array): string {
  return `${toBase32(bytes, KEY_CHARS)}${checkOf(bytes)}`.match(/.{5}/g)!.join("-");
}

export function makeRecoveryKey(random: (n: number) => Buffer = randomBytes): { text: string; bytes: Buffer; id: string } {
  const bytes = random(KEY_BYTES);
  return { text: recoveryKeyText(bytes), bytes, id: keyIdOf(bytes) };
}

/** Reads a key however it was typed. A mistyped character is caught by the three check characters at the end. */
export function parseRecoveryKey(text: unknown): Buffer {
  const typed = typeof text === "string" ? text.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1") : "";
  if (typed.length !== TEXT_CHARS || [...typed].some((c) => !ALPHABET.includes(c))) {
    throw new BackupError(`That does not look like a recovery key. It is ${TEXT_CHARS} letters and numbers in groups of five.`);
  }
  let bits = "";
  for (const c of typed.slice(0, KEY_CHARS)) bits += ALPHABET.indexOf(c).toString(2).padStart(5, "0");
  const bytes = Buffer.alloc(KEY_BYTES);
  for (let i = 0; i < KEY_BYTES; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  if (checkOf(bytes) !== typed.slice(KEY_CHARS)) throw new BackupError("That recovery key has a mistyped letter or number. Check it against your saved copy.");
  return bytes;
}

// ---- sealing ----
const derive = (key: Uint8Array, salt: Uint8Array, info: string): Buffer => Buffer.from(hkdfSync("sha256", key, salt, info, KEY_BYTES));

function sealServerKeys(recoveryKey: Uint8Array, salt: Uint8Array, keys: Readonly<Record<string, string>>): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", derive(recoveryKey, salt, KEYS_INFO), iv);
  const body = Buffer.concat([c.update(JSON.stringify(keys), "utf8"), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]).toString("base64");
}

function openServerKeys(recoveryKey: Uint8Array, salt: Uint8Array, sealed: string): Record<string, string> {
  const raw = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", derive(recoveryKey, salt, KEYS_INFO), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - TAG_BYTES)), d.final()]).toString("utf8")) as Record<string, string>;
}

/** Counts and hashes what passes through, so the storage service can be told the size and SHA-256 of the file. */
function meter(): { stream: Transform; result: () => { bytes: number; sha256: string } } {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = new Transform({ transform(chunk: Buffer, _enc, done) { hash.update(chunk); bytes += chunk.length; done(null, chunk); } });
  return { stream, result: () => ({ bytes, sha256: hash.digest("hex") }) };
}

/**
 * Encrypts everything read from `source` into a new file at `destPath` (it must not exist yet; only this user can
 * read it). The plain data is never written anywhere.
 */
export async function sealTo(source: Readable, destPath: string, recoveryKey: Uint8Array, meta: SealMeta): Promise<Sealed> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header: BackupHeader = {
    v: 1, app: "maiz-agents", format: "pg_dump-custom", madeAt: meta.madeAt, kind: meta.kind, keyId: keyIdOf(recoveryKey),
    salt: salt.toString("base64"), iv: iv.toString("base64"),
    ...(meta.serverKeys && Object.keys(meta.serverKeys).length ? { keys: sealServerKeys(recoveryKey, salt, meta.serverKeys) } : {}),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  const prefix = Buffer.concat([MAGIC, length, headerBytes]);
  const cipher = createCipheriv("aes-256-gcm", derive(recoveryKey, salt, DATA_INFO), iv);
  cipher.setAAD(prefix);
  async function* parts(): AsyncGenerator<Buffer> {
    yield prefix;
    for await (const chunk of source) {
      const out = cipher.update(chunk as Buffer);
      if (out.length) yield out;
    }
    const last = cipher.final();
    if (last.length) yield last;
    yield cipher.getAuthTag();
  }
  const m = meter();
  await pipeline(Readable.from(parts()), m.stream, createWriteStream(destPath, { flags: "wx", mode: 0o600 }));
  return { ...m.result(), header };
}

/** Reads the unencrypted first part of a backup file: when it was made and which key it needs. */
export async function readHeader(path: string): Promise<{ header: BackupHeader; prefix: Buffer; dataOffset: number; size: number }> {
  const notOurs = () => new BackupError("This file is not a MAIZ Agents backup.");
  const { size } = await stat(path);
  const fd = await open(path, "r");
  try {
    const start = Buffer.alloc(MAGIC.length + 4);
    const first = await fd.read(start, 0, start.length, 0);
    if (first.bytesRead < start.length || !start.subarray(0, MAGIC.length).equals(MAGIC)) throw notOurs();
    const length = start.readUInt32BE(MAGIC.length);
    if (length < 2 || length > MAX_HEADER_BYTES || start.length + length + TAG_BYTES > size) throw new BackupError("The backup file is cut short or damaged.");
    const body = Buffer.alloc(length);
    await fd.read(body, 0, length, start.length);
    let header: BackupHeader;
    try { header = JSON.parse(body.toString("utf8")) as BackupHeader; } catch { throw new BackupError("The backup file is damaged."); }
    if (header?.v !== 1 || typeof header.keyId !== "string" || typeof header.salt !== "string" || typeof header.iv !== "string") throw new BackupError("The backup file is damaged, or was made by a newer version of MAIZ Agents.");
    return { header, prefix: Buffer.concat([start, body]), dataOffset: start.length + length, size };
  } finally {
    await fd.close();
  }
}

async function readTag(path: string, size: number): Promise<Buffer> {
  const fd = await open(path, "r");
  try {
    const tag = Buffer.alloc(TAG_BYTES);
    await fd.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    return tag;
  } finally {
    await fd.close();
  }
}

/**
 * Decrypts a backup file into a new file at `destPath`. `keys` are the recovery keys to try; the file says which one
 * it needs. If the file was changed or the key is wrong, nothing is left at `destPath`.
 */
export async function openSealed(srcPath: string, destPath: string, keys: readonly Uint8Array[]): Promise<OpenedBackup> {
  const { header, prefix, dataOffset, size } = await readHeader(srcPath);
  const wanted = Buffer.from(header.keyId);
  const key = keys.find((k) => { const id = Buffer.from(keyIdOf(k)); return id.length === wanted.length && timingSafeEqual(id, wanted); });
  if (!key) throw new BackupError("This backup was made with a different recovery key. It can only be opened with the key that was in use when it was made.");
  const salt = Buffer.from(header.salt, "base64");
  const damaged = () => new BackupError("The backup file is damaged or was changed after it was made.");
  const decipher = createDecipheriv("aes-256-gcm", derive(key, salt, DATA_INFO), Buffer.from(header.iv, "base64"));
  decipher.setAAD(prefix);
  decipher.setAuthTag(await readTag(srcPath, size));
  const end = size - TAG_BYTES - 1;
  try {
    const source = end >= dataOffset ? createReadStream(srcPath, { start: dataOffset, end }) : Readable.from([]);
    await pipeline(source, decipher, createWriteStream(destPath, { flags: "wx", mode: 0o600 }));
  } catch (e) {
    await rm(destPath, { force: true });
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") throw e;
    throw damaged();
  }
  try {
    return { ...header, ...(header.keys ? { serverKeys: openServerKeys(key, salt, header.keys) } : {}) };
  } catch {
    await rm(destPath, { force: true });
    throw damaged();
  }
}
