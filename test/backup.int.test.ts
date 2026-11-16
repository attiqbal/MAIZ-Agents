import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type Req } from "../src/server/app.js";
import { createPlatform } from "../src/server/platform.js";
import { PgStore } from "../src/storage/postgres.js";
import { setHostResolver } from "../src/modules/integrations/connectors/util.js";
import { BackupService, pgAdmin, spawnRunner } from "../src/modules/backup/index.js";
import { openSealed, parseRecoveryKey } from "../src/modules/backup/seal.js";
import { STORAGE_FORM, fakeStorage } from "./backup-fakes.js";

// Runs only against a real Postgres with the real pg_dump and pg_restore: `npm run db:backup` starts a throwaway one.
// The storage service is still the in-memory stand-in: no real bucket is ever called from tests.
const ADMIN = process.env.TEST_DATABASE_URL;
const APP = process.env.TEST_DATABASE_APP_URL;
const OWNER = "owner-1";

describe.skipIf(!ADMIN || !APP)("backups against a real Postgres", () => {
  let tmp: string;
  let admin: pg.Client;
  const storage = fakeStorage();
  const clock = { t: Date.now() };
  let service: BackupService;
  let recoveryKey: string;
  const databases = async () => (await admin.query("SELECT datname FROM pg_database ORDER BY datname")).rows.map((r) => r.datname as string);
  const liveCounts = async () => (await admin.query("SELECT (SELECT count(*) FROM workspaces)::int AS w, (SELECT count(*) FROM state_records)::int AS s, (SELECT count(*) FROM audit_log)::int AS a")).rows[0];

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "maiz-backup-int-"));
    setHostResolver(async () => ["104.18.2.3"]);
    admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    // A real client with real rows, written the way the server writes them.
    const platform = createPlatform({ sessionSecret: "k", allowDevAuth: true, now: () => new Date(clock.t - 3_600_000) });
    const store = new PgStore({ adminUrl: ADMIN!, appUrl: APP!, tokenKeyHex: "ab".repeat(32) });
    await store.migrate();
    await platform.attachStore(store);
    const handle = createApp(platform);
    const signup = await handle({ method: "POST", path: "/api/signup", query: new URLSearchParams(), headers: {}, rawBody: JSON.stringify({ email: "ann@kestrel.co", businessName: "Kestrel Coffee", sells: "Coffee", size: "2-10", country: "GB" }) } as Req);
    expect(signup.status).toBe(201);
    await store.close();
    service = new BackupService({
      isOwner: (u) => u === OWNER, now: () => new Date(clock.t), http: storage.http, run: spawnRunner(), db: pgAdmin(ADMIN!), databaseUrl: ADMIN!, tmpDir: tmp,
      timezone: "Europe/London", pageUrl: "https://maiz.test/owner-backups.html", alert: async () => undefined, serverKeys: () => ({ TOKEN_KEY: "ab".repeat(32) }),
    });
    await service.saveStorage(OWNER, STORAGE_FORM);
    recoveryKey = service.makeRecoveryKey(OWNER).recoveryKey;
  });
  afterAll(async () => {
    await admin?.end();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("says backups are available, because pg_dump and pg_restore are installed here", async () => {
    expect(await service.view(OWNER)).toMatchObject({ available: true, configured: true });
  });

  it("makes a real dump, encrypted, that the recovery key opens", async () => {
    await (await service.begin(OWNER, "backup")).done;
    const v = await service.view(OWNER);
    expect(v.lastFailure).toBeUndefined();
    expect(v.lastBackup!.bytes).toBeGreaterThan(1_000);
    const sealed = storage.objects.get(v.lastBackup!.name)!.body;
    expect(sealed.includes(Buffer.from("Kestrel Coffee"))).toBe(false);
    writeFileSync(join(tmp, "sealed"), sealed);
    const header = await openSealed(join(tmp, "sealed"), join(tmp, "plain.dump"), [parseRecoveryKey(recoveryKey)]);
    expect(header.serverKeys).toEqual({ TOKEN_KEY: "ab".repeat(32) });
    expect(readFileSync(join(tmp, "plain.dump")).subarray(0, 5).toString()).toBe("PGDMP");
    rmSync(join(tmp, "sealed"));
    rmSync(join(tmp, "plain.dump"));
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("restores it into a throwaway database, counts the client and its records, drops the database and leaves the live one alone", async () => {
    const before = await liveCounts();
    const dbsBefore = await databases();
    clock.t += 60_000;
    await (await service.begin(OWNER, "restore_test")).done;
    const t = (await service.view(OWNER)).lastRestoreTest!;
    expect(t).toMatchObject({ ok: true, clients: 1 });
    expect(t.problem).toBeUndefined();
    expect(t.records).toBeGreaterThan(5);
    expect(await databases()).toEqual(dbsBefore);
    expect(await liveCounts()).toEqual(before);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("fails the test, and still drops the throwaway database, when the backup in storage has been changed", async () => {
    const name = (await service.view(OWNER)).lastBackup!.name;
    const o = storage.objects.get(name)!;
    const original = Buffer.from(o.body);
    o.body[o.body.length - 100] = o.body[o.body.length - 100]! ^ 1;
    clock.t += 60_000;
    await (await service.begin(OWNER, "restore_test")).done;
    expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: false, problem: expect.stringMatching(/damaged or was changed/) });
    expect((await databases()).filter((d) => d.startsWith("maiz_restore_test_"))).toEqual([]);
    o.body = original;
  });

  it("fails the test when the newest backup is missing a client the site already had", async () => {
    // Two clients the live database says it has had for days, where the backup only holds one of them.
    await admin.query("UPDATE workspaces SET created_at = now() - interval '2 days'");
    await admin.query("INSERT INTO workspaces(id, name, created_at) VALUES ('00000000-0000-4000-8000-000000000001', 'Later Ltd', now() - interval '1 day')");
    try {
      clock.t += 60_000;
      await (await service.begin(OWNER, "restore_test")).done;
      expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: false, problem: "The backup has 1 client in it, but the site had 2 when it was made." });
      expect((await databases()).filter((d) => d.startsWith("maiz_restore_test_"))).toEqual([]);
    } finally {
      await admin.query("DELETE FROM workspaces WHERE id = '00000000-0000-4000-8000-000000000001'");
    }
  });

  it("removes a throwaway database left behind by a test that was cut off", async () => {
    await admin.query('CREATE DATABASE "maiz_restore_test_leftover01"');
    clock.t += 60_000;
    await (await service.begin(OWNER, "restore_test")).done;
    expect((await service.view(OWNER)).lastRestoreTest).toMatchObject({ ok: true });
    expect((await databases()).filter((d) => d.startsWith("maiz_restore_test_"))).toEqual([]);
  });

  it("reports a database it cannot reach in plain words", async () => {
    const unreachable = new BackupService({
      isOwner: () => true, now: () => new Date(clock.t), http: storage.http, run: spawnRunner(), db: pgAdmin(ADMIN!), databaseUrl: "postgres://postgres@127.0.0.1:1/postgres", tmpDir: tmp,
      timezone: "Europe/London", pageUrl: "x", alert: async () => undefined,
    });
    await unreachable.saveStorage(OWNER, STORAGE_FORM);
    unreachable.makeRecoveryKey(OWNER);
    await (await unreachable.begin(OWNER, "backup")).done;
    expect((await unreachable.view(OWNER)).lastFailure?.reason).toBe("The backup program could not reach the database.");
    expect(readdirSync(tmp)).toEqual([]);
  });
});
