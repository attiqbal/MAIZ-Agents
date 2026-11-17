import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Sink } from "../src/core/persistence.js";
import { PermissionError } from "../src/modules/identity/index.js";
import { setHostResolver } from "../src/modules/integrations/connectors/util.js";
import { BACKUP_SECRET_PREFIX, BackupBusy, BackupError, BackupService, type BackupAlert, type BackupOptions } from "../src/modules/backup/index.js";
import { openSealed, parseRecoveryKey } from "../src/modules/backup/seal.js";
import { FAKE_DUMP, STORAGE, STORAGE_FORM, fakeDb, fakePrograms, fakeStorage } from "./backup-fakes.js";

const OWNER = "user-owner";
const DB_URL = "postgres://postgres:db-pass-word@db:5432/postgres";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "maiz-backup-test-")); setHostResolver(async () => ["104.18.2.3"]); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function setup(over: Partial<BackupOptions> = {}, startAt = "2026-11-16T12:00:00Z") {
  const clock = { t: Date.parse(startAt) };
  const storage = fakeStorage();
  storage.state.clock = () => new Date(clock.t);
  const programs = fakePrograms();
  const database = fakeDb();
  const alerts: BackupAlert[] = [];
  const secrets = new Map<string, string>();
  const sink = { connectionSecret: (k: string, v: string) => { if (v) secrets.set(k, v); else secrets.delete(k); } } as unknown as Sink;
  let flushed = 0;
  const options: BackupOptions = {
    isOwner: (u) => u === OWNER, now: () => new Date(clock.t), http: storage.http, run: programs.run, db: database.db, databaseUrl: DB_URL, tmpDir: tmp,
    timezone: "Europe/London", pageUrl: "https://maiz.test/owner-backups.html", alert: async (a) => { alerts.push(a); },
    serverKeys: () => ({ TOKEN_KEY: "ab".repeat(32) }), flush: async () => { flushed++; }, ...over,
  };
  const make = () => { const s = new BackupService(options); for (const [k, v] of secrets) s.restoreSecret(k, v); s.useSink(sink); return s; };
  const service = make();
  const advance = (ms: number) => { clock.t += ms; };
  const at = (iso: string) => { clock.t = Date.parse(iso); };
  /** Storage saved and a recovery key made: everything a backup needs. */
  const ready = async (s = service) => { await s.saveStorage(OWNER, STORAGE_FORM); return s.makeRecoveryKey(OWNER).recoveryKey; };
  const run = async (what: "backup" | "restore_test", s = service) => { await (await s.begin(OWNER, what)).done; };
  return { service, make, storage, programs, database, alerts, secrets, clock, advance, at, ready, run, flushed: () => flushed };
}
const workFolders = () => readdirSync(tmp);

describe("backups: is it available on this server", () => {
  it("says there is no database when the server keeps data in memory only", async () => {
    const { service } = setup({ databaseUrl: undefined, db: undefined });
    const v = await service.view(OWNER);
    expect(v.available).toBe(false);
    expect(v.unavailable).toMatch(/no database/i);
    await expect(service.begin(OWNER, "backup")).rejects.toThrow(BackupError);
    expect(service.health()).toEqual({ ok: true });
  });

  it("says backups are not available when pg_dump is not installed, and never tries to run one", async () => {
    const { service, programs, storage, ready } = setup();
    programs.plan.missing = true;
    const v = await service.view(OWNER);
    expect(v.available).toBe(false);
    expect(v.unavailable).toMatch(/not available on this server/i);
    await ready();
    await expect(service.begin(OWNER, "backup")).rejects.toThrow(/not available on this server/i);
    await service.tick();
    expect(storage.keys()).toEqual([]);
    expect(programs.runs.every((r) => r.args.includes("--version"))).toBe(true);
  });

  it("is available when both programs answer", async () => {
    const { service, programs } = setup();
    expect((await service.view(OWNER)).available).toBe(true);
    expect(programs.runs.map((r) => r.program).sort()).toEqual(["pg_dump", "pg_restore"]);
  });

  it("is for the platform owner only", async () => {
    const { service } = setup();
    await expect(service.view("someone-else")).rejects.toThrow(PermissionError);
    await expect(service.saveStorage("someone-else", STORAGE_FORM)).rejects.toThrow(PermissionError);
    expect(() => service.makeRecoveryKey("someone-else")).toThrow(PermissionError);
    expect(() => service.confirmKeySaved("someone-else")).toThrow(PermissionError);
    expect(() => service.removeStorage("someone-else")).toThrow(PermissionError);
    await expect(service.begin("someone-else", "backup")).rejects.toThrow(PermissionError);
  });
});

describe("backups: storage details typed in the browser", () => {
  it("saves working details encrypted, and never shows the secret again", async () => {
    const { service, secrets, storage } = setup();
    await service.saveStorage(OWNER, { ...STORAGE_FORM, folder: "/maiz/live/", keep: 14 });
    const v = await service.view(OWNER);
    expect(v.storage).toEqual({ address: `https://${STORAGE.host}`, bucket: STORAGE.bucket, region: "auto", folder: "maiz/live", keyId: STORAGE.keyId, keep: 14, savedAt: "2026-11-16T12:00:00.000Z" });
    expect(JSON.stringify(v)).not.toContain(STORAGE.secret);
    expect(JSON.parse(secrets.get(`${BACKUP_SECRET_PREFIX}storage`)!)).toMatchObject({ host: STORAGE.host, secret: STORAGE.secret });
    // The check wrote a small file, listed the folder and removed the file again.
    expect(storage.calls.map((c) => c.method)).toEqual(["PUT", "GET", "DELETE"]);
    expect(storage.calls[0]!.url).toContain("/maiz-backups/maiz/live/maiz-connection-check-");
    expect(storage.keys()).toEqual([]);
    expect(v.configured).toBe(false); // no recovery key yet
  });

  it("refuses an address that is not https, is inside a network, or carries a sign-in", async () => {
    const { service, storage } = setup();
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, address: "http://abc.r2.cloudflarestorage.com" })).rejects.toThrow(/https/);
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, address: "https://10.0.0.5" })).rejects.toThrow(BackupError);
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, address: "https://user:pw@abc.r2.cloudflarestorage.com" })).rejects.toThrow(BackupError);
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, address: "https://abc.r2.cloudflarestorage.com:8443" })).rejects.toThrow(BackupError);
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, address: "https://storage.internal" })).rejects.toThrow(BackupError);
    setHostResolver(async () => ["192.168.1.20"]);
    await expect(service.saveStorage(OWNER, STORAGE_FORM)).rejects.toThrow(/could not be reached/);
    expect(storage.calls).toEqual([]);
    expect((await service.view(OWNER)).storage).toBeUndefined();
  });

  it("accepts an address pasted with the bucket on the end, and works out the region from the address", async () => {
    const { service } = setup();
    await service.saveStorage(OWNER, { ...STORAGE_FORM, address: `${STORAGE.host}/maiz-backups` });
    expect((await service.view(OWNER)).storage).toMatchObject({ address: `https://${STORAGE.host}`, region: "auto" });
  });

  it("explains each field that is wrong", async () => {
    const { service } = setup();
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, bucket: "My Bucket" })).rejects.toThrow(/bucket name/);
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, keyId: "" })).rejects.toThrow(/key id/);
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, secret: "" })).rejects.toThrow(/secret/);
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, folder: "../up" })).rejects.toThrow(/folder/);
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, keep: 2 })).rejects.toThrow(/from 7 to 365/);
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, region: "EU WEST!" })).rejects.toThrow(/region/);
    await expect(service.saveStorage(OWNER, null)).rejects.toThrow(BackupError);
  });

  it("does not save details the storage refuses, and says why in plain words", async () => {
    const { service } = setup();
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, secret: "wrong-secret" })).rejects.toThrow(/refused the key/);
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, bucket: "another-bucket" })).rejects.toThrow(/no bucket with that name/);
    expect((await service.view(OWNER)).storage).toBeUndefined();
  });

  it("says so when the key may write but not delete (old backups could never be removed)", async () => {
    const { service, storage } = setup();
    storage.state.deniedDelete = true;
    await expect(service.saveStorage(OWNER, STORAGE_FORM)).rejects.toThrow(/refused the key/);
  });

  it("keeps the saved secret when the form leaves it empty, but only for the same address, bucket and key id", async () => {
    const { service } = setup();
    await service.saveStorage(OWNER, STORAGE_FORM);
    await service.saveStorage(OWNER, { ...STORAGE_FORM, secret: "", keep: 60 });
    expect((await service.view(OWNER)).storage?.keep).toBe(60);
    await expect(service.saveStorage(OWNER, { ...STORAGE_FORM, secret: "", address: "https://s3.eu-central-003.backblazeb2.com" })).rejects.toThrow(/secret/);
  });

  it("removes the details when the owner turns backups off, and keeps the recovery key", async () => {
    const { service, secrets, ready } = setup();
    await ready();
    service.removeStorage(OWNER);
    const v = await service.view(OWNER);
    expect(v.storage).toBeUndefined();
    expect(v.configured).toBe(false);
    expect(v.recoveryKey).toBeDefined();
    expect(secrets.has(`${BACKUP_SECRET_PREFIX}storage`)).toBe(false);
    expect(service.health()).toEqual({ ok: true });
  });
});

describe("backups: the recovery key", () => {
  it("is made by the server, shown once, kept encrypted on the server, and never in the page data", async () => {
    const { service, secrets } = setup();
    const { recoveryKey } = service.makeRecoveryKey(OWNER);
    expect(recoveryKey).toMatch(/^([0-9A-Z]{5}-){10}[0-9A-Z]{5}$/);
    const v = await service.view(OWNER);
    expect(v.recoveryKey).toEqual({ id: expect.stringMatching(/^[0-9a-f]{8}$/), createdAt: "2026-11-16T12:00:00.000Z", saved: false, olderKeys: 0 });
    expect(JSON.stringify(v)).not.toContain(recoveryKey);
    const stored = JSON.parse(secrets.get(`${BACKUP_SECRET_PREFIX}keys`)!);
    expect(Buffer.from(stored.current.key, "base64").equals(parseRecoveryKey(recoveryKey))).toBe(true);
  });

  it("is not replaced by accident: a second one has to be asked for on purpose", async () => {
    const { service } = setup();
    const first = service.makeRecoveryKey(OWNER).recoveryKey;
    expect(() => service.makeRecoveryKey(OWNER)).toThrow(/already/);
    const second = service.makeRecoveryKey(OWNER, { replace: true }).recoveryKey;
    expect(second).not.toBe(first);
    expect((await service.view(OWNER)).recoveryKey).toMatchObject({ saved: false, olderKeys: 1 });
  });

  it("remembers that the owner said they saved it", async () => {
    const { service } = setup();
    expect(() => service.confirmKeySaved(OWNER)).toThrow(BackupError);
    service.makeRecoveryKey(OWNER);
    service.confirmKeySaved(OWNER);
    expect((await service.view(OWNER)).recoveryKey?.saved).toBe(true);
  });
});

describe("backups: making one", () => {
  it("dumps the database, encrypts it and puts one file in the bucket that only the recovery key opens", async () => {
    const { service, storage, programs, ready, run, flushed } = setup();
    const recoveryKey = await ready();
    await run("backup");
    expect(storage.keys()).toEqual(["maiz-manual-20261116T120000Z.backup"]);
    const sealed = storage.objects.get("maiz-manual-20261116T120000Z.backup")!.body;
    expect(sealed.includes(FAKE_DUMP.subarray(0, 40))).toBe(false);
    writeFileSync(join(tmp, "got"), sealed);
    const header = await openSealed(join(tmp, "got"), join(tmp, "plain"), [parseRecoveryKey(recoveryKey)]);
    rmSync(join(tmp, "got"));
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(tmp, "plain")).equals(FAKE_DUMP)).toBe(true);
    rmSync(join(tmp, "plain"));
    expect(header).toMatchObject({ kind: "manual", madeAt: "2026-11-16T12:00:00.000Z", serverKeys: { TOKEN_KEY: "ab".repeat(32) } });
    const v = await service.view(OWNER);
    expect(v.lastBackup).toEqual({ at: "2026-11-16T12:00:00.000Z", bytes: sealed.length, name: "maiz-manual-20261116T120000Z.backup", kind: "manual", keyId: v.recoveryKey!.id });
    expect(v.running).toBeNull();
    expect(v.fresh).toBe(true);
    expect(flushed()).toBe(1);
    // The password travels in the program's environment, never on its command line.
    const dump = programs.runs.find((r) => r.program === "pg_dump" && !r.args.includes("--version"))!;
    expect(dump.args).toEqual(["--format=custom", "--no-password"]);
    expect(dump.env).toMatchObject({ PGHOST: "db", PGPORT: "5432", PGUSER: "postgres", PGPASSWORD: "db-pass-word", PGDATABASE: "postgres" });
    // The upload said how big the file is and what its SHA-256 is.
    const put = storage.calls.filter((c) => c.method === "PUT").pop()!;
    expect(put.bytes).toBe(sealed.length);
    expect(workFolders()).toEqual([]);
  });

  it("puts backups in the folder the owner chose", async () => {
    const { service, storage, run } = setup();
    await service.saveStorage(OWNER, { ...STORAGE_FORM, folder: "maiz/live" });
    service.makeRecoveryKey(OWNER);
    await run("backup");
    expect(storage.keys()).toEqual(["maiz/live/maiz-manual-20261116T120000Z.backup"]);
  });

  it("needs storage details and a recovery key first", async () => {
    const { service } = setup();
    await expect(service.begin(OWNER, "backup")).rejects.toThrow(/storage/i);
    await service.saveStorage(OWNER, STORAGE_FORM);
    await expect(service.begin(OWNER, "backup")).rejects.toThrow(/recovery key/i);
  });

  it("does one thing at a time", async () => {
    const { service, programs, ready } = setup();
    await ready();
    let release!: () => void;
    programs.plan.hold = new Promise<void>((r) => { release = r; });
    const first = await service.begin(OWNER, "backup");
    expect((await service.view(OWNER)).running).toBe("backup");
    await expect(service.begin(OWNER, "backup")).rejects.toThrow(BackupBusy);
    await expect(service.begin(OWNER, "restore_test")).rejects.toThrow(BackupBusy);
    release();
    await first.done;
    expect((await service.view(OWNER)).running).toBeNull();
  });

  it("records a failed dump in plain words, uploads nothing and leaves no files behind", async () => {
    const { service, storage, programs, ready, run } = setup();
    await ready();
    programs.plan.dumpFails = { code: 1, stderr: "pg_dump: error: server version: 16.4; pg_dump version: 15.8\npg_dump: error: aborting because of server version mismatch\n" };
    await run("backup");
    const v = await service.view(OWNER);
    expect(v.lastBackup).toBeUndefined();
    expect(v.lastFailure).toMatchObject({ what: "backup", at: "2026-11-16T12:00:00.000Z", detail: "pg_dump: error: aborting because of server version mismatch" });
    expect(v.lastFailure!.reason).toMatch(/older than the database/);
    expect(storage.keys()).toEqual([]);
    expect(workFolders()).toEqual([]);
  });

  it("treats an empty dump as a failure", async () => {
    const { service, storage, programs, ready, run } = setup();
    await ready();
    programs.plan.dump = Buffer.alloc(0);
    await run("backup");
    expect((await service.view(OWNER)).lastFailure?.reason).toMatch(/empty backup/);
    expect(storage.keys()).toEqual([]);
  });

  it("records a refused upload, and cleans up", async () => {
    const { service, storage, ready, run } = setup();
    await ready();
    storage.state.fail = (c) => (c.method === "PUT" ? { status: 403, code: "AccessDenied" } : undefined);
    await run("backup");
    const v = await service.view(OWNER);
    expect(v.lastFailure?.reason).toMatch(/refused the key/);
    expect(v.lastFailure?.detail).toBe("storage answered 403 AccessDenied");
    expect(workFolders()).toEqual([]);
  });

  it("records storage that cannot be reached", async () => {
    const { service, storage, ready, run } = setup();
    await ready();
    storage.state.fail = () => "network";
    await run("backup");
    expect((await service.view(OWNER)).lastFailure?.reason).toMatch(/could not be reached/);
  });

  it("checks the storage address again before every run", async () => {
    const { service, storage, ready, run } = setup();
    await ready();
    const before = storage.calls.length;
    setHostResolver(async () => ["127.0.0.1"]);
    await run("backup");
    expect((await service.view(OWNER)).lastFailure?.reason).toMatch(/could not be reached/);
    expect(storage.calls.length).toBe(before);
  });

  it("never lets a secret into the recorded reason", async () => {
    const { service, programs, ready, run } = setup();
    await ready();
    programs.plan.dumpFails = { code: 1, stderr: `pg_dump: error: connection to server failed for postgres://postgres:db-pass-word@db with ${STORAGE.secret}\n` };
    await run("backup");
    const text = JSON.stringify((await service.view(OWNER)).lastFailure);
    expect(text).not.toContain("db-pass-word");
    expect(text).not.toContain(STORAGE.secret);
  });

  it("keeps the newest 30 nightly backups and 5 made by hand, and never touches other files", async () => {
    const { service, storage, ready, run, at } = setup({}, "2026-10-01T12:00:00Z");
    await ready();
    const day = (n: number) => String(n).padStart(2, "0");
    for (let d = 1; d <= 31; d++) storage.objects.set(`maiz-nightly-202609${day(Math.min(d, 30))}T0${d === 31 ? 4 : 3}1000Z.backup`, { body: Buffer.from("old"), lastModified: "" });
    for (let d = 1; d <= 5; d++) storage.objects.set(`maiz-manual-202609${day(d)}T120000Z.backup`, { body: Buffer.from("old"), lastModified: "" });
    for (const other of ["maiz-20260901T000000Z.dump.enc", "holiday-photos.zip", "maiz-nightly-notes.txt", "elsewhere/maiz-nightly-20260101T031000Z.backup"]) storage.objects.set(other, { body: Buffer.from("x"), lastModified: "" });
    await run("backup");
    const keys = storage.keys();
    expect(keys.filter((k) => /^maiz-nightly-.*\.backup$/.test(k))).toHaveLength(30);
    expect(keys).not.toContain("maiz-nightly-20260901T031000Z.backup");
    expect(keys.filter((k) => k.startsWith("maiz-manual-"))).toHaveLength(5);
    expect(keys).toContain("maiz-manual-20261001T120000Z.backup");
    expect(keys).not.toContain("maiz-manual-20260901T120000Z.backup");
    for (const other of ["maiz-20260901T000000Z.dump.enc", "holiday-photos.zip", "maiz-nightly-notes.txt", "elsewhere/maiz-nightly-20260101T031000Z.backup"]) expect(keys).toContain(other);
    at("2026-10-02T12:00:00Z");
    expect((await service.view(OWNER)).lastFailure).toBeUndefined();
  });

  it("still counts the backup as made when old ones cannot be removed", async () => {
    const { service, storage, ready, run } = setup();
    await ready();
    for (let d = 10; d <= 45; d++) storage.objects.set(`maiz-nightly-2026${d > 30 ? "10" : "09"}${String(d > 30 ? d - 30 : d).padStart(2, "0")}T031000Z.backup`, { body: Buffer.from("old"), lastModified: "" });
    storage.state.deniedDelete = true;
    await run("backup");
    const v = await service.view(OWNER);
    expect(v.lastBackup?.name).toBe("maiz-manual-20261116T120000Z.backup");
    expect(v.lastFailure).toBeUndefined();
  });
});

describe("backups: the restore test", () => {
  it("opens the newest backup in a throwaway database, counts what is in it and drops the database", async () => {
    const { service, programs, database, ready, run, advance } = setup();
    await ready();
    await run("backup");
    advance(2 * HOUR);
    await run("restore_test");
    expect(programs.restored).toHaveLength(1);
    expect(programs.restored[0]!.dump.equals(FAKE_DUMP)).toBe(true);
    const name = programs.restored[0]!.database;
    expect(name).toMatch(/^maiz_restore_test_[0-9a-f]{12}$/);
    expect(database.log).toEqual([`create ${name}`, `drop ${name}`]);
    expect(database.databases.size).toBe(0);
    const restore = programs.runs.find((r) => r.program === "pg_restore" && !r.args.includes("--version"))!;
    expect(restore.args.slice(0, 6)).toEqual(["--no-owner", "--no-acl", "--exit-on-error", "--no-password", "--dbname", name]);
    expect(restore.env).toMatchObject({ PGDATABASE: name, PGPASSWORD: "db-pass-word" });
    const v = await service.view(OWNER);
    expect(v.lastRestoreTest).toEqual({ at: "2026-11-16T14:00:00.000Z", ok: true, backupName: "maiz-manual-20261116T120000Z.backup", backupAt: "2026-11-16T12:00:00.000Z", bytes: v.lastBackup!.bytes, clients: 3, records: 240 });
    expect(workFolders()).toEqual([]);
  });

  it("says so when there is nothing in storage to test", async () => {
    const { service, programs, ready, run } = setup();
    await ready();
    await run("restore_test");
    expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: false, problem: expect.stringMatching(/no backup in your storage yet/) });
    expect(programs.restored).toEqual([]);
  });

  it("fails, and still drops the throwaway database, when the backup cannot be loaded", async () => {
    const { service, programs, database, ready, run } = setup();
    await ready();
    await run("backup");
    programs.plan.restoreFails = { code: 1, stderr: "pg_restore: error: could not execute query: ERROR: relation already exists\n" };
    await run("restore_test");
    const v = await service.view(OWNER);
    expect(v.lastRestoreTest).toMatchObject({ ok: false, backupAt: "2026-11-16T12:00:00.000Z" });
    expect(v.lastRestoreTest!.problem).toMatch(/could not be loaded/);
    expect(database.databases.size).toBe(0);
    expect(database.log.filter((l) => l.startsWith("drop"))).toHaveLength(1);
    expect(workFolders()).toEqual([]);
    expect(v.lastFailure).toMatchObject({ what: "restore_test" });
  });

  it("fails when the backup holds fewer clients than the site had when it was made", async () => {
    const { service, database, ready, run } = setup();
    await ready();
    await run("backup");
    database.state.restored = { clients: 0, records: 12, migrations: 4 };
    await run("restore_test");
    expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: false, problem: "The backup has 0 clients in it, but the site had 3 when it was made." });
    expect(database.databases.size).toBe(0);
  });

  it("passes for a brand-new site with no clients yet, and compares with the site as it was when the backup was made", async () => {
    const { service, database, ready, run } = setup();
    await ready();
    await run("backup");
    database.state.restored = { clients: 0, records: 3, migrations: 4 };
    const asked: string[] = [];
    database.state.liveAsOf = (iso) => { asked.push(iso); return 0; };
    await run("restore_test");
    expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: true, clients: 0 });
    expect(asked).toEqual(["2026-11-16T11:55:00.000Z"]);
  });

  it("fails when the database inside the backup is empty", async () => {
    const { service, database, ready, run } = setup();
    await ready();
    await run("backup");
    database.state.restored = { clients: 0, records: 0, migrations: 0 };
    database.state.liveAsOf = () => 0;
    await run("restore_test");
    expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: false, problem: expect.stringMatching(/empty/) });
  });

  it("fails in plain words when the database will not make a test copy, or the copy cannot be counted", async () => {
    const { service, database, ready, run } = setup();
    await ready();
    await run("backup");
    database.state.createFails = new Error("permission denied to create database");
    await run("restore_test");
    expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: false, problem: expect.stringMatching(/did not allow a test copy/), detail: "permission denied to create database" });
    database.state.createFails = undefined;
    database.state.restored = new Error("relation \"workspaces\" does not exist");
    await run("restore_test");
    expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: false, problem: expect.stringMatching(/could not be counted/) });
    expect(database.databases.size).toBe(0);
  });

  it("notices a backup that was changed in storage", async () => {
    const { service, storage, programs, ready, run } = setup();
    await ready();
    await run("backup");
    const o = storage.objects.get("maiz-manual-20261116T120000Z.backup")!;
    o.body[o.body.length - 40] = o.body[o.body.length - 40]! ^ 1;
    await run("restore_test");
    expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: false, problem: expect.stringMatching(/damaged or was changed/) });
    expect(programs.restored).toEqual([]);
    expect(workFolders()).toEqual([]);
  });

  it("still opens a backup made before the owner changed the recovery key", async () => {
    const { service, ready, run, advance } = setup();
    await ready();
    await run("backup");
    advance(HOUR);
    service.makeRecoveryKey(OWNER, { replace: true });
    await run("restore_test");
    expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: true });
  });

  it("removes a throwaway database that a cut-off test left behind", async () => {
    const { service, database, ready, run } = setup();
    await ready();
    await run("backup");
    database.databases.add("maiz_restore_test_0123456789ab");
    await run("restore_test");
    expect(database.databases.size).toBe(0);
    expect(database.log[0]).toBe("drop maiz_restore_test_0123456789ab");
  });

  it("tests the newest backup of either kind", async () => {
    const { service, storage, ready, run, advance } = setup();
    await ready();
    await run("backup");
    advance(DAY);
    await run("backup");
    storage.objects.set("maiz-20261230T000000Z.dump.enc", { body: Buffer.from("not ours"), lastModified: "" });
    await run("restore_test");
    expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: true, backupName: "maiz-manual-20261117T120000Z.backup" });
  });
});

describe("backups: the nightly run, the weekly test and alerts", () => {
  it("backs up once a night at ten past three in the owner's time zone", async () => {
    const { service, storage, ready, at } = setup({}, "2026-11-16T02:00:00Z");
    await ready();
    await service.tick();
    at("2026-11-16T03:09:00Z");
    await service.tick();
    expect(storage.keys()).toEqual([]);
    at("2026-11-16T03:10:00Z");
    await service.tick();
    expect(storage.keys()).toEqual(["maiz-nightly-20261116T031000Z.backup"]);
    for (const t of ["2026-11-16T03:11:00Z", "2026-11-16T09:00:00Z", "2026-11-16T23:59:00Z", "2026-11-17T03:09:00Z"]) { at(t); await service.tick(); }
    expect(storage.keys().filter((k) => k.includes("nightly"))).toHaveLength(1);
    at("2026-11-17T03:10:30Z");
    await service.tick();
    expect(storage.keys().filter((k) => k.includes("nightly"))).toEqual(["maiz-nightly-20261116T031000Z.backup", "maiz-nightly-20261117T031030Z.backup"]);
  });

  it("follows the owner's clock in summer (03:10 in London is 02:10 UTC)", async () => {
    const { service, storage, ready, at } = setup({}, "2026-07-01T02:09:00Z");
    await ready();
    await service.tick();
    expect(storage.keys()).toEqual([]);
    at("2026-07-01T02:10:00Z");
    await service.tick();
    expect(storage.keys()).toEqual(["maiz-nightly-20260701T021000Z.backup"]);
  });

  it("catches up when the server was off at ten past three", async () => {
    const { service, storage, ready } = setup({}, "2026-11-16T09:30:00Z");
    await ready();
    await service.tick();
    expect(storage.keys()).toEqual(["maiz-nightly-20261116T093000Z.backup"]);
  });

  it("does nothing until backups are set up", async () => {
    const { service, storage, programs, alerts } = setup({}, "2026-11-16T03:10:00Z");
    await service.tick();
    await service.saveStorage(OWNER, STORAGE_FORM);
    await service.tick();
    expect(storage.keys()).toEqual([]);
    expect(programs.runs.filter((r) => !r.args.includes("--version"))).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("tells the owner when the nightly backup fails, tries again each hour up to three times, and alerts once", async () => {
    const { service, storage, programs, alerts, ready, at } = setup({}, "2026-11-16T03:10:00Z");
    await ready();
    programs.plan.dumpFails = { code: 1, stderr: "pg_dump: error: connection to server at \"db\" failed: Connection refused\n" };
    await service.tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ problem: "backup_failed", subject: "Last night's backup did not work" });
    expect(alerts[0]!.text).toMatch(/could not reach the database/);
    expect(alerts[0]!.text).toContain("https://maiz.test/owner-backups.html");
    at("2026-11-16T03:40:00Z");
    await service.tick();
    const dumps = () => programs.runs.filter((r) => r.program === "pg_dump" && !r.args.includes("--version")).length;
    expect(dumps()).toBe(1);
    at("2026-11-16T04:10:00Z");
    await service.tick();
    at("2026-11-16T05:10:00Z");
    await service.tick();
    at("2026-11-16T06:10:00Z");
    await service.tick();
    expect(dumps()).toBe(3);
    expect(alerts).toHaveLength(1);
    // The next night it works again.
    programs.plan.dumpFails = undefined;
    at("2026-11-17T03:10:00Z");
    await service.tick();
    expect(storage.keys()).toEqual(["maiz-nightly-20261117T031000Z.backup"]);
    expect(alerts).toHaveLength(1);
  });

  it("a retry that works ends the night's tries", async () => {
    const { service, storage, programs, ready, at } = setup({}, "2026-11-16T03:10:00Z");
    await ready();
    programs.plan.dumpFails = { code: 1, stderr: "x" };
    await service.tick();
    programs.plan.dumpFails = undefined;
    at("2026-11-16T04:10:00Z");
    await service.tick();
    at("2026-11-16T05:10:00Z");
    await service.tick();
    expect(storage.keys()).toEqual(["maiz-nightly-20261116T041000Z.backup"]);
  });

  it("does not alert twice in a day for the same problem, and does again the day after", async () => {
    const { service, programs, alerts, ready, at } = setup({}, "2026-11-16T03:10:00Z");
    await ready();
    programs.plan.dumpFails = { code: 1, stderr: "x" };
    await service.tick();
    at("2026-11-17T03:09:00Z");
    await service.tick();
    expect(alerts.filter((a) => a.problem === "backup_failed")).toHaveLength(1);
    at("2026-11-17T03:10:00Z");
    await service.tick();
    expect(alerts.filter((a) => a.problem === "backup_failed")).toHaveLength(2);
  });

  it("does not email about a backup the owner started by hand and watched fail", async () => {
    const { programs, alerts, ready, run } = setup({}, "2026-11-16T01:00:00Z");
    await ready();
    programs.plan.dumpFails = { code: 1, stderr: "x" };
    await run("backup");
    expect(alerts).toEqual([]);
  });

  it("alerts when no backup has worked for 36 hours, once a day, and the health check turns false", async () => {
    const { service, programs, alerts, ready, run, at } = setup({}, "2026-11-16T12:00:00Z");
    await ready();
    await run("backup");
    programs.plan.dumpFails = { code: 1, stderr: "x" };
    at("2026-11-17T23:59:00Z");
    await service.tick();
    expect(service.health()).toEqual({ ok: true });
    expect(alerts.filter((a) => a.problem === "stale")).toEqual([]);
    at("2026-11-18T00:01:00Z");
    await service.tick();
    expect(service.health()).toEqual({ ok: false });
    const stale = alerts.filter((a) => a.problem === "stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]!.subject).toBe("No backup for 36 hours");
    expect(stale[0]!.text).toMatch(/16 November/);
    at("2026-11-18T12:00:00Z");
    await service.tick();
    expect(alerts.filter((a) => a.problem === "stale")).toHaveLength(1);
    at("2026-11-19T00:02:00Z");
    await service.tick();
    expect(alerts.filter((a) => a.problem === "stale")).toHaveLength(2);
    expect((await service.view(OWNER)).fresh).toBe(false);
  });

  it("counts the 36 hours from set-up when no backup has ever worked", async () => {
    const { service, programs, alerts, ready, at } = setup({}, "2026-11-16T12:00:00Z");
    programs.plan.dumpFails = { code: 1, stderr: "x" };
    await ready();
    at("2026-11-17T12:00:00Z");
    await service.tick();
    expect(service.health()).toEqual({ ok: true });
    at("2026-11-18T00:01:00Z");
    await service.tick();
    expect(service.health()).toEqual({ ok: false });
    expect(alerts.some((a) => a.problem === "stale" && /has not made a backup/.test(a.text))).toBe(true);
  });

  it("the health check is true before backups are set up, so it cannot fail before set-up", async () => {
    const { service, at } = setup();
    expect(service.health()).toEqual({ ok: true });
    await service.saveStorage(OWNER, STORAGE_FORM);
    at("2026-12-25T12:00:00Z");
    expect(service.health()).toEqual({ ok: true });
  });

  it("runs the first restore test straight after the first backup, then once a week", async () => {
    const { service, programs, ready, at } = setup({}, "2026-11-16T03:10:00Z");
    await ready();
    await service.tick(); // the nightly backup
    expect(programs.restored).toHaveLength(0);
    at("2026-11-16T03:11:00Z");
    await service.tick(); // the first test
    expect(programs.restored).toHaveLength(1);
    for (let d = 17; d <= 22; d++) for (const time of ["03:10", "04:10", "12:00"]) { at(`2026-11-${d}T${time}:00Z`); await service.tick(); }
    expect(programs.restored).toHaveLength(1);
    at("2026-11-23T03:10:00Z");
    await service.tick();
    at("2026-11-23T04:09:00Z");
    await service.tick();
    expect(programs.restored).toHaveLength(1);
    at("2026-11-23T04:10:00Z");
    await service.tick();
    expect(programs.restored).toHaveLength(2);
    expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: true, backupName: "maiz-nightly-20261123T031000Z.backup" });
  });

  it("a test the owner ran by hand counts towards the week", async () => {
    const { service, programs, ready, run, at } = setup({}, "2026-11-16T03:10:00Z");
    await ready();
    await service.tick();
    await service.tick();
    at("2026-11-20T15:00:00Z");
    await run("restore_test");
    expect(programs.restored).toHaveLength(2);
    at("2026-11-23T04:10:00Z");
    await service.tick();
    at("2026-11-26T04:10:00Z");
    await service.tick();
    expect(programs.restored).toHaveLength(2);
    at("2026-11-27T15:00:00Z");
    await service.tick(); // that day's backup first
    await service.tick();
    expect(programs.restored).toHaveLength(3);
  });

  it("tells the owner when the weekly restore test fails, and tries again the next day", async () => {
    const { service, programs, alerts, ready, at } = setup({}, "2026-11-16T03:10:00Z");
    await ready();
    await service.tick();
    programs.plan.restoreFails = { code: 1, stderr: "pg_restore: error: could not execute query\n" };
    at("2026-11-16T03:11:00Z");
    await service.tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ problem: "restore_failed", subject: "A backup could not be restored in a test" });
    at("2026-11-16T12:00:00Z");
    await service.tick();
    expect(alerts).toHaveLength(1);
    programs.plan.restoreFails = undefined;
    at("2026-11-17T04:10:00Z");
    await service.tick(); // that night's backup first
    await service.tick();
    expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: true });
    expect((await service.view(OWNER)).lastFailure).toBeUndefined();
    expect(alerts).toHaveLength(1);
  });

  it("never throws out of the timer, whatever goes wrong", async () => {
    const { service, programs, ready } = setup({ alert: async () => { throw new Error("mail is down"); } }, "2026-11-16T03:10:00Z");
    await ready();
    programs.plan.dumpFails = { code: 1, stderr: "x" };
    await expect(service.tick()).resolves.toBeUndefined();
    programs.plan.dumpFails = undefined;
    programs.plan.missing = true;
    await expect(service.tick()).resolves.toBeUndefined();
    expect((await service.view(OWNER)).lastFailure?.what).toBe("backup");
  });

  it("clears out working folders left by a run that was cut off", async () => {
    const { service } = setup();
    mkdirSync(join(tmp, "maiz-backup-abc123"));
    writeFileSync(join(tmp, "maiz-backup-abc123", "dump"), "plain rows left behind");
    mkdirSync(join(tmp, "something-else"));
    await service.tick();
    expect(existsSync(join(tmp, "maiz-backup-abc123"))).toBe(false);
    expect(existsSync(join(tmp, "something-else"))).toBe(true);
  });
});

describe("backups: after a restart", () => {
  it("remembers the storage details, the recovery key, the last results and which alerts went out", async () => {
    const h = setup({}, "2026-11-16T03:10:00Z");
    await h.ready();
    h.programs.plan.dumpFails = { code: 1, stderr: "x" };
    await h.service.tick();
    expect(h.alerts).toHaveLength(1);
    h.programs.plan.dumpFails = undefined;
    await h.run("backup");
    const before = await h.service.view(OWNER);

    const again = h.make();
    expect(await again.view(OWNER)).toEqual(before);
    h.programs.plan.dumpFails = { code: 1, stderr: "x" };
    h.at("2026-11-16T04:10:00Z");
    await again.tick();
    expect(h.alerts).toHaveLength(1); // the same problem, the same day: not sent again
    h.programs.plan.dumpFails = undefined;
    h.at("2026-11-16T05:10:00Z");
    await again.tick();
    expect(h.storage.keys()).toContain("maiz-nightly-20261116T051000Z.backup");
  });

  it("saves what was made before storage was attached", () => {
    const secrets = new Map<string, string>();
    const { service } = setup();
    const fresh = new BackupService({ isOwner: (u) => u === OWNER, now: () => new Date("2026-11-16T12:00:00Z"), timezone: "Europe/London", pageUrl: "x", alert: async () => undefined });
    fresh.makeRecoveryKey(OWNER);
    fresh.useSink({ connectionSecret: (k: string, v: string) => { secrets.set(k, v); } } as unknown as Sink);
    expect(secrets.has(`${BACKUP_SECRET_PREFIX}keys`)).toBe(true);
    void service;
  });

  it("ignores stored values it cannot read", async () => {
    const { service } = setup();
    service.restoreSecret(`${BACKUP_SECRET_PREFIX}storage`, "{not json");
    service.restoreSecret(`${BACKUP_SECRET_PREFIX}keys`, "[]");
    service.restoreSecret(`${BACKUP_SECRET_PREFIX}state`, "null");
    const v = await service.view(OWNER);
    expect(v.storage).toBeUndefined();
    expect(v.recoveryKey).toBeUndefined();
  });
});
