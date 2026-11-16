import { randomBytes } from "node:crypto";
import { openAsBlob } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { RESTORE_DB_PREFIX, type DbAdmin } from "./db.js";
import { connectionEnv, type ProgramRunner } from "./program.js";
import type { S3Client, S3Object } from "./s3.js";
import { openSealed, sealTo } from "./seal.js";
import { MANUAL_KEEP, NAME_PREFIX, backupName, folderPrefix, readBackupName } from "./settings.js";
import { BackupError, type BackupKind, type BackupRecord, type RestoreTestRecord } from "./types.js";

/**
 * The two jobs: make a backup, and prove a backup can be restored. Each works in a folder of its own under the
 * server's temporary directory and removes it whatever happens. The plain database dump is never written to disk
 * when a backup is made; a restore test has to write it once, for pg_restore, and deletes it straight after.
 */
export interface JobContext {
  s3: S3Client;
  run: ProgramRunner;
  db: DbAdmin;
  databaseUrl: string;
  tmpRoot: string;
  now: () => Date;
}

export const TMP_PREFIX = "maiz-backup-";
/** A live site made a few minutes before the backup may or may not be in it: only older clients are expected. */
const CLIENT_MARGIN_MS = 5 * 60_000;
const DUMP_MAGIC = "PGDMP";
const lastLine = (stderr: string): string | undefined => stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 200);

/** What a failed pg_dump or pg_restore means, in plain words. The program's own last line is kept as the technical detail. */
function programProblem(stderr: string, fallback: string): BackupError {
  const detail = lastLine(stderr);
  if (/server version mismatch|unsupported version/i.test(stderr)) return new BackupError("The backup program on this server is older than the database, so it cannot read it. Ask your developer to update the server.", detail);
  if (/password authentication failed|no password supplied/i.test(stderr)) return new BackupError("The database refused the backup program's password.", detail);
  if (/could not connect|connection to server|could not translate host name|timeout expired|Connection refused/i.test(stderr)) return new BackupError("The backup program could not reach the database.", detail);
  if (/No space left on device/i.test(stderr)) return new BackupError("The server ran out of disk space.", detail);
  if (/took too long/.test(stderr)) return new BackupError("The backup program took too long and was stopped.", detail);
  return new BackupError(fallback, detail);
}

/** A database step of the restore test: a failure becomes a plain sentence, with the database's own words as the detail. */
async function dbStep<T>(step: Promise<T>, message: string): Promise<T> {
  try { return await step; } catch (e) { throw new BackupError(message, e instanceof Error ? e.message.split("\n")[0]!.slice(0, 200) : undefined); }
}

/** Removes working folders a cut-off run left behind (the server was restarted in the middle of a backup). */
export async function sweepTemp(tmpRoot: string): Promise<number> {
  const names = (await readdir(tmpRoot).catch(() => [] as string[])).filter((n) => n.startsWith(TMP_PREFIX));
  for (const n of names) await rm(join(tmpRoot, n), { recursive: true, force: true });
  return names.length;
}

/** Our own backups in the bucket, newest first. */
export async function listBackups(s3: S3Client, folder: string): Promise<(S3Object & { kind: BackupKind; at: string })[]> {
  const all = await s3.list(`${folderPrefix(folder)}${NAME_PREFIX}`);
  return all.flatMap((o) => { const n = readBackupName(o.key, folder); return n ? [{ ...o, ...n }] : []; }).sort((a, b) => b.at.localeCompare(a.at));
}

/** Deletes nightly backups beyond `keep` and manual ones beyond MANUAL_KEEP. Never touches a file that is not ours. */
export async function prune(s3: S3Client, folder: string, keep: number): Promise<number> {
  const ours = await listBackups(s3, folder);
  const extra = [...ours.filter((o) => o.kind === "nightly").slice(keep), ...ours.filter((o) => o.kind === "manual").slice(MANUAL_KEEP)];
  for (const o of extra) await s3.remove(o.key);
  return extra.length;
}

/** Counts the dump as it streams past and remembers how it starts, so an empty or wrong output is caught. */
function probe(): { stream: Transform; seen: () => { bytes: number; start: string } } {
  let bytes = 0;
  let start = Buffer.alloc(0);
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      if (start.length < DUMP_MAGIC.length) start = Buffer.concat([start, chunk]).subarray(0, DUMP_MAGIC.length);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  return { stream, seen: () => ({ bytes, start: start.toString("latin1") }) };
}

export interface BackupJob {
  kind: BackupKind;
  key: Uint8Array;
  folder: string;
  keep: number;
  serverKeys?: Readonly<Record<string, string>>;
  /** Writes anything still waiting in memory to the database first. */
  flush?: () => Promise<void>;
}

/** pg_dump straight into the cipher, the sealed file to storage, then old backups are thinned out. */
export async function makeBackup(ctx: JobContext, job: BackupJob): Promise<BackupRecord & { pruneProblem?: string }> {
  const dir = await mkdtemp(join(ctx.tmpRoot, TMP_PREFIX));
  try {
    await job.flush?.();
    const madeAt = ctx.now();
    const name = backupName(job.kind, madeAt);
    const file = join(dir, name);
    const p = probe();
    const sealing = sealTo(p.stream, file, job.key, { madeAt: madeAt.toISOString(), kind: job.kind, serverKeys: job.serverKeys });
    sealing.catch(() => undefined);
    let result;
    try {
      result = await ctx.run("pg_dump", ["--format=custom", "--no-password"], { env: connectionEnv(ctx.databaseUrl), stdout: p.stream });
    } catch (e) {
      p.stream.destroy(e instanceof Error ? e : new Error("pg_dump failed"));
      await sealing.catch(() => undefined);
      throw e;
    }
    const sealed = await sealing;
    if (result.code !== 0) throw programProblem(result.stderr, "The backup program stopped before it finished.");
    const seen = p.seen();
    if (seen.bytes === 0 || seen.start !== DUMP_MAGIC) throw new BackupError("The database gave back an empty backup, so nothing was saved.", `pg_dump wrote ${seen.bytes} bytes`);
    await ctx.s3.put(`${folderPrefix(job.folder)}${name}`, await openAsBlob(file), sealed.sha256);
    const record: BackupRecord = { at: madeAt.toISOString(), bytes: sealed.bytes, name, kind: job.kind, keyId: sealed.header.keyId };
    // The new backup is safe by now. Failing to tidy old ones is worth knowing about, but it is not a failed backup.
    try { await prune(ctx.s3, job.folder, job.keep); } catch (e) { return { ...record, pruneProblem: e instanceof BackupError ? e.message : "Old backups could not be removed." }; }
    return record;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Downloads the newest backup, opens it, loads it into a throwaway database on the same server, counts what is in
 * it and drops the throwaway database again. The live database is only ever read (one count).
 */
export async function testRestore(ctx: JobContext, keys: readonly Uint8Array[], folder: string): Promise<RestoreTestRecord> {
  const at = ctx.now().toISOString();
  const dir = await mkdtemp(join(ctx.tmpRoot, TMP_PREFIX));
  const database = `${RESTORE_DB_PREFIX}${randomBytes(6).toString("hex")}`;
  let created = false;
  let tested: Pick<RestoreTestRecord, "backupName" | "backupAt" | "bytes"> = {};
  try {
    for (const old of await dbStep(ctx.db.listDatabases(RESTORE_DB_PREFIX), "The database could not be reached for the test.")) await dbStep(ctx.db.dropDatabase(old), "An old test copy of the database could not be removed.");
    const newest = (await listBackups(ctx.s3, folder))[0];
    if (!newest) throw new BackupError("There is no backup in your storage yet. Press Back up now first.");
    tested = { backupName: newest.key.slice(folderPrefix(folder).length), backupAt: newest.at };
    const sealedFile = join(dir, "sealed");
    const dump = join(dir, "dump");
    tested = { ...tested, bytes: await ctx.s3.download(newest.key, sealedFile) };
    const header = await openSealed(sealedFile, dump, keys);
    tested = { ...tested, backupAt: header.madeAt };
    await rm(sealedFile, { force: true });
    await dbStep(ctx.db.createDatabase(database), "The database did not allow a test copy to be made.");
    created = true;
    const r = await ctx.run("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "--no-password", "--dbname", database, dump], { env: connectionEnv(ctx.databaseUrl, database) });
    if (r.code !== 0) throw programProblem(r.stderr, "The backup opened, but it could not be loaded into a test database.");
    const counts = await dbStep(ctx.db.counts(database), "The backup was loaded into a test database, but what is in it could not be counted.");
    const expected = await dbStep(ctx.db.clientsBefore(new Date(Date.parse(header.madeAt) - CLIENT_MARGIN_MS).toISOString()), "The live database could not be reached to compare it with the backup.");
    if (counts.migrations < 1) throw new BackupError("The backup opened, but the database inside it is empty.");
    if (counts.clients < expected) throw new BackupError(`The backup has ${counts.clients} client${counts.clients === 1 ? "" : "s"} in it, but the site had ${expected} when it was made.`);
    return { at, ok: true, ...tested, clients: counts.clients, records: counts.records };
  } catch (e) {
    if (e instanceof BackupError) return { at, ok: false, ...tested, problem: e.message, ...(e.detail ? { detail: e.detail } : {}) };
    throw e;
  } finally {
    // The plain dump goes first, then the throwaway database. Both always, whatever happened above.
    await rm(dir, { recursive: true, force: true });
    if (created) await dbStep(ctx.db.dropDatabase(database), "The test copy of the database could not be removed afterwards. It will be removed before the next test.");
  }
}
