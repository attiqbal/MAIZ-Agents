import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { MemoryEmailSender } from "../src/server/email.js";
import { limitFor } from "../src/server/rate-limit.js";
import { setHostResolver } from "../src/modules/integrations/connectors/util.js";
import type { Sink } from "../src/core/persistence.js";
import { STORAGE, STORAGE_FORM, fakeDb, fakePrograms, fakeStorage } from "./backup-fakes.js";

const OWNER = "atif@maiz.test";
let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "maiz-backup-routes-")); setHostResolver(async () => ["104.18.2.3"]); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function setup(startAt = "2026-11-16T12:00:00Z", backup: "on" | "no-database" = "on") {
  const clock = { d: new Date(startAt) };
  const mail = new MemoryEmailSender();
  const storage = fakeStorage();
  storage.state.clock = () => clock.d;
  const programs = fakePrograms();
  const database = fakeDb();
  const platform = createPlatform({
    sessionSecret: "s3", allowDevAuth: true, email: mail, appUrl: "https://app.test", platformOwners: [OWNER], now: () => clock.d, http: storage.http,
    ...(backup === "on" ? { backup: { databaseUrl: "postgres://postgres:pw@db:5432/postgres", run: programs.run, db: database.db, tmpDir: tmp, serverKeys: { TOKEN_KEY: "cd".repeat(32) } } } : {}),
  });
  const handle = createApp(platform);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle({ method, path, query: new URLSearchParams(), headers, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const owner = () => ({ authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(OWNER), e: OWNER }, 7 * 86400, clock.d.getTime())}` });
  const signUp = async (email: string) => {
    const r = await call("POST", "/api/signup", { email, businessName: "Kestrel Coffee", sells: "Coffee", size: "2–10", country: "GB" });
    return { authorization: `Bearer ${(r.body as any).token}` };
  };
  const ready = async () => {
    expect((await call("PUT", "/api/owner/backups/storage", STORAGE_FORM, owner())).status).toBe(200);
    const k = await call("POST", "/api/owner/backups/recovery-key", {}, owner());
    expect(k.status).toBe(201);
    return (k.body as any).recoveryKey as string;
  };
  return { platform, call, clock, mail, owner, signUp, storage, programs, database, ready };
}

describe("backup routes: who may use them", () => {
  it("needs a login, and only the platform owner gets in", async () => {
    const s = setup();
    const client = await s.signUp("ann@kestrel.co");
    for (const [method, path] of [["GET", "/api/owner/backups"], ["PUT", "/api/owner/backups/storage"], ["POST", "/api/owner/backups/storage/remove"], ["POST", "/api/owner/backups/recovery-key"], ["POST", "/api/owner/backups/recovery-key/saved"], ["POST", "/api/owner/backups/run"], ["POST", "/api/owner/backups/restore-test"]] as const) {
      expect((await s.call(method, path, {})).status, `${method} ${path} with no login`).toBe(401);
      expect((await s.call(method, path, {}, client)).status, `${method} ${path} as a client`).toBe(403);
    }
    expect(s.storage.calls).toEqual([]);
    expect(s.programs.runs).toEqual([]);
  });

  it("answers 404 for an address that does not exist", async () => {
    const s = setup();
    expect((await s.call("GET", "/api/owner/backups/nope", undefined, s.owner())).status).toBe(404);
    expect((await s.call("DELETE", "/api/owner/backups", undefined, s.owner())).status).toBe(404);
  });
});

describe("backup routes: the owner's page", () => {
  it("starts empty and available", async () => {
    const s = setup();
    const r = await s.call("GET", "/api/owner/backups", undefined, s.owner());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ available: true, configured: false, running: null, fresh: true, nightlyTime: "03:10", persistent: false });
  });

  it("says backups are not available where there is no database", async () => {
    const s = setup(undefined, "no-database");
    const r = await s.call("GET", "/api/owner/backups", undefined, s.owner());
    expect(r.body).toMatchObject({ available: false, unavailable: expect.stringMatching(/not available on this server/) });
    expect((await s.call("POST", "/api/owner/backups/run", {}, s.owner())).status).toBe(400);
  });

  it("saves storage details, and answers a mistake with plain words", async () => {
    const s = setup();
    const bad = await s.call("PUT", "/api/owner/backups/storage", { ...STORAGE_FORM, address: "http://insecure.example.com" }, s.owner());
    expect(bad.status).toBe(400);
    expect((bad.body as any).error).toMatch(/https/);
    const refused = await s.call("PUT", "/api/owner/backups/storage", { ...STORAGE_FORM, secret: "wrong" }, s.owner());
    expect(refused.status).toBe(400);
    expect((refused.body as any).error).toMatch(/refused the key/);
    const ok = await s.call("PUT", "/api/owner/backups/storage", STORAGE_FORM, s.owner());
    expect(ok.status).toBe(200);
    expect((ok.body as any).storage).toMatchObject({ bucket: STORAGE.bucket, keyId: STORAGE.keyId, keep: 30 });
    expect(JSON.stringify(ok.body)).not.toContain(STORAGE.secret);
  });

  it("hands the recovery key over once, and never again", async () => {
    const s = setup();
    const key = await s.ready();
    expect(key).toMatch(/^([0-9A-Z]{5}-){10}[0-9A-Z]{5}$/);
    const page = await s.call("GET", "/api/owner/backups", undefined, s.owner());
    expect(JSON.stringify(page.body)).not.toContain(key);
    expect((page.body as any).recoveryKey).toMatchObject({ saved: false });
    const again = await s.call("POST", "/api/owner/backups/recovery-key", {}, s.owner());
    expect(again.status).toBe(400);
    const saved = await s.call("POST", "/api/owner/backups/recovery-key/saved", {}, s.owner());
    expect((saved.body as any).recoveryKey).toMatchObject({ saved: true });
    const replaced = await s.call("POST", "/api/owner/backups/recovery-key", { replace: true }, s.owner());
    expect(replaced.status).toBe(201);
    expect((replaced.body as any).recoveryKey).not.toBe(key);
    expect((replaced.body as any).view.recoveryKey).toMatchObject({ saved: false, olderKeys: 1 });
  });

  it("starts a backup, answers at once, and finishes it after the reply", async () => {
    const s = setup();
    await s.ready();
    const r = await s.call("POST", "/api/owner/backups/run", {}, s.owner());
    expect(r.status).toBe(202);
    expect((r.body as any).running).toBe("backup");
    expect(typeof r.after).toBe("function");
    const busy = await s.call("POST", "/api/owner/backups/restore-test", {}, s.owner());
    expect(busy.status).toBe(409);
    await r.after!();
    const page = (await s.call("GET", "/api/owner/backups", undefined, s.owner())).body as any;
    expect(page.running).toBeNull();
    expect(page.lastBackup).toMatchObject({ name: "maiz-manual-20261116T120000Z.backup", kind: "manual" });
    expect(s.storage.keys()).toEqual(["maiz-manual-20261116T120000Z.backup"]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("starts a restore test and reports what was in the backup", async () => {
    const s = setup();
    await s.ready();
    await (await s.call("POST", "/api/owner/backups/run", {}, s.owner())).after!();
    const r = await s.call("POST", "/api/owner/backups/restore-test", {}, s.owner());
    expect(r.status).toBe(202);
    await r.after!();
    const page = (await s.call("GET", "/api/owner/backups", undefined, s.owner())).body as any;
    expect(page.lastRestoreTest).toMatchObject({ ok: true, clients: 3, records: 240, backupAt: "2026-11-16T12:00:00.000Z" });
    expect(s.database.databases.size).toBe(0);
  });

  it("turns backups off when the owner removes the storage details", async () => {
    const s = setup();
    await s.ready();
    const r = await s.call("POST", "/api/owner/backups/storage/remove", {}, s.owner());
    expect(r.body).toMatchObject({ configured: false });
    expect((r.body as any).storage).toBeUndefined();
  });
});

describe("backup routes: the public freshness check", () => {
  it("is open to anyone, says only ok, and is true before backups are set up", async () => {
    const s = setup();
    const r = await s.call("GET", "/api/health/backups");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it("turns false, with a 503, when backups are set up and the newest is older than 36 hours", async () => {
    const s = setup();
    await s.ready();
    await (await s.call("POST", "/api/owner/backups/run", {}, s.owner())).after!();
    s.clock.d = new Date("2026-11-17T23:59:00Z");
    expect((await s.call("GET", "/api/health/backups")).body).toEqual({ ok: true });
    s.clock.d = new Date("2026-11-18T00:01:00Z");
    const stale = await s.call("GET", "/api/health/backups");
    expect(stale.status).toBe(503);
    expect(stale.body).toEqual({ ok: false });
    // The ordinary health check is a separate question and stays true.
    expect((await s.call("GET", "/api/health")).body).toEqual({ ok: true });
  });
});

describe("backups in the running platform", () => {
  it("emails the platform owner when the nightly backup fails, once", async () => {
    const s = setup("2026-11-16T03:10:00Z");
    await s.ready();
    s.programs.plan.dumpFails = { code: 1, stderr: "pg_dump: error: connection to server at \"db\" failed: Connection refused\n" };
    await s.platform.backup.tick();
    const alerts = s.mail.sent.filter((m) => m.subject.includes("backup"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.to).toBe(OWNER);
    expect(alerts[0]!.subject).toContain("Last night's backup did not work");
    expect(alerts[0]!.text).toContain("could not reach the database");
    expect(alerts[0]!.text).toContain("https://app.test/owner-backups.html");
    s.clock.d = new Date("2026-11-16T04:10:00Z");
    await s.platform.backup.tick();
    expect(s.mail.sent.filter((m) => m.subject.includes("backup"))).toHaveLength(1);
  });

  it("keeps its details through a restart, stored with the owner's other encrypted secrets and nowhere else", async () => {
    const s = setup();
    const written = new Map<string, string>();
    const kinds: string[] = [];
    const noop = () => undefined;
    const sink = new Proxy({}, { get: (_t, name: string) => (name === "connectionSecret" ? (k: string, v: string) => { kinds.push(k); if (v) written.set(k, v); else written.delete(k); } : name === "flush" ? async () => undefined : name === "load" ? async () => ({ workspaces: [], memberships: [], employees: [], profiles: [], training: [], accounts: [], entries: [], usage: [], plans: [], audit: [], connections: [], links: [], adminOrgs: [], adminMessages: [], slackTokens: [] }) : noop) }) as unknown as Sink & { flush(): Promise<void>; load(): Promise<any> };
    await s.platform.attachStore(sink);
    await s.ready();
    await (await s.call("POST", "/api/owner/backups/run", {}, s.owner())).after!();
    expect([...written.keys()].filter((k) => k.startsWith("backup:")).sort()).toEqual(["backup:keys", "backup:state", "backup:storage"]);

    const again = setup();
    const reload = new Proxy({}, { get: (_t, name: string) => (name === "load" ? async () => ({ workspaces: [], memberships: [], employees: [], profiles: [], training: [], accounts: [], entries: [], usage: [], plans: [], audit: [], connections: [], links: [], adminOrgs: [], adminMessages: [], slackTokens: [], connectionSecrets: [...written].map(([key, secret]) => ({ key, secret })) }) : name === "flush" ? async () => undefined : noop) }) as unknown as Sink & { flush(): Promise<void>; load(): Promise<any> };
    await again.platform.attachStore(reload);
    const page = (await again.call("GET", "/api/owner/backups", undefined, again.owner())).body as any;
    expect(page).toMatchObject({ configured: true, persistent: true, lastBackup: { name: "maiz-manual-20261116T120000Z.backup" } });
    // The owner's Connections page is not confused by the backup entries.
    expect((await again.call("GET", "/api/owner/connections", undefined, again.owner())).status).toBe(200);
  });
});

describe("backup routes: rate limits", () => {
  it("limits every backup address", () => {
    expect(limitFor("GET", "/api/health/backups")).toEqual({ max: 30, windowMs: 60_000 });
    expect(limitFor("GET", "/api/owner/backups")).toEqual({ max: 120, windowMs: 60_000 });
    expect(limitFor("PUT", "/api/owner/backups/storage")).toEqual({ max: 20, windowMs: 10 * 60_000 });
    expect(limitFor("POST", "/api/owner/backups/run")).toEqual({ max: 10, windowMs: 10 * 60_000 });
    expect(limitFor("POST", "/api/owner/backups/restore-test")).toEqual({ max: 10, windowMs: 10 * 60_000 });
    expect(limitFor("POST", "/api/owner/backups/recovery-key")).toEqual({ max: 10, windowMs: 10 * 60_000 });
    expect(limitFor("POST", "/api/owner/backups/recovery-key/saved")).toEqual({ max: 60, windowMs: 60_000 });
    expect(limitFor("GET", "/api/health")).toBeUndefined();
    expect(limitFor("GET", "/api/org")).toBeUndefined();
  });
});
