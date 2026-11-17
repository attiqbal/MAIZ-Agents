import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { PgStore } from "../src/storage/postgres.js";
import { setHostResolver } from "../src/modules/integrations/connectors/util.js";
import { BackupService, connectionEnv, pgAdmin, spawnRunner } from "../src/modules/backup/index.js";
import { STORAGE_FORM, fakeStorage } from "./backup-fakes.js";

// Runs only against a real Postgres with the real pg_dump and pg_restore: `npm run db:backup` starts a throwaway one.
// The storage service is still the in-memory stand-in: no real bucket is ever called from tests.
const ADMIN = process.env.TEST_DATABASE_URL;
const APP = process.env.TEST_DATABASE_APP_URL;
const OWNER_EMAIL = "atif@maiz.test";
const OWNER = userIdFor(OWNER_EMAIL);
const TOKEN_KEY = "ab".repeat(32);
/** Where the Postgres tools live when they are not on the search path (the same place db/with-postgres.sh looks). */
const BIN = process.env.PG_BIN_DIR ?? (existsSync("/usr/lib/postgresql") ? readdirSync("/usr/lib/postgresql").sort((a, b) => Number(a) - Number(b)).map((v) => `/usr/lib/postgresql/${v}/bin`).filter((d) => existsSync(join(d, "pg_dump"))).pop() : undefined);
const withDatabase = (url: string, name: string): string => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };

describe.skipIf(!ADMIN || !APP)("backups against a real Postgres", () => {
  let tmp: string;
  let admin: pg.Client;
  let store: PgStore;
  const storage = fakeStorage();
  const clock = { t: Date.now() };
  let platform: ReturnType<typeof createPlatform>;
  let recoveryKey: string;
  const boot = (databaseUrl: string) => createPlatform({
    sessionSecret: "k", allowDevAuth: true, now: () => new Date(clock.t), http: storage.http, platformOwners: [OWNER_EMAIL],
    backup: { databaseUrl, tmpDir: tmp, binDir: BIN, serverKeys: { TOKEN_KEY } },
  });
  const databases = async () => (await admin.query("SELECT datname FROM pg_database ORDER BY datname")).rows.map((r) => r.datname as string);
  const liveCounts = async () => (await admin.query("SELECT (SELECT count(*) FROM workspaces)::int AS w, (SELECT count(*) FROM state_records)::int AS s, (SELECT count(*) FROM audit_log)::int AS a")).rows[0];
  const run = async (what: "backup" | "restore_test") => { clock.t += 60_000; await (await platform.backup.begin(OWNER, what)).done; };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "maiz-backup-int-"));
    setHostResolver(async () => ["104.18.2.3"]);
    admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    // The server as it really runs: the platform on Postgres, a real client with real rows, backups wired in by createPlatform.
    platform = boot(ADMIN!);
    store = new PgStore({ adminUrl: ADMIN!, appUrl: APP!, tokenKeyHex: TOKEN_KEY });
    await store.migrate();
    await platform.attachStore(store);
    const signup = await createApp(platform)({ method: "POST", path: "/api/signup", query: new URLSearchParams(), headers: {}, rawBody: JSON.stringify({ email: "ann@kestrel.co", businessName: "Kestrel Coffee", sells: "Coffee", size: "2-10", country: "GB" }) } as Req);
    expect(signup.status).toBe(201);
    await platform.backup.saveStorage(OWNER, STORAGE_FORM);
    recoveryKey = platform.backup.makeRecoveryKey(OWNER).recoveryKey;
  });
  afterAll(async () => {
    await store?.close();
    await admin?.end();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("says backups are available, because pg_dump and pg_restore are installed here", async () => {
    expect(await platform.backup.view(OWNER)).toMatchObject({ available: true, configured: true });
  });

  it("makes a real dump, encrypted, holding rows written a moment ago", async () => {
    await run("backup");
    const v = await platform.backup.view(OWNER);
    expect(v.lastFailure).toBeUndefined();
    expect(v.lastBackup!.bytes).toBeGreaterThan(1_000);
    const sealed = storage.objects.get(v.lastBackup!.name)!.body;
    expect(sealed.includes(Buffer.from("Kestrel Coffee"))).toBe(false);
    expect(sealed.subarray(0, 8).toString()).toBe("MAIZBKP1");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("restores it into a throwaway database, counts the client and its records, drops the database and leaves the live one alone", async () => {
    const before = await liveCounts();
    const dbsBefore = await databases();
    await run("restore_test");
    const t = (await platform.backup.view(OWNER)).lastRestoreTest!;
    expect(t).toMatchObject({ ok: true, clients: 1 });
    expect(t.problem).toBeUndefined();
    expect(t.records).toBeGreaterThan(5);
    expect(await databases()).toEqual(dbsBefore);
    expect(await liveCounts()).toEqual(before);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("rehearses a real restore: the script opens the file with the recovery key, pg_restore loads it into an empty database, and the app starts on it", async () => {
    const name = (await platform.backup.view(OWNER)).lastBackup!.name;
    const work = mkdtempSync(join(tmpdir(), "maiz-drill-"));
    const drill = "maiz_drill_test";
    try {
      writeFileSync(join(work, name), storage.objects.get(name)!.body);
      // Step by step as docs/BACKUPS.md tells the technical person.
      const out = execFileSync("npx", ["tsx", "scripts/open-backup.ts", join(work, name), join(work, "maiz.dump")], { env: { ...process.env, MAIZ_RECOVERY_KEY: recoveryKey.toLowerCase().replace(/-/g, " ") }, encoding: "utf8" });
      expect(out).toContain("Opened.");
      expect(readFileSync(join(work, "maiz.dump")).subarray(0, 5).toString()).toBe("PGDMP");
      expect(readFileSync(join(work, "maiz.dump.server-keys.env"), "utf8")).toBe(`TOKEN_KEY=${TOKEN_KEY}\n`);
      expect(statSync(join(work, "maiz.dump")).mode & 0o077).toBe(0);
      expect(statSync(join(work, "maiz.dump.server-keys.env")).mode & 0o077).toBe(0);
      await admin.query(`DROP DATABASE IF EXISTS ${drill} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${drill}`);
      const restored = await spawnRunner(BIN)("pg_restore", ["--clean", "--if-exists", "--no-owner", "--exit-on-error", "--no-password", "--dbname", drill, join(work, "maiz.dump")], { env: connectionEnv(ADMIN!, drill) });
      expect(restored).toEqual({ code: 0, stderr: "" });
      // A new server on the restored database, with the TOKEN_KEY that came out of the backup.
      const again = boot(withDatabase(ADMIN!, drill));
      const restoredStore = new PgStore({ adminUrl: withDatabase(ADMIN!, drill), appUrl: withDatabase(APP!, drill), tokenKeyHex: TOKEN_KEY });
      try {
        expect(await restoredStore.migrate()).toEqual([]);
        await again.attachStore(restoredStore);
        expect(again.identity.allWorkspaces().map((w) => w.name)).toEqual(["Kestrel Coffee"]);
        // The storage details and recovery key came back too (they were encrypted in the database), so backups carry on.
        const v = await again.backup.view(OWNER);
        expect(v).toMatchObject({ configured: true, storage: { bucket: STORAGE_FORM.bucket }, recoveryKey: { olderKeys: 0 } });
        // The client's own role can still write through row-level security on the restored database.
        const client = new pg.Client({ connectionString: withDatabase(APP!, drill) });
        await client.connect();
        try {
          expect((await client.query("SELECT count(*)::int AS n FROM workspaces")).rows[0].n).toBe(0); // nothing without naming a workspace
          await expect(client.query("SELECT 1 FROM platform_records LIMIT 1")).rejects.toThrow(/permission denied/);
        } finally { await client.end(); }
      } finally { await restoredStore.close(); }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${drill} WITH (FORCE)`);
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  it("the script refuses a wrong recovery key and writes nothing", async () => {
    const name = (await platform.backup.view(OWNER)).lastBackup!.name;
    const work = mkdtempSync(join(tmpdir(), "maiz-drill-"));
    try {
      writeFileSync(join(work, name), storage.objects.get(name)!.body);
      const other = new BackupService({ isOwner: () => true, now: () => new Date(), pageUrl: "x", alert: async () => undefined }).makeRecoveryKey(OWNER).recoveryKey;
      expect(() => execFileSync("npx", ["tsx", "scripts/open-backup.ts", join(work, name), join(work, "maiz.dump")], { env: { ...process.env, MAIZ_RECOVERY_KEY: other }, encoding: "utf8", stdio: "pipe" })).toThrow(/different recovery key/);
      expect(readdirSync(work)).toEqual([name]);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }, 30_000);

  it("fails the test, and still drops the throwaway database, when the backup in storage has been changed", async () => {
    const name = (await platform.backup.view(OWNER)).lastBackup!.name;
    const o = storage.objects.get(name)!;
    const original = Buffer.from(o.body);
    o.body[o.body.length - 100] = o.body[o.body.length - 100]! ^ 1;
    await run("restore_test");
    expect((await platform.backup.view(OWNER)).lastRestoreTest).toMatchObject({ ok: false, problem: expect.stringMatching(/damaged or was changed/) });
    expect((await databases()).filter((d) => d.startsWith("maiz_restore_test_"))).toEqual([]);
    o.body = original;
  });

  it("fails the test when the newest backup is missing a client the site already had", async () => {
    // Two clients the live database says it has had for days, where the backup only holds one of them.
    await admin.query("UPDATE workspaces SET created_at = now() - interval '2 days'");
    await admin.query("INSERT INTO workspaces(id, name, created_at) VALUES ('00000000-0000-4000-8000-000000000001', 'Later Ltd', now() - interval '1 day')");
    try {
      await run("restore_test");
      expect((await platform.backup.view(OWNER)).lastRestoreTest).toMatchObject({ ok: false, problem: "The backup has 1 client in it, but the site had 2 when it was made." });
      expect((await databases()).filter((d) => d.startsWith("maiz_restore_test_"))).toEqual([]);
    } finally {
      await admin.query("DELETE FROM workspaces WHERE id = '00000000-0000-4000-8000-000000000001'");
    }
  });

  it("removes a throwaway database left behind by a test that was cut off", async () => {
    await admin.query('CREATE DATABASE "maiz_restore_test_leftover01"');
    await run("restore_test");
    expect((await platform.backup.view(OWNER)).lastRestoreTest).toMatchObject({ ok: true });
    expect((await databases()).filter((d) => d.startsWith("maiz_restore_test_"))).toEqual([]);
  });

  it("reports a database it cannot reach in plain words", async () => {
    const unreachable = new BackupService({
      isOwner: () => true, now: () => new Date(clock.t), http: storage.http, run: spawnRunner(BIN), db: pgAdmin(ADMIN!), databaseUrl: "postgres://postgres@127.0.0.1:1/postgres", tmpDir: tmp,
      timezone: "Europe/London", pageUrl: "x", alert: async () => undefined,
    });
    await unreachable.saveStorage(OWNER, STORAGE_FORM);
    unreachable.makeRecoveryKey(OWNER);
    await (await unreachable.begin(OWNER, "backup")).done;
    expect((await unreachable.view(OWNER)).lastFailure?.reason).toBe("The backup program could not reach the database.");
    expect(readdirSync(tmp)).toEqual([]);
  });
});
